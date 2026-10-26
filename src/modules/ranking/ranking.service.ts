// Leaderboards: the top of each board is cached for a minute (one query per board per minute, however many players ask);
// the player's own row is computed per request.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { publicUserId } from "../../shared/kernel/public-id.js";
import { RANKING_BOARDS, type RankedRow, type RankingBoard, type RankingRepository } from "./ranking.repository.js";

export const RANKING_TOP_SIZE = 100;
export const RANKING_CACHE_SECONDS = 60;

export type RankingEntryDto = {
  rank: number;
  /** Public id (first 8 hex digits of the user id). */
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
  score: number;
};

export type RankingInfoDto = {
  board: RankingBoard;
  top: RankingEntryDto[];
  /** The player's own row (also outside the top); null while the player has no score on the board. */
  me: RankingEntryDto | null;
  refreshedAtUnix: number;
};

type CachedBoard = { loadedAtMs: number; rows: RankedRow[] };

export function isRankingBoard(value: string): value is RankingBoard {
  return (RANKING_BOARDS as readonly string[]).includes(value);
}

/** Two rows tie when their board key is equal: stars and wins by score, the level board by level and experience. */
function sameKey(board: RankingBoard, a: RankedRow, b: RankedRow): boolean {
  return a.score === b.score && (board !== "level" || a.exp === b.exp);
}

export class RankingService {
  private readonly cache = new Map<RankingBoard, CachedBoard>();
  private readonly loading = new Map<RankingBoard, Promise<CachedBoard>>();

  constructor(
    private readonly rankings: RankingRepository,
    private readonly clock: Clock,
    private readonly options: { topSize?: number; cacheSeconds?: number } = {},
  ) {}

  async info(userId: string, boardId: string): Promise<RankingInfoDto> {
    if (!isRankingBoard(boardId)) throw new AppError(ErrorCode.RANKING_UNKNOWN_BOARD);
    const board = boardId;
    const cached = await this.top(board);
    const top = cached.rows.map((row, index): RankingEntryDto => {
      // Ties share the best rank (1 + the players strictly above), like the player's own row.
      let first = index;
      while (first > 0 && sameKey(board, cached.rows[first - 1], row)) first--;
      return toEntry(row, first + 1);
    });

    const standing = await this.rankings.standing(board, userId);
    const me = standing && standing.row.score > 0 ? toEntry(standing.row, standing.better + 1) : null;
    return { board, top, me, refreshedAtUnix: Math.floor(cached.loadedAtMs / 1000) };
  }

  private async top(board: RankingBoard): Promise<CachedBoard> {
    const cached = this.cache.get(board);
    const ttlMs = (this.options.cacheSeconds ?? RANKING_CACHE_SECONDS) * 1000;
    if (cached && this.clock.nowMs() - cached.loadedAtMs < ttlMs) return cached;

    let pending = this.loading.get(board);
    if (!pending) {
      pending = this.rankings.top(board, this.options.topSize ?? RANKING_TOP_SIZE)
        .then((rows) => {
          const loaded = { loadedAtMs: this.clock.nowMs(), rows };
          this.cache.set(board, loaded);
          return loaded;
        })
        .finally(() => this.loading.delete(board));
      this.loading.set(board, pending);
    }
    return pending;
  }
}

function toEntry(row: RankedRow, rank: number): RankingEntryDto {
  return { rank, userId: publicUserId(row.userId), nickname: row.nickname, avatarId: row.avatarId, level: row.level, score: row.score };
}
