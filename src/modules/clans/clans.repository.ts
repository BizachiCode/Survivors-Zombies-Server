import { and, asc, count, desc, eq, gte, inArray, like, ne, sql, type SQL } from "drizzle-orm";

import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile, users } from "../../infrastructure/database/schema/accounts.schema.js";
import { clanDonationRequests, clanDonations, clanJoinRequests, clanMembers, clans } from "../../infrastructure/database/schema/clans.schema.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ClanRole, ClanType } from "./clans-config.js";

export type ClanRow = {
  id: string;
  tag: string;
  name: string;
  description: string;
  badge: string;
  type: ClanType;
  minLevel: number;
  createdAt: Date;
};

export type ClanPatch = Partial<Pick<ClanRow, "description" | "badge" | "type" | "minLevel">>;

export type ClanMemberRow = { userId: string; clanId: string; role: ClanRole; joinedAt: Date };

export type JoinRequestRow = { userId: string; clanId: string; createdAt: Date };

/** What other players see of an account. `lastLoginAt` is the account's last sign-in (users.last_login_at). */
export type ClanPlayerRow = { userId: string; nickname: string; avatarId: string; level: number; lastLoginAt: Date | null };

export type DonationRequestRow = {
  id: string;
  clanId: string;
  userId: string;
  itemId: string;
  requested: number;
  received: number;
  createdAt: Date;
};

export type DonationRow = { id: string; requestId: string; donorId: string; day: string; createdAt: Date };

export type ClanRankRow = { clanId: string; score: number; members: number };

/** A clan's score (stars of its members) and how many clans rank strictly above it. */
export type ClanStanding = { score: number; better: number };

/** Persistence port of clans, members, join requests and donations. Rules live in the service. */
export interface ClansRepository {
  /** False when the tag or the name key already exists. */
  insertClan(row: ClanRow, session: DbSession): Promise<boolean>;
  /** `forUpdate` (inside a transaction) locks the row: member-count rules serialize on it. */
  getClan(id: string, session?: DbSession, forUpdate?: boolean): Promise<ClanRow | null>;
  getClans(ids: readonly string[], session?: DbSession): Promise<ClanRow[]>;
  getClanByTag(tag: string, session?: DbSession): Promise<ClanRow | null>;
  nameExists(nameKey: string, session?: DbSession): Promise<boolean>;
  updateClan(id: string, patch: ClanPatch, session: DbSession): Promise<void>;
  /** Removes the clan with its members, requests and donations. */
  deleteClan(id: string, session: DbSession): Promise<void>;
  /** Non-closed clans whose lower-case name starts with `prefixKey`, by name. */
  searchByName(prefixKey: string, limit: number): Promise<ClanRow[]>;
  /** Non-closed clans a player of `level` could join, newest first (the service orders them by size). */
  listJoinable(level: number, limit: number): Promise<ClanRow[]>;
  memberCounts(clanIds: readonly string[], session?: DbSession): Promise<Map<string, number>>;
  /** Score (sum of the members' campaign stars) per clan; clans without members have no entry. */
  scores(clanIds: readonly string[]): Promise<Map<string, number>>;
  /** Campaign stars per player (players without progress are left out). */
  stars(userIds: readonly string[]): Promise<Map<string, number>>;
  /** The best `limit` clans: score desc, members desc, the older clan first. */
  topClans(limit: number): Promise<ClanRankRow[]>;
  standing(clanId: string): Promise<ClanStanding | null>;

  getMember(userId: string, session?: DbSession, forUpdate?: boolean): Promise<ClanMemberRow | null>;
  /** Oldest member first. */
  listMembers(clanId: string, session?: DbSession): Promise<ClanMemberRow[]>;
  /** False when the player is already in a clan. */
  insertMember(row: ClanMemberRow, session: DbSession): Promise<boolean>;
  /** False when the player is not in that clan. */
  deleteMember(userId: string, clanId: string, session: DbSession): Promise<boolean>;
  setRole(userId: string, role: ClanRole, session: DbSession): Promise<void>;
  players(userIds: readonly string[], session?: DbSession): Promise<Map<string, ClanPlayerRow>>;

