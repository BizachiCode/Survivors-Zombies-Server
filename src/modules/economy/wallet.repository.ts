import { and, eq, inArray } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { currencyLedger, userCurrencies } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type LedgerEntry = {
  userId: string;
  currencyId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
};

/** Persistence port for wallet balances and the currency ledger. */
export interface WalletRepository {
  /** Every stored balance of the user (currencies without a row are absent). */
  listBalances(userId: string, session?: DbSession): Promise<Map<string, number>>;
  /** Locks the user's rows of `currencyIds` and returns their balances (missing rows are absent). */
  lockBalances(userId: string, currencyIds: readonly string[], session: DbSession): Promise<Map<string, number>>;
  /** Inserts or overwrites one balance. */
  saveBalance(userId: string, currencyId: string, amount: number, session: DbSession): Promise<void>;
  appendLedger(entries: readonly LedgerEntry[], session: DbSession): Promise<void>;
}

export class DrizzleWalletRepository extends DrizzleRepository implements WalletRepository {
  async listBalances(userId: string, session?: DbSession): Promise<Map<string, number>> {
    const rows = await this.db(session)
      .select({ currencyId: userCurrencies.currencyId, amount: userCurrencies.amount })
      .from(userCurrencies)
      .where(eq(userCurrencies.userId, userId));
    return new Map(rows.map((row) => [row.currencyId, Number(row.amount)]));
  }

  async lockBalances(userId: string, currencyIds: readonly string[], session: DbSession): Promise<Map<string, number>> {
    if (currencyIds.length === 0) return new Map();
    const rows = await this.db(session)
      .select({ currencyId: userCurrencies.currencyId, amount: userCurrencies.amount })
      .from(userCurrencies)
      .where(and(eq(userCurrencies.userId, userId), inArray(userCurrencies.currencyId, [...currencyIds])))
      .for("update");
    return new Map(rows.map((row) => [row.currencyId, Number(row.amount)]));
  }

  async saveBalance(userId: string, currencyId: string, amount: number, session: DbSession): Promise<void> {
    await this.db(session)
      .insert(userCurrencies)
      .values({ userId, currencyId, amount })
      .onDuplicateKeyUpdate({ set: { amount } });
  }

  async appendLedger(entries: readonly LedgerEntry[], session: DbSession): Promise<void> {
    if (entries.length === 0) return;
    await this.db(session).insert(currencyLedger).values([...entries]);
  }
}
