// Profile of the signed-in player: HUD snapshot (profile + wallet), nickname and avatar changes.

import { isAvatarId, NICKNAME_RULES } from "../../config/game-config.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { AuthRepository } from "../auth/auth.ports.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { PlayerSnapshotDto, ProfileDto } from "./profile.dto.js";
import { toProfileDto } from "./profile.mapper.js";
import type { ProfileRepository } from "./profile.repository.js";
import type { ProfileStatsReader } from "./profile-stats.js";

/**
 * Never allowed: control and format characters (terminal escapes, zero-width and direction marks), private-use and
 * unassigned code points, line / paragraph separators. Checked before the ASCII rule so the error stays meaningful if
 * a buyer widens `NICKNAME_RULES.allowed`.
 */
const NICKNAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** Returns the trimmed nickname, or throws the PROFILE_NICKNAME_* code of the first broken rule. */
export function validateNickname(raw: string): string {
  const value = (raw ?? "").trim();
  if (value.length < NICKNAME_RULES.minLength) throw new AppError(ErrorCode.PROFILE_NICKNAME_TOO_SHORT);
  if (value.length > NICKNAME_RULES.maxLength) throw new AppError(ErrorCode.PROFILE_NICKNAME_TOO_LONG);
  if (NICKNAME_FORBIDDEN.test(value) || !NICKNAME_RULES.allowed.test(value) || value.includes("  ")) {
    throw new AppError(ErrorCode.PROFILE_NICKNAME_INVALID_CHARS);
  }
  if (NICKNAME_RULES.reserved.test(value)) throw new AppError(ErrorCode.PROFILE_NICKNAME_RESERVED);
  return value;
}

export class ProfileService {
  private readonly changeListeners = new Set<(userId: string) => void>();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly wallets: WalletLedger,
    private readonly users: AuthRepository,
    private readonly uow: UnitOfWork,
    private readonly statsReader: ProfileStatsReader | null = null,
  ) {}

  /** Called after the player's nickname or avatar changed (caches of other features, e.g. the chat). Returns the unsubscribe. */
  onProfileChanged(listener: (userId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async info(userId: string): Promise<PlayerSnapshotDto> {
    const snapshot: PlayerSnapshotDto = { profile: await this.profile(userId), wallet: await this.wallets.snapshot(userId) };
    if (this.statsReader) snapshot.stats = await this.statsReader.stats(userId);
    return snapshot;
  }

  /** Renames the player (free; the room's rate limit throttles it). The change is audited with the old name. */
  async setNickname(userId: string, nickname: string): Promise<ProfileDto> {
    const next = validateNickname(nickname);
    await this.uow.transaction(async (session) => {
      const current = await this.profiles.getProfile(userId, session, true);
      if (!current) throw new AppError(ErrorCode.UNAUTHORIZED);
      if (current.nickname === next) return;
      await this.profiles.updateNickname(userId, next, session);
      await this.users.audit(userId, "NICKNAME_CHANGE", { from: current.nickname, to: next }, session);
    });
    this.changed(userId);
    return this.profile(userId);
  }

  async setAvatar(userId: string, avatarId: string): Promise<ProfileDto> {
    if (!isAvatarId(avatarId)) throw new AppError(ErrorCode.PROFILE_INVALID_AVATAR);
    await this.profiles.updateAvatar(userId, avatarId);
    this.changed(userId);
    return this.profile(userId);
  }

  private changed(userId: string): void {
    for (const listener of this.changeListeners) listener(userId);
  }

  private async profile(userId: string): Promise<ProfileDto> {
    const row = await this.profiles.getProfile(userId);
    if (!row) throw new AppError(ErrorCode.UNAUTHORIZED);
    return toProfileDto(row);
  }
}
