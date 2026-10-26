import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { InventoryRepository } from "./collection.repository.js";

/** Item amounts by item id (card seeds, upgrade XP, materials). */
export type ItemAmounts = Record<string, number>;

export type ItemLedgerReason = "STAGE_REWARD" | "STARTING_ITEMS" | "CARD_UNLOCK" | "CARD_UPGRADE" | "SHOP_PURCHASE" | "OBJECTIVE_REWARD"
  | "DAILY_REWARD" | "MAIL_ATTACHMENT" | "IAP_PURCHASE" | "WHEEL_SPIN" | "FRIEND_GIFT"
  | "ARENA_REWARD" | "ARENA_TICKET" | "TOWER_REWARD" | "CLAN_CREATE" | "CLAN_DONATION" | "IAP_REFUND" | "ADMIN";

/** Ceiling of an item balance (keeps every amount a safe integer). */
const MAX_ITEMS = 999_999_999_999;

/**
 * The only writer of item balances (the item counterpart of WalletLedger): every change runs inside the caller's
 * transaction, locks the touched rows and appends a ledger entry, so a spend and a grant are atomic and auditable.
 */
export class InventoryLedger {
  constructor(private readonly items: InventoryRepository, private readonly knownItem: (itemId: string) => boolean) {}

  /** Every held item (only positive balances). */
  async snapshot(userId: string, session?: DbSession): Promise<ItemAmounts> {
    const result: ItemAmounts = {};
    for (const [itemId, amount] of await this.items.listItems(userId, session)) if (amount > 0) result[itemId] = amount;
    return result;
  }

  async credit(session: DbSession, userId: string, amounts: ItemAmounts, reason: ItemLedgerReason): Promise<void> {
    const changes = this.normalize(amounts);
    if (changes.size === 0) return;
    const balances = await this.items.lockItems(userId, [...changes.keys()], session);
    const entries = [];
    for (const [itemId, amount] of changes) {
      const before = balances.get(itemId) ?? 0;
      const after = Math.min(MAX_ITEMS, before + amount);
      if (after === before) continue;
      await this.items.saveItem(userId, itemId, after, session);
      entries.push({ userId, itemId, delta: after - before, balanceAfter: after, reason });
    }
    await this.items.appendLedger(entries, session);
  }

  /** All or nothing: a balance too low throws ITEM_INSUFFICIENT (`extra: { itemId, need, have }`) before any write. */
  async debit(session: DbSession, userId: string, amounts: ItemAmounts, reason: ItemLedgerReason): Promise<void> {
    const changes = this.normalize(amounts);
    if (changes.size === 0) return;
    const balances = await this.items.lockItems(userId, [...changes.keys()], session);
    for (const [itemId, amount] of changes) {
      const have = balances.get(itemId) ?? 0;
      if (have < amount) throw new AppError(ErrorCode.ITEM_INSUFFICIENT, { extra: { itemId, need: amount, have } });
    }
    const entries = [];
    for (const [itemId, amount] of changes) {
      const after = (balances.get(itemId) ?? 0) - amount;
      await this.items.saveItem(userId, itemId, after, session);
      entries.push({ userId, itemId, delta: -amount, balanceAfter: after, reason });
    }
    await this.items.appendLedger(entries, session);
  }

  private normalize(amounts: ItemAmounts): Map<string, number> {
    const result = new Map<string, number>();
    for (const [itemId, amount] of Object.entries(amounts)) {
      if (!this.knownItem(itemId)) throw new Error(`Unknown item "${itemId}".`);
      if (!amount) continue;
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid ${itemId} amount ${amount}.`);
      result.set(itemId, (result.get(itemId) ?? 0) + amount);
    }
    return result;
  }
}
