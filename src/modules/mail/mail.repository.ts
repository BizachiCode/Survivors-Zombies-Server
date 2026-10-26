import { and, desc, eq, inArray, isNotNull, isNull, gt, or } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userMail } from "../../infrastructure/database/schema/mail.schema.js";
import { parseJsonColumn, type LocalizedText } from "../../shared/content/localized-text.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { RewardBundle } from "../economy/reward-granter.js";

export type MailRow = {
  id: string;
  userId: string;
  /** Content id of the broadcast it came from; null = sent to this player only. */
  broadcastId: string | null;
  sender: string;
  title: LocalizedText;
  body: LocalizedText;
  attachments: RewardBundle;
  createdAt: Date;
  expiresAt: Date | null;
  readAt: Date | null;
  claimedAt: Date | null;
  deletedAt: Date | null;
};

/** Persistence port of the inbox. Rows are never removed: a deleted mail keeps its row so a broadcast is delivered once. */
export interface MailRepository {
  /** Mails not deleted and not expired at `now`, newest first. */
  listActive(userId: string, now: Date, session?: DbSession): Promise<MailRow[]>;
  /** The mails with unclaimed attachments, not deleted and not expired, row-locked (inside a transaction). */
  lockClaimable(userId: string, now: Date, session: DbSession): Promise<MailRow[]>;
  /** `forUpdate` (inside a transaction) locks the row. Deleted rows are returned (check `deletedAt`). */
  get(userId: string, mailId: string, session?: DbSession, forUpdate?: boolean): Promise<MailRow | null>;
  /** Broadcast ids already delivered to the player (deleted ones included). */
  deliveredBroadcasts(userId: string, broadcastIds: readonly string[], session?: DbSession): Promise<Set<string>>;
  /** Inserts a row; false when the (user, broadcast) pair already exists. */
  insert(row: MailRow, session?: DbSession): Promise<boolean>;
  markRead(userId: string, mailId: string, at: Date, session?: DbSession): Promise<void>;
  /** Sets `claimedAt` (and `readAt` when still unread). */
  markClaimed(userId: string, mailIds: readonly string[], at: Date, session: DbSession): Promise<void>;
  markDeleted(userId: string, mailId: string, at: Date, session?: DbSession): Promise<void>;
}

type Stored = typeof userMail.$inferSelect;

function toRow(row: Stored): MailRow {
  return {
    id: row.id,
    userId: row.userId,
    broadcastId: row.broadcastId,
    sender: row.sender,
    title: parseJsonColumn<LocalizedText>(row.title),
    body: parseJsonColumn<LocalizedText>(row.body),
    attachments: parseJsonColumn<RewardBundle>(row.attachments),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    readAt: row.readAt,
    claimedAt: row.claimedAt,
    deletedAt: row.deletedAt,
  };
}

const notExpired = (now: Date) => or(isNull(userMail.expiresAt), gt(userMail.expiresAt, now));

export class DrizzleMailRepository extends DrizzleRepository implements MailRepository {
  async listActive(userId: string, now: Date, session?: DbSession): Promise<MailRow[]> {
    const rows = await this.db(session).select().from(userMail)
      .where(and(eq(userMail.userId, userId), isNull(userMail.deletedAt), notExpired(now)))
      .orderBy(desc(userMail.createdAt), userMail.id).limit(200);
    return rows.map(toRow);
  }

  async lockClaimable(userId: string, now: Date, session: DbSession): Promise<MailRow[]> {
    const rows = await this.db(session).select().from(userMail)
      .where(and(eq(userMail.userId, userId), isNull(userMail.deletedAt), isNull(userMail.claimedAt), notExpired(now)))
      .orderBy(userMail.createdAt, userMail.id).for("update");
    return rows.map(toRow);
  }

  async get(userId: string, mailId: string, session?: DbSession, forUpdate = false): Promise<MailRow | null> {
    const query = this.db(session).select().from(userMail).where(and(eq(userMail.userId, userId), eq(userMail.id, mailId))).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ? toRow(rows[0]) : null;
  }

  async deliveredBroadcasts(userId: string, broadcastIds: readonly string[], session?: DbSession): Promise<Set<string>> {
    if (broadcastIds.length === 0) return new Set();
    const rows = await this.db(session).select({ broadcastId: userMail.broadcastId }).from(userMail)
      .where(and(eq(userMail.userId, userId), isNotNull(userMail.broadcastId), inArray(userMail.broadcastId, [...broadcastIds])));
    return new Set(rows.map((row) => row.broadcastId!));
  }

  async insert(row: MailRow, session?: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(userMail).values({
        id: row.id,
        userId: row.userId,
        broadcastId: row.broadcastId,
        sender: row.sender,
        title: row.title,
        body: row.body,
        attachments: row.attachments,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async markRead(userId: string, mailId: string, at: Date, session?: DbSession): Promise<void> {
    await this.db(session).update(userMail).set({ readAt: at })
      .where(and(eq(userMail.userId, userId), eq(userMail.id, mailId), isNull(userMail.readAt)));
  }

  async markClaimed(userId: string, mailIds: readonly string[], at: Date, session: DbSession): Promise<void> {
    if (mailIds.length === 0) return;
    const where = and(eq(userMail.userId, userId), inArray(userMail.id, [...mailIds]));
    await this.db(session).update(userMail).set({ readAt: at }).where(and(where, isNull(userMail.readAt)));
    await this.db(session).update(userMail).set({ claimedAt: at }).where(where);
  }

  async markDeleted(userId: string, mailId: string, at: Date, session?: DbSession): Promise<void> {
    await this.db(session).update(userMail).set({ deletedAt: at }).where(and(eq(userMail.userId, userId), eq(userMail.id, mailId)));
  }
}
