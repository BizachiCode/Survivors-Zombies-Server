// In-memory verified purchases (same unique key as the iap_purchases table).

import type { IapPurchaseRow, IapRepository, RefundShortfall } from "../../src/modules/iap/iap.repository.js";
import type { RewardBundle } from "../../src/modules/economy/reward-granter.js";
import type { IapStore } from "../../src/modules/iap/validators/receipt.js";

export class MemoryIapRepository implements IapRepository {
  readonly rows: IapPurchaseRow[] = [];

  async insert(row: IapPurchaseRow): Promise<boolean> {
    if (this.rows.some((r) => r.store === row.store && r.transactionKey === row.transactionKey)) return false;
    this.rows.push({ ...row });
    return true;
  }

  async find(store: IapStore, transactionKey: string): Promise<IapPurchaseRow | null> {
    const row = this.rows.find((r) => r.store === store && r.transactionKey === transactionKey);
    return row ? { ...row } : null;
  }

  async listByUser(userId: string, limit: number): Promise<IapPurchaseRow[]> {
    return this.rows.filter((r) => r.userId === userId).sort((a, b) => b.purchasedAt.getTime() - a.purchasedAt.getTime()).slice(0, limit).map((r) => ({ ...r }));
  }

  async markRefunded(id: string, at: Date, reason: string, shortfall: RefundShortfall): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, { status: "refunded", refundedAt: at, refundReason: reason, refundShortfall: shortfall });
  }

  async counts(userId: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const row of this.rows) if (row.userId === userId) result.set(row.productId, (result.get(row.productId) ?? 0) + 1);
    return result;
  }

  async setGranted(id: string, granted: RewardBundle): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.granted = granted;
  }
}
