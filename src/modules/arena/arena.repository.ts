import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { arenaEntries, arenaGroups, arenaPlayers } from "../../infrastructure/database/schema/arena.schema.js";
import { userProfile } from "../../infrastructure/database/schema/accounts.schema.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type ArenaPlayerRow = { userId: string; leagueIndex: number; tickets: number; ticketsAt: Date };
export type ArenaGroupRow = { id: string; seasonId: string; leagueIndex: number; members: number };
export type ArenaEntryRow = {
  seasonId: string;
  userId: string;
  groupId: string;
  leagueIndex: number;
  bestScore: number;
  bestAt: Date | null;
  plays: number;
  settledAt: Date | null;
};
/** A group member with the profile shown in the standings. */
export type ArenaStandingRow = ArenaEntryRow & { nickname: string; avatarId: string; level: number };

/** Persistence port of the arena. */
export interface ArenaRepository {
  /** `forUpdate` (inside a transaction) locks the row. */
  getPlayer(userId: string, session?: DbSession, forUpdate?: boolean): Promise<ArenaPlayerRow | null>;
  savePlayer(row: ArenaPlayerRow, session: DbSession): Promise<void>;
  getEntry(seasonId: string, userId: string, session?: DbSession, forUpdate?: boolean): Promise<ArenaEntryRow | null>;
  insertEntry(row: ArenaEntryRow, session: DbSession): Promise<void>;
  saveEntry(row: ArenaEntryRow, session: DbSession): Promise<void>;
  /** The player's entries of seasons before `seasonId` that were not settled yet. */
  unsettledBefore(userId: string, seasonId: string, session?: DbSession): Promise<ArenaEntryRow[]>;
  /** A group of the league and season with room left, locked (inside a transaction); null when every group is full. */
  lockOpenGroup(seasonId: string, leagueIndex: number, size: number, session: DbSession): Promise<ArenaGroupRow | null>;
  insertGroup(row: ArenaGroupRow, session: DbSession): Promise<void>;
  setGroupMembers(groupId: string, members: number, session: DbSession): Promise<void>;
  /** Every entry of a group with its profile, in no particular order. */
  groupEntries(groupId: string, session?: DbSession): Promise<ArenaStandingRow[]>;
}

const entryColumns = {
  seasonId: arenaEntries.seasonId,
  userId: arenaEntries.userId,
  groupId: arenaEntries.groupId,
  leagueIndex: arenaEntries.leagueIndex,
  bestScore: arenaEntries.bestScore,
  bestAt: arenaEntries.bestAt,
  plays: arenaEntries.plays,
  settledAt: arenaEntries.settledAt,
};

export class DrizzleArenaRepository extends DrizzleRepository implements ArenaRepository {
  async getPlayer(userId: string, session?: DbSession, forUpdate = false): Promise<ArenaPlayerRow | null> {
    const query = this.db(session).select({
      userId: arenaPlayers.userId, leagueIndex: arenaPlayers.leagueIndex, tickets: arenaPlayers.tickets, ticketsAt: arenaPlayers.ticketsAt,
    }).from(arenaPlayers).where(eq(arenaPlayers.userId, userId)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async savePlayer(row: ArenaPlayerRow, session: DbSession): Promise<void> {
    await this.db(session).insert(arenaPlayers).values(row)
      .onDuplicateKeyUpdate({ set: { leagueIndex: row.leagueIndex, tickets: row.tickets, ticketsAt: row.ticketsAt } });
  }

  async getEntry(seasonId: string, userId: string, session?: DbSession, forUpdate = false): Promise<ArenaEntryRow | null> {
    const query = this.db(session).select(entryColumns).from(arenaEntries)
      .where(and(eq(arenaEntries.seasonId, seasonId), eq(arenaEntries.userId, userId))).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async insertEntry(row: ArenaEntryRow, session: DbSession): Promise<void> {
    await this.db(session).insert(arenaEntries).values(row);
  }

  async saveEntry(row: ArenaEntryRow, session: DbSession): Promise<void> {
    await this.db(session).update(arenaEntries)
      .set({ bestScore: row.bestScore, bestAt: row.bestAt, plays: row.plays, settledAt: row.settledAt })
      .where(and(eq(arenaEntries.seasonId, row.seasonId), eq(arenaEntries.userId, row.userId)));
  }

  async unsettledBefore(userId: string, seasonId: string, session?: DbSession): Promise<ArenaEntryRow[]> {
    return this.db(session).select(entryColumns).from(arenaEntries)
      .where(and(eq(arenaEntries.userId, userId), isNull(arenaEntries.settledAt), lt(arenaEntries.seasonId, seasonId)))
      .orderBy(asc(arenaEntries.seasonId));
  }

  async lockOpenGroup(seasonId: string, leagueIndex: number, size: number, session: DbSession): Promise<ArenaGroupRow | null> {
    const rows = await this.db(session).select({
      id: arenaGroups.id, seasonId: arenaGroups.seasonId, leagueIndex: arenaGroups.leagueIndex, members: arenaGroups.members,
    }).from(arenaGroups)
      .where(and(eq(arenaGroups.seasonId, seasonId), eq(arenaGroups.leagueIndex, leagueIndex), lt(arenaGroups.members, size)))
      .orderBy(asc(arenaGroups.createdAt)).limit(1).for("update");
    return rows[0] ?? null;
  }

  async insertGroup(row: ArenaGroupRow, session: DbSession): Promise<void> {
    await this.db(session).insert(arenaGroups).values(row);
  }

  async setGroupMembers(groupId: string, members: number, session: DbSession): Promise<void> {
    await this.db(session).update(arenaGroups).set({ members }).where(eq(arenaGroups.id, groupId));
  }

  async groupEntries(groupId: string, session?: DbSession): Promise<ArenaStandingRow[]> {
    return this.db(session).select({
      ...entryColumns,
      nickname: sql<string>`coalesce(${userProfile.nickname}, '')`,
      avatarId: sql<string>`coalesce(${userProfile.avatarId}, '')`,
      level: sql<number>`coalesce(${userProfile.level}, 1)`,
    }).from(arenaEntries).leftJoin(userProfile, eq(userProfile.userId, arenaEntries.userId))
      .where(eq(arenaEntries.groupId, groupId));
  }
}
