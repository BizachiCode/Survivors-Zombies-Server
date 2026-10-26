// In-memory leaderboards computed from the MemoryStore (same ordering rules as the SQL of DrizzleRankingRepository).

import type { RankedRow, RankingBoard, RankingRepository, RankingStanding } from "../../src/modules/ranking/ranking.repository.js";
import type { MemoryStore } from "./memory-repositories.js";

export class MemoryRankingRepository implements RankingRepository {
  /** Number of `top` queries served (tests check the cache with it). */
  topQueries = 0;

  constructor(private readonly store: MemoryStore) {}

  async top(board: RankingBoard, limit: number): Promise<RankedRow[]> {
    this.topQueries++;
    return this.rows(board).slice(0, limit);
  }

  async standing(board: RankingBoard, userId: string): Promise<RankingStanding | null> {
    const profile = this.store.profiles.get(userId);
    if (!profile) return null;
    const row = { ...profile, score: this.score(board, userId) };
    const better = this.everyone(board).filter((other) => this.keyOf(board, other) > this.keyOf(board, row)).length;
    return { row, better };
  }

  private score(board: RankingBoard, userId: string): number {
    if (board === "level") return this.store.profiles.get(userId)?.level ?? 0;
    if (board === "stars") {
      return [...this.store.stageProgress.values()].filter((p) => p.userId === userId).reduce((sum, p) => sum + p.bestStars, 0);
    }
    return [...this.store.battleResults.values()].filter((r) => r.userId === userId && r.outcome === "VICTORY").length;
  }

  private keyOf(board: RankingBoard, row: RankedRow): number {
    return board === "level" ? row.level * 1e12 + row.exp : row.score;
  }

  private everyone(board: RankingBoard): RankedRow[] {
    return [...this.store.profiles.values()].map((profile) => ({ ...profile, score: this.score(board, profile.userId) }))
      .filter((row) => board === "level" || row.score > 0);
  }

  private rows(board: RankingBoard): RankedRow[] {
    const created = (userId: string) => this.store.users.get(userId)?.createdAt.getTime() ?? 0;
    return this.everyone(board).sort((a, b) =>
      this.keyOf(board, b) - this.keyOf(board, a) || b.level - a.level || created(a.userId) - created(b.userId) || a.userId.localeCompare(b.userId));
  }
}
