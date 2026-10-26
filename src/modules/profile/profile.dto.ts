import type { WalletDto } from "../economy/wallet-ledger.js";
import type { PlayerStatsDto } from "./profile-stats.js";

/** Public profile shown in the HUD and the profile screen. */
export interface ProfileDto {
  nickname: string;
  avatarId: string;
  level: number;
  /** Progress inside the current level. */
  exp: number;
  /** Experience needed to reach the next level (see expToNextLevel in game-config.ts). */
  expToNext: number;
}

/** `profile/info`: everything the HUD shows. */
export interface PlayerSnapshotDto {
  profile: ProfileDto;
  wallet: WalletDto;
  /** Profile screen statistics (battles, stars, crew, achievements); absent when the server has no stats reader. */
  stats?: PlayerStatsDto;
}
