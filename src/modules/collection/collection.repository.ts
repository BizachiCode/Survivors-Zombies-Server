import { and, eq, inArray } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { itemLedger, userCards, userDecks, userItems } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type CardSource = "starter" | "seeds" | "stage" | "purchase" | "level" | "admin";

export type OwnedCardRow = { userId: string; cardId: string; level: number; source: CardSource };

export type ItemLedgerEntry = { userId: string; itemId: string; delta: number; balanceAfter: number; reason: string };

/** Persistence port of owned cards and the team. */
export interface CollectionRepository {
  listCards(userId: string, session?: DbSession): Promise<OwnedCardRow[]>;
  /** `forUpdate` (inside a transaction) locks the row. */
  getCard(userId: string, cardId: string, session: DbSession, forUpdate?: boolean): Promise<OwnedCardRow | null>;
  /** Inserts a card; an existing one throws a duplicate-key error. */
  insertCard(row: OwnedCardRow, session: DbSession): Promise<void>;
  updateLevel(userId: string, cardId: string, level: number, session: DbSession): Promise<void>;
  getDeck(userId: string, session?: DbSession): Promise<string[] | null>;
  saveDeck(userId: string, cards: readonly string[], session: DbSession): Promise<void>;
}

/** Persistence port of item balances and their ledger (used by InventoryLedger only). */
export interface InventoryRepository {
  listItems(userId: string, session?: DbSession): Promise<Map<string, number>>;
  lockItems(userId: string, itemIds: readonly string[], session: DbSession): Promise<Map<string, number>>;
  saveItem(userId: string, itemId: string, amount: number, session: DbSession): Promise<void>;
  appendLedger(entries: readonly ItemLedgerEntry[], session: DbSession): Promise<void>;
}

const cardColumns = { userId: userCards.userId, cardId: userCards.cardId, level: userCards.level, source: userCards.source };

export class DrizzleCollectionRepository extends DrizzleRepository implements CollectionRepository {
  async listCards(userId: string, session?: DbSession): Promise<OwnedCardRow[]> {
    const rows = await this.db(session).select(cardColumns).from(userCards).where(eq(userCards.userId, userId));
    return rows.map((row) => ({ ...row, source: row.source as CardSource }));
  }

  async getCard(userId: string, cardId: string, session: DbSession, forUpdate = false): Promise<OwnedCardRow | null> {
    const query = this.db(session).select(cardColumns).from(userCards)
      .where(and(eq(userCards.userId, userId), eq(userCards.cardId, cardId))).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ? { ...rows[0], source: rows[0].source as CardSource } : null;
  }

  async insertCard(row: OwnedCardRow, session: DbSession): Promise<void> {
    await this.db(session).insert(userCards).values(row);
  }

  async updateLevel(userId: string, cardId: string, level: number, session: DbSession): Promise<void> {
    await this.db(session).update(userCards).set({ level }).where(and(eq(userCards.userId, userId), eq(userCards.cardId, cardId)));
  }

  async getDeck(userId: string, session?: DbSession): Promise<string[] | null> {
    const rows = await this.db(session).select({ cards: userDecks.cards }).from(userDecks).where(eq(userDecks.userId, userId)).limit(1);
    if (!rows[0]) return null;
    // MariaDB keeps JSON columns as LONGTEXT, so the driver may hand back the raw text.
    const cards = typeof rows[0].cards === "string" ? JSON.parse(rows[0].cards) : rows[0].cards;
    return Array.isArray(cards) ? cards.filter((id): id is string => typeof id === "string") : [];
  }

  async saveDeck(userId: string, cards: readonly string[], session: DbSession): Promise<void> {
    await this.db(session).insert(userDecks).values({ userId, cards: [...cards] }).onDuplicateKeyUpdate({ set: { cards: [...cards] } });
  }
}

export class DrizzleInventoryRepository extends DrizzleRepository implements InventoryRepository {
  async listItems(userId: string, session?: DbSession): Promise<Map<string, number>> {
    const rows = await this.db(session).select({ itemId: userItems.itemId, amount: userItems.amount }).from(userItems).where(eq(userItems.userId, userId));
    return new Map(rows.map((row) => [row.itemId, Number(row.amount)]));
  }

  async lockItems(userId: string, itemIds: readonly string[], session: DbSession): Promise<Map<string, number>> {
    if (itemIds.length === 0) return new Map();
    const rows = await this.db(session).select({ itemId: userItems.itemId, amount: userItems.amount }).from(userItems)
      .where(and(eq(userItems.userId, userId), inArray(userItems.itemId, [...itemIds]))).for("update");
    return new Map(rows.map((row) => [row.itemId, Number(row.amount)]));
  }

  async saveItem(userId: string, itemId: string, amount: number, session: DbSession): Promise<void> {
    await this.db(session).insert(userItems).values({ userId, itemId, amount }).onDuplicateKeyUpdate({ set: { amount } });
  }

  async appendLedger(entries: readonly ItemLedgerEntry[], session: DbSession): Promise<void> {
    if (entries.length === 0) return;
    await this.db(session).insert(itemLedger).values([...entries]);
  }
}