  /** False when the player already has a pending request. */
  insertJoinRequest(row: JoinRequestRow, session: DbSession): Promise<boolean>;
  /** The player's pending request created at or after `since`. */
  getJoinRequest(userId: string, since: Date, session?: DbSession): Promise<JoinRequestRow | null>;
  listJoinRequests(clanId: string, since: Date, session?: DbSession): Promise<JoinRequestRow[]>;
  deleteJoinRequest(userId: string, session: DbSession): Promise<boolean>;

  insertDonationRequest(row: DonationRequestRow, session: DbSession): Promise<void>;
  latestDonationRequest(userId: string, session?: DbSession): Promise<DonationRequestRow | null>;
  getDonationRequest(id: string, session: DbSession, forUpdate?: boolean): Promise<DonationRequestRow | null>;
  /** Requests of the clan created at or after `since`, oldest first. */
  listDonationRequests(clanId: string, since: Date, session?: DbSession): Promise<DonationRequestRow[]>;
  addReceived(id: string, session: DbSession): Promise<void>;
  insertDonation(row: DonationRow, session: DbSession): Promise<void>;
  /** Donations `donorId` made to each of the requests. */
  donationsByDonor(requestIds: readonly string[], donorId: string, session?: DbSession): Promise<Map<string, number>>;
  countDonationsOn(donorId: string, day: string, session?: DbSession): Promise<number>;
}

const clanColumns = {
  id: clans.id, tag: clans.tag, name: clans.name, description: clans.description, badge: clans.badge, type: clans.type,
  minLevel: clans.minLevel, createdAt: clans.createdAt,
};

const toClan = (row: { id: string; tag: string; name: string; description: string; badge: string; type: string; minLevel: number; createdAt: Date }): ClanRow =>
  ({ ...row, type: row.type as ClanType });

const toMember = (row: { userId: string; clanId: string; role: string; joinedAt: Date }): ClanMemberRow => ({ ...row, role: row.role as ClanRole });

const memberColumns = { userId: clanMembers.userId, clanId: clanMembers.clanId, role: clanMembers.role, joinedAt: clanMembers.joinedAt };

const requestColumns = {
  id: clanDonationRequests.id, clanId: clanDonationRequests.clanId, userId: clanDonationRequests.userId, itemId: clanDonationRequests.itemId,
  requested: clanDonationRequests.requested, received: clanDonationRequests.received, createdAt: clanDonationRequests.createdAt,
};

/** Stars and size per clan (`clan_id`, `score`, `members`), the building block of every ranking query. */
const CLAN_SCORES = sql`SELECT m.clan_id AS clan_id, CAST(COALESCE(SUM(s.best_stars), 0) AS SIGNED) AS score, COUNT(DISTINCT m.user_id) AS members
  FROM clan_members m LEFT JOIN user_stage_progress s ON s.user_id = m.user_id GROUP BY m.clan_id`;

