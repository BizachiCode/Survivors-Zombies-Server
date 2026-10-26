// Player statistics for the profile screen, read from the other modules' tables (battles, collection, objectives).

import type { BattleRepository } from "../battle/battle.repository.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { ObjectivesRepository } from "../objectives/objectives.repository.js";

export interface PlayerStatsDto {
  battlesPlayed: number;
  battlesWon: number;
  starsTotal: number;
  /** Stars available in the campaign (3 per stage). */
  starsMax: number;
  stagesCleared: number;
  stagesTotal: number;
  crewOwned: number;
  crewTotal: number;
  /** Highest collection level of an owned card. */
  bestCrewLevel: number;
  achievementsCompleted: number;
  achievementsTotal: number;
}

export class ProfileStatsReader {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly battles: BattleRepository,
    private readonly cards: CollectionRepository,
    private readonly objectives: ObjectivesRepository,
  ) {}

  async stats(userId: string): Promise<PlayerStatsDto> {
    const progress = await this.battles.listProgress(userId);
    const owned = this.catalog.collection ? await this.cards.listCards(userId) : [];
    const achievements = (this.catalog.progression?.objectives ?? []).filter((o) => o.kind === "achievement");
    const claimed = achievements.length > 0
      ? (await this.objectives.listProgress(userId, ["A"])).filter((row) => row.claimedAt && achievements.some((a) => a.id === row.objectiveId)).length
      : 0;
    return {
      battlesPlayed: progress.reduce((sum, p) => sum + p.plays, 0),
      battlesWon: progress.reduce((sum, p) => sum + p.wins, 0),
      starsTotal: progress.reduce((sum, p) => sum + p.bestStars, 0),
      starsMax: this.catalog.stages.length * 3,
      stagesCleared: progress.filter((p) => p.wins > 0).length,
      stagesTotal: this.catalog.stages.length,
      crewOwned: owned.length,
      crewTotal: this.catalog.collection?.cards.length ?? 0,
      bestCrewLevel: owned.reduce((best, card) => Math.max(best, card.level), 0),
      achievementsCompleted: claimed,
      achievementsTotal: achievements.length,
    };
  }
}
