// Takes currencies and items away "as far as the player still has them": refunds and admin removals must never push a
// balance below zero, and must not fail because the player already spent part of it. Built on the ledgers' all-or-nothing
// `debit`: when one is refused, the balance it reports (read under row lock) becomes the new amount and the debit is
// retried, so the answer is exact even while the player is spending concurrently. Runs in the caller's transaction.

import { isCurrencyId, type CurrencyId } from "../../config/game-config.js";
import { AppError, isAppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { InventoryLedger, ItemLedgerReason } from "../collection/inventory-ledger.js";
import type { LedgerReason, WalletLedger } from "./wallet-ledger.js";

export type Holdings = { currencies: Record<string, number>; items: Record<string, number> };

export type DebitUpToResult = {
  /** What was taken. */
  taken: Holdings;
  /** What was asked but could not be taken (balance too low, or a currency/item the server no longer knows). */
  shortfall: Holdings;
};

export type DebitUpToDeps = {
  wallets: WalletLedger;
  inventory: InventoryLedger;
  knownItem: (itemId: string) => boolean;
};

export async function debitUpTo(
  deps: DebitUpToDeps,
  session: DbSession,
  userId: string,
  wanted: Partial<Holdings>,
  reason: LedgerReason & ItemLedgerReason,
): Promise<DebitUpToResult> {
  const result: DebitUpToResult = { taken: { currencies: {}, items: {} }, shortfall: { currencies: {}, items: {} } };

  const currencies: Record<string, number> = {};
  for (const [id, amount] of Object.entries(wanted.currencies ?? {})) {
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    if (isCurrencyId(id)) currencies[id] = amount;
    else result.shortfall.currencies[id] = amount;
  }
  const items: Record<string, number> = {};
  for (const [id, amount] of Object.entries(wanted.items ?? {})) {
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    if (deps.knownItem(id)) items[id] = amount;
    else result.shortfall.items[id] = amount;
  }

  const requested = { currencies: { ...currencies }, items: { ...items } };
  await settle(currencies, ErrorCode.WALLET_INSUFFICIENT_FUNDS, "currencyId", (amounts) => deps.wallets.debit(session, userId, amounts as Partial<Record<CurrencyId, number>>, reason));
  await settle(items, ErrorCode.ITEM_INSUFFICIENT, "itemId", (amounts) => deps.inventory.debit(session, userId, amounts, reason));

  for (const [id, asked] of Object.entries(requested.currencies)) {
    const took = currencies[id] ?? 0;
    if (took > 0) result.taken.currencies[id] = took;
    if (asked - took > 0) result.shortfall.currencies[id] = asked - took;
  }
  for (const [id, asked] of Object.entries(requested.items)) {
    const took = items[id] ?? 0;
    if (took > 0) result.taken.items[id] = took;
    if (asked - took > 0) result.shortfall.items[id] = asked - took;
  }
  return result;
}

/** Lowers `amounts` in place to what the ledger accepts, then debits it. Each refusal writes nothing. */
async function settle(
  amounts: Record<string, number>,
  insufficient: string,
  idField: "currencyId" | "itemId",
  debit: (amounts: Record<string, number>) => Promise<unknown>,
): Promise<void> {
  for (let attempt = Object.keys(amounts).length + 1; attempt > 0 && Object.keys(amounts).length > 0; attempt--) {
    try {
      await debit(amounts);
      return;
    } catch (error) {
      if (!isAppError(error) || error.errorCode !== insufficient) throw error;
      const id = String(error.extra?.[idField] ?? "");
      const have = Number(error.extra?.have ?? 0);
      if (!(id in amounts)) throw error;
      if (have > 0) amounts[id] = Math.min(amounts[id], have);
      else delete amounts[id];
    }
  }
  if (Object.keys(amounts).length > 0) throw new AppError(insufficient);
}

export function isEmptyHoldings(holdings: Holdings): boolean {
  return Object.keys(holdings.currencies).length === 0 && Object.keys(holdings.items).length === 0;
}