export class DrizzleClansRepository extends DrizzleRepository implements ClansRepository {
  async insertClan(row: ClanRow, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(clans).values({
        id: row.id, tag: row.tag, name: row.name, nameKey: row.name.toLowerCase(), description: row.description, badge: row.badge,
        type: row.type, minLevel: row.minLevel, createdAt: row.createdAt,
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async getClan(id: string, session?: DbSession, forUpdate = false): Promise<ClanRow | null> {
    const query = this.db(session).select(clanColumns).from(clans).where(eq(clans.id, id)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ? toClan(rows[0]) : null;
  }

  async getClans(ids: readonly string[], session?: DbSession): Promise<ClanRow[]> {
    if (ids.length === 0) return [];
    return (await this.db(session).select(clanColumns).from(clans).where(inArray(clans.id, [...ids]))).map(toClan);
  }

  async getClanByTag(tag: string, session?: DbSession): Promise<ClanRow | null> {
    const rows = await this.db(session).select(clanColumns).from(clans).where(eq(clans.tag, tag)).limit(1);
    return rows[0] ? toClan(rows[0]) : null;
  }

  async nameExists(nameKey: string, session?: DbSession): Promise<boolean> {
    const rows = await this.db(session).select({ id: clans.id }).from(clans).where(eq(clans.nameKey, nameKey)).limit(1);
    return rows.length > 0;
  }

  async updateClan(id: string, patch: ClanPatch, session: DbSession): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.db(session).update(clans).set(patch).where(eq(clans.id, id));
  }

  async deleteClan(id: string, session: DbSession): Promise<void> {
    await this.db(session).delete(clans).where(eq(clans.id, id));
  }

  async searchByName(prefixKey: string, limit: number): Promise<ClanRow[]> {
    const escaped = prefixKey.replace(/[\\%_]/g, "\\$&");
    const rows = await this.database.select(clanColumns).from(clans)
      .where(and(like(clans.nameKey, `${escaped}%`), ne(clans.type, "closed"))).orderBy(asc(clans.nameKey)).limit(limit);
    return rows.map(toClan);
  }

  async listJoinable(level: number, limit: number): Promise<ClanRow[]> {
    const rows = await this.database.select(clanColumns).from(clans)
      .where(and(ne(clans.type, "closed"), sql`${clans.minLevel} <= ${level}`)).orderBy(desc(clans.createdAt), asc(clans.id)).limit(limit);
    return rows.map(toClan);
  }

  async memberCounts(clanIds: readonly string[], session?: DbSession): Promise<Map<string, number>> {
    if (clanIds.length === 0) return new Map();
    const rows = await this.db(session).select({ clanId: clanMembers.clanId, n: count() }).from(clanMembers)
      .where(inArray(clanMembers.clanId, [...clanIds])).groupBy(clanMembers.clanId);
    return new Map(rows.map((row) => [row.clanId, Number(row.n)]));
  }

  async scores(clanIds: readonly string[]): Promise<Map<string, number>> {
    if (clanIds.length === 0) return new Map();
    const ids = sql.join(clanIds.map((id) => sql`${id}`), sql`, `);
    const rows = await this.query<{ clan_id: string; score: number | string }>(sql`
      SELECT m.clan_id AS clan_id, CAST(COALESCE(SUM(s.best_stars), 0) AS SIGNED) AS score
      FROM clan_members m LEFT JOIN user_stage_progress s ON s.user_id = m.user_id WHERE m.clan_id IN (${ids}) GROUP BY m.clan_id`);
    return new Map(rows.map((row) => [row.clan_id, Number(row.score)]));
  }

  async stars(userIds: readonly string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const ids = sql.join(userIds.map((id) => sql`${id}`), sql`, `);
    const rows = await this.query<{ uid: string; score: number | string }>(sql`
      SELECT user_id AS uid, CAST(SUM(best_stars) AS SIGNED) AS score FROM user_stage_progress WHERE user_id IN (${ids}) GROUP BY user_id`);
    return new Map(rows.map((row) => [row.uid, Number(row.score)]));
  }

  async topClans(limit: number): Promise<ClanRankRow[]> {
    // Inlined: a bound LIMIT placeholder is refused by some MySQL / mysql2 combinations.
    const rowLimit = sql.raw(String(Math.max(1, Math.floor(limit))));
    const rows = await this.query<{ clan_id: string; score: number | string; members: number | string }>(sql`
      SELECT t.clan_id AS clan_id, t.score AS score, t.members AS members
      FROM (${CLAN_SCORES}) t JOIN clans c ON c.id = t.clan_id
      ORDER BY t.score DESC, t.members DESC, c.created_at ASC, c.id ASC LIMIT ${rowLimit}`);
    return rows.map((row) => ({ clanId: row.clan_id, score: Number(row.score), members: Number(row.members) }));
  }

  async standing(clanId: string): Promise<ClanStanding | null> {
    const own = (await this.scores([clanId])).get(clanId);
    if (own === undefined) return null;
    const [row] = await this.query<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM (${CLAN_SCORES}) t WHERE t.score > ${own}`);
    return { score: own, better: Number(row?.n ?? 0) };
  }

  async getMember(userId: string, session?: DbSession, forUpdate = false): Promise<ClanMemberRow | null> {
    const query = this.db(session).select(memberColumns).from(clanMembers).where(eq(clanMembers.userId, userId)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ? toMember(rows[0]) : null;
  }

  async listMembers(clanId: string, session?: DbSession): Promise<ClanMemberRow[]> {
    const rows = await this.db(session).select(memberColumns).from(clanMembers).where(eq(clanMembers.clanId, clanId))
      .orderBy(asc(clanMembers.joinedAt), asc(clanMembers.userId)).limit(200);
    return rows.map(toMember);
  }

  async insertMember(row: ClanMemberRow, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(clanMembers).values(row);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async deleteMember(userId: string, clanId: string, session: DbSession): Promise<boolean> {
    const result = await this.db(session).delete(clanMembers).where(and(eq(clanMembers.userId, userId), eq(clanMembers.clanId, clanId)));
    return affectedRows(result) > 0;
  }

  async setRole(userId: string, role: ClanRole, session: DbSession): Promise<void> {
    await this.db(session).update(clanMembers).set({ role }).where(eq(clanMembers.userId, userId));
  }

  async players(userIds: readonly string[], session?: DbSession): Promise<Map<string, ClanPlayerRow>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db(session)
      .select({ userId: userProfile.userId, nickname: userProfile.nickname, avatarId: userProfile.avatarId, level: userProfile.level, lastLoginAt: users.lastLoginAt })
      .from(userProfile).innerJoin(users, eq(users.id, userProfile.userId))
      .where(inArray(userProfile.userId, [...userIds]));
    return new Map(rows.map((row) => [row.userId, row]));
  }

  async insertJoinRequest(row: JoinRequestRow, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(clanJoinRequests).values(row);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async getJoinRequest(userId: string, since: Date, session?: DbSession): Promise<JoinRequestRow | null> {
    const rows = await this.db(session).select().from(clanJoinRequests)
      .where(and(eq(clanJoinRequests.userId, userId), gte(clanJoinRequests.createdAt, since))).limit(1);
    return rows[0] ?? null;
  }

  async listJoinRequests(clanId: string, since: Date, session?: DbSession): Promise<JoinRequestRow[]> {
    return this.db(session).select().from(clanJoinRequests)
      .where(and(eq(clanJoinRequests.clanId, clanId), gte(clanJoinRequests.createdAt, since)))
      .orderBy(asc(clanJoinRequests.createdAt), asc(clanJoinRequests.userId)).limit(200);
  }

  async deleteJoinRequest(userId: string, session: DbSession): Promise<boolean> {
    const result = await this.db(session).delete(clanJoinRequests).where(eq(clanJoinRequests.userId, userId));
    return affectedRows(result) > 0;
  }

  async insertDonationRequest(row: DonationRequestRow, session: DbSession): Promise<void> {
    await this.db(session).insert(clanDonationRequests).values(row);
  }

  async latestDonationRequest(userId: string, session?: DbSession): Promise<DonationRequestRow | null> {
    const rows = await this.db(session).select(requestColumns).from(clanDonationRequests)
      .where(eq(clanDonationRequests.userId, userId)).orderBy(desc(clanDonationRequests.createdAt)).limit(1);
    return rows[0] ?? null;
  }

  async getDonationRequest(id: string, session: DbSession, forUpdate = false): Promise<DonationRequestRow | null> {
    const query = this.db(session).select(requestColumns).from(clanDonationRequests).where(eq(clanDonationRequests.id, id)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async listDonationRequests(clanId: string, since: Date, session?: DbSession): Promise<DonationRequestRow[]> {
    return this.db(session).select(requestColumns).from(clanDonationRequests)
      .where(and(eq(clanDonationRequests.clanId, clanId), gte(clanDonationRequests.createdAt, since)))
      .orderBy(asc(clanDonationRequests.createdAt), asc(clanDonationRequests.id)).limit(200);
  }

  async addReceived(id: string, session: DbSession): Promise<void> {
    await this.db(session).update(clanDonationRequests).set({ received: sql`${clanDonationRequests.received} + 1` }).where(eq(clanDonationRequests.id, id));
  }

  async insertDonation(row: DonationRow, session: DbSession): Promise<void> {
    await this.db(session).insert(clanDonations).values(row);
  }

  async donationsByDonor(requestIds: readonly string[], donorId: string, session?: DbSession): Promise<Map<string, number>> {
    if (requestIds.length === 0) return new Map();
    const rows = await this.db(session).select({ requestId: clanDonations.requestId, n: count() }).from(clanDonations)
      .where(and(eq(clanDonations.donorId, donorId), inArray(clanDonations.requestId, [...requestIds]))).groupBy(clanDonations.requestId);
    return new Map(rows.map((row) => [row.requestId, Number(row.n)]));
  }

  async countDonationsOn(donorId: string, day: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(clanDonations)
      .where(and(eq(clanDonations.donorId, donorId), eq(clanDonations.day, day)));
    return Number(row?.n ?? 0);
  }

  private async query<T>(statement: SQL): Promise<T[]> {
    const [rows] = (await this.database.execute(statement)) as unknown as [T[]];
    return rows;
  }
}
