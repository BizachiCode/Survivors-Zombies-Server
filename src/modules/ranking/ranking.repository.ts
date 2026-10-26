import { sql, type SQL } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";

export const RANKING_BOARDS = ["stars", "level", "wins"] as const;
export type RankingBoard = (typeof RANKING_BOARDS)[number];

export type RankedRow = {
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
  /** Experience inside the level (the `level` board's key together with the level). */
  exp: number;
  /** Stars, level or wins. */
  score: number;
};

export type RankingStanding = {
  row: RankedRow;
  /** Players ranked strictly above this one (by the board's key: stars, wins, or level then exp). */
  better: number;
};

/** Persistence port of the leaderboards (read only). */
export interface RankingRepository {
  /** The best `limit` players: key desc, then level desc, then the earlier account. Players without a score are left out (except on `level`). */
  top(board: RankingBoard, limit: number): Promise<RankedRow[]>;
  /** One player's row and how many players rank strictly above it; null when the player has no profile. */
  standing(board: RankingBoard, userId: string): Promise<RankingStanding | null>;
}

type RawRow = { userId: string; nickname: string; avatarId: string; level: number | string; exp: number | string; score: number | string };

/** Per-user totals of the stars / wins boards (users without a score are not part of them). */
const TOTALS: Record<"stars" | "wins", SQL> = {
  stars: sql`SELECT user_id AS uid, CAST(SUM(best_stars) AS SIGNED) AS score FROM user_stage_progress GROUP BY user_id HAVING SUM(best_stars) > 0`,
  wins: sql`SELECT user_id AS uid, COUNT(*) AS score FROM battle_results WHERE outcome = 'VICTORY' GROUP BY user_id`,
};

export class DrizzleRankingRepository extends DrizzleRepository implements RankingRepository {
  async top(board: RankingBoard, limit: number): Promise<RankedRow[]> {
    // Inlined: a bound LIMIT placeholder is refused by some MySQL / mysql2 combinations.
    const rowLimit = sql.raw(String(Math.max(1, Math.floor(limit))));
    const rows = board === "level"
      ? await this.query<RawRow>(sql`
          SELECT p.user_id AS userId, p.nickname, p.avatar_id AS avatarId, p.level, p.exp, p.level AS score
          FROM user_profile p JOIN users u ON u.id = p.user_id
          ORDER BY p.level DESC, p.exp DESC, u.created_at ASC, p.user_id ASC LIMIT ${rowLimit}`)
      : await this.query<RawRow>(sql`
          SELECT p.user_id AS userId, p.nickname, p.avatar_id AS avatarId, p.level, p.exp, t.score AS score
          FROM (${TOTALS[board]}) t JOIN user_profile p ON p.user_id = t.uid JOIN users u ON u.id = p.user_id
          ORDER BY t.score DESC, p.level DESC, u.created_at ASC, p.user_id ASC LIMIT ${rowLimit}`);
    return rows.map(toRow);
  }

  async standing(board: RankingBoard, userId: string): Promise<RankingStanding | null> {
    const score = board === "level"
      ? sql`p.level`
      : sql`COALESCE((SELECT t.score FROM (${TOTALS[board]}) t WHERE t.uid = p.user_id), 0)`;
    const own = (await this.query<RawRow>(sql`
      SELECT p.user_id AS userId, p.nickname, p.avatar_id AS avatarId, p.level, p.exp, ${score} AS score
      FROM user_profile p WHERE p.user_id = ${userId} LIMIT 1`))[0];
    if (!own) return null;
    const row = toRow(own);
    if (board === "level") {
      const [{ n }] = await this.query<{ n: number | string }>(sql`
        SELECT COUNT(*) AS n FROM user_profile WHERE level > ${row.level} OR (level = ${row.level} AND exp > ${row.exp})`);
      return { row, better: Number(n) };
    }
    if (row.score <= 0) return { row, better: 0 };
    const [{ n }] = await this.query<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM (${TOTALS[board]}) t WHERE t.score > ${row.score}`);
    return { row, better: Number(n) };
  }

  private async query<T>(statement: SQL): Promise<T[]> {
    const [rows] = (await this.database.execute(statement)) as unknown as [T[]];
    return rows;
  }
}

function toRow(raw: RawRow): RankedRow {
  return { userId: raw.userId, nickname: raw.nickname, avatarId: raw.avatarId, level: Number(raw.level), exp: Number(raw.exp), score: Number(raw.score) };
}
