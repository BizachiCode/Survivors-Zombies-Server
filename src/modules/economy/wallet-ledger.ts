import { CURRENCY_IDS, isCurrencyId, MAX_BALANCE, type CurrencyId } from "../../config/game-config.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { WalletRepository } from "./wallet.repository.js";

/** Balances of every currency (`{ coins, gems }`), as sent to the client. */
export type WalletDto = Record<CurrencyId, number>;

/** Amounts per currency for a grant or a cost. */
export type CurrencyAmounts = Partial<Record<CurrencyId, number>>;

/** Ledger reasons (`currency_ledger.reason`). Add one per feature that grants or spends. */
export type LedgerReason = "STARTING_BALANCE" | "STAGE_REWARD" | "SHOP_PURCHASE" | "CARD_UNLOCK" | "CARD_UPGRADE" | "OBJECTIVE_REWARD"
  | "DAILY_REWARD" | "MAIL_ATTACHMENT" | "IAP_PURCHASE" | "WHEEL_SPIN" | "FRIEND_GIFT"
  | "ARENA_REWARD" | "ARENA_TICKET" | "TOWER_REWARD" | "CLAN_CREATE" | "CLAN_DONATION" | "IAP_REFUND" | "ADMIN";

/**
 * The only writer of wallet balances. Every mutation runs inside the caller's transaction, locks the touched rows and
 * appends a ledger entry per currency, so a feature's spend + grant is atomic and auditable.
 */
export class WalletLedger {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly startingBalances: CurrencyAmounts = {},
  ) {}

  /** Current balances (0 for currencies without a row). */
  async snapshot(userId: string, session?: DbSession): Promise<WalletDto> {
    return toWalletDto(await this.wallets.listBalances(userId, session));
  }

  /** Creates the wallet of a new account with the configured starting balances (a row per currency). */
  async open(session: DbSession, userId: string): Promise<WalletDto> {
    const entries = [];
    for (const currencyId of CURRENCY_IDS) {
      const amount = Math.min(MAX_BALANCE, positiveOrZero(this.startingBalances[currencyId]));
      await this.wallets.saveBalance(userId, currencyId, amount, session);
      if (amount > 0) entries.push({ userId, currencyId, delta: amount, balanceAfter: amount, reason: "STARTING_BALANCE" });
    }
    await this.wallets.appendLedger(entries, session);
    return this.snapshot(userId, session);
  }

  /** Adds `amounts` (clamped to MAX_BALANCE). Returns the whole wallet after the change. */
  async credit(session: DbSession, userId: string, amounts: CurrencyAmounts, reason: LedgerReason): Promise<WalletDto> {
    const changes = normalize(amounts);
    const balances = await this.wallets.lockBalances(userId, [...changes.keys()], session);
    const entries = [];
    for (const [currencyId, amount] of changes) {
      const before = balances.get(currencyId) ?? 0;
      const after = Math.min(MAX_BALANCE, before + amount);
      if (after === before) continue;
      await this.wallets.saveBalance(userId, currencyId, after, session);
      entries.push({ userId, currencyId, delta: after - before, balanceAfter: after, reason });
    }
    await this.wallets.appendLedger(entries, session);
    return this.snapshot(userId, session);
  }

  /**
   * Removes `amounts`, all or nothing: any balance that is too low throws WALLET_INSUFFICIENT_FUNDS
   * (`extra: { currencyId, need, have }`) before anything is written. Returns the whole wallet after the change.
   */
  async debit(session: DbSession, userId: string, amounts: CurrencyAmounts, reason: LedgerReason): Promise<WalletDto> {
    const changes = normalize(amounts);
    const balances = await this.wallets.lockBalances(userId, [...changes.keys()], session);
    for (const [currencyId, amount] of changes) {
      const have = balances.get(currencyId) ?? 0;
      if (have < amount) throw new AppError(ErrorCode.WALLET_INSUFFICIENT_FUNDS, { extra: { currencyId, need: amount, have } });
    }
    const entries = [];
    for (const [currencyId, amount] of changes) {
      const after = (balances.get(currencyId) ?? 0) - amount;
      await this.wallets.saveBalance(userId, currencyId, after, session);
      entries.push({ userId, currencyId, delta: -amount, balanceAfter: after, reason });
    }
    await this.wallets.appendLedger(entries, session);
    return this.snapshot(userId, session);
  }
}

export function toWalletDto(balances: ReadonlyMap<string, number>): WalletDto {
  const wallet = {} as WalletDto;
  for (const currencyId of CURRENCY_IDS) wallet[currencyId] = balances.get(currencyId) ?? 0;
  return wallet;
}

/** Positive integer amounts per known currency; anything else is a programming error, not a player mistake. */
function normalize(amounts: CurrencyAmounts): Map<CurrencyId, number> {
  const result = new Map<CurrencyId, number>();
  for (const [currencyId, amount] of Object.entries(amounts)) {
    if (!isCurrencyId(currencyId)) throw new Error(`Unknown currency "${currencyId}".`);
    if (amount === undefined || amount === 0) continue;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid ${currencyId} amount ${amount}.`);
    result.set(currencyId, amount);
  }
  return result;
}

function positiveOrZero(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 0;
}
