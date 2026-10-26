// Read models for the admin panel (search, dashboard counters, recent battles) and the admin audit trail. Reads only,
// except for `insertAudit`: every balance or ban change goes through the feature's own service / ledger.

import { count, desc, eq, gte, like, or, sql } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { adminAudit } from "../../infrastructure/database/schema/admin.schema.js";
import { battleResults, iapPurchases, userFriendships, userProfile, users } from "../../infrastructure/database/schema/index.js";
import { parseJsonColumn } from "../../shared/content/localized-text.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import { publicUserId } from "../../shared/kernel/public-id.js";

export type PlayerSummary = {
  userId: string;
  /** The 8 hex characters players see (rankings, friends). */
  publicCode: string;
  nickname: string | null;
  level: number | null;
  email: string | null;
  isGuest: boolean;
  isBanned: boolean;
  banExpiresAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
};

/** Any of the given criteria matches (OR). */
export type PlayerSearch = { userId?: string; publicCode?: string; email?: string; nicknamePrefix?: string };

export type DashboardCounters = {
  totalPlayers: number;
  activeSinceToday: number;
  activeSinceWeek: number;
  newSinceToday: number;
  purchases: Array<{ productId: string; count: number; refunded: number }>;
};

export type BattleSummary = { id: string; mode: string; stageId: string; outcome: string; stars: number; kills: number; createdAt: Date | null };

export type AuditEntry = { id: number; createdAt: Date; ip: string; action: string; target: string; payload: unknown };
export type NewAuditEntry = { ip: string; action: string; target: string; payload: unknown };

/** Persistence port of the admin read models and audit trail. */
export interface AdminRepository {
  counters(todayStart: Date, weekStart: Date): Promise<DashboardCounters>;
  search(criteria: PlayerSearch, limit: number): Promise<PlayerSummary[]>;
  summary(userId: string): Promise<PlayerSummary | null>;
  recentBattles(userId: string, limit: number): Promise<BattleSummary[]>;
  friendsCount(userId: string): Promise<number>;
  insertAudit(entry: NewAuditEntry, session?: DbSession): Promise<void>;
  /** Newest first; `target` narrows to one player / content id. */
  listAudit(filter: { target?: string; limit: number }): Promise<AuditEntry[]>;
}

const summaryColumns = {
  userId: users.id,
  nickname: userProfile.nickname,
  level: userProfile.level,
  email: users.email,
  isGuest: users.isGuest,
  isBanned: users.isBanned,
  banExpiresAt: users.banExpiresAt,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
};

type SummaryRow = { userId: string; nickname: string | null; level: number | null; email: string | null; isGuest: boolean; isBanned: boolean; banExpiresAt: Date | null; createdAt: Date; lastLoginAt: Date | null };

function toSummary(row: SummaryRow): PlayerSummary {
  return { ...row, publicCode: publicUserId(row.userId) };
}

/** `%`, `_` and `\` in a LIKE pattern typed by an admin are literals. */
export function escapeLike(value: string): string {
  return value.replace(/[\%_]/g, (ch) => `\${ch}`);
}

export class DrizzleAdminRepository extends DrizzleRepository implements AdminRepository {
  async counters(todayStart: Date, weekStart: Date): Promise<DashboardCounters> {
    const total = await this.database.select({ n: count() }).from(users);
    const today = await this.database.select({ n: count() }).from(users).where(gte(users.lastLoginAt, todayStart));
    const week = await this.database.select({ n: count() }).from(users).where(gte(users.lastLoginAt, weekStart));
    const created = await this.database.select({ n: count() }).from(users).where(gte(users.createdAt, todayStart));
    const purchases = await this.database
      .select({
        productId: iapPurchases.productId,
        total: count(),
        refunded: sql<number>`COALESCE(SUM(CASE WHEN ${iapPurchases.status} = 'refunded' THEN 1 ELSE 0 END), 0)`,
      })
      .from(iapPurchases).where(gte(iapPurchases.createdAt, todayStart)).groupBy(iapPurchases.productId);
    return {
      totalPlayers: Number(total[0]?.n ?? 0),
      activeSinceToday: Number(today[0]?.n ?? 0),
      activeSinceWeek: Number(week[0]?.n ?? 0),
      newSinceToday: Number(created[0]?.n ?? 0),
      purchases: purchases.map((row) => ({ productId: row.productId, count: Number(row.total), refunded: Number(row.refunded) })),
    };
  }

  async search(criteria: PlayerSearch, limit: number): Promise<PlayerSummary[]> {
    const conditions = [];
    if (criteria.userId) conditions.push(eq(users.id, criteria.userId.toLowerCase()));
    // A user id is a uuid: its first group is the 8 hex characters of the public code.
    if (criteria.publicCode) conditions.push(like(users.id, `${criteria.publicCode.toLowerCase()}-%`));
    if (criteria.email) conditions.push(eq(users.email, criteria.email.toLowerCase()));
    if (criteria.nicknamePrefix) conditions.push(like(userProfile.nickname, `${escapeLike(criteria.nicknamePrefix)}%`));
    if (conditions.length === 0) return [];
    const rows = await this.database.select(summaryColumns).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id))
      .where(or(...conditions)).orderBy(desc(users.lastLoginAt)).limit(limit);
    return rows.map(toSummary);
  }

  async summary(userId: string): Promise<PlayerSummary | null> {
    const rows = await this.database.select(summaryColumns).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id))
      .where(eq(users.id, userId)).limit(1);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async recentBattles(userId: string, limit: number): Promise<BattleSummary[]> {
    return this.database.select({
      id: battleResults.id, mode: battleResults.mode, stageId: battleResults.stageId, outcome: battleResults.outcome,
      stars: battleResults.stars, kills: battleResults.kills, createdAt: battleResults.createdAt,
    }).from(battleResults).where(eq(battleResults.userId, userId)).orderBy(desc(battleResults.createdAt)).limit(limit);
  }

  async friendsCount(userId: string): Promise<number> {
    const rows = await this.database.select({ n: count() }).from(userFriendships)
      .where(or(eq(userFriendships.userA, userId), eq(userFriendships.userB, userId)));
    return Number(rows[0]?.n ?? 0);
  }

  async insertAudit(entry: NewAuditEntry, session?: DbSession): Promise<void> {
    await this.db(session).insert(adminAudit).values({ ip: entry.ip.slice(0, 45), action: entry.action, target: entry.target.slice(0, 128), payload: entry.payload ?? {} });
  }

  async listAudit(filter: { target?: string; limit: number }): Promise<AuditEntry[]> {
    const query = this.database.select().from(adminAudit);
    const rows = await (filter.target ? query.where(eq(adminAudit.target, filter.target)) : query).orderBy(desc(adminAudit.id)).limit(filter.limit);
    return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, ip: row.ip, action: row.action, target: row.target, payload: parseJsonColumn<unknown>(row.payload) }));
  }
}
