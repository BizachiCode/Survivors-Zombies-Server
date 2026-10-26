import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { ChatSender } from "./chat.service.js";

export const CHAT_PROFILE_TTL_SECONDS = 30;

/**
 * Nickname / avatar / level of the players who talk, read from their profile and cached for a short while. A nickname or
 * avatar change drops the cached entry at once (ProfileService.onProfileChanged → forget), so the next message shows it.
 */
export class ChatProfileCache {
  private readonly cache = new Map<string, { sender: ChatSender; expiresAtMs: number }>();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly clock: Clock,
    private readonly ttlSeconds = CHAT_PROFILE_TTL_SECONDS,
  ) {}

  async senderOf(userId: string): Promise<ChatSender> {
    const nowMs = this.clock.nowMs();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAtMs > nowMs) return cached.sender;

    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    const sender: ChatSender = { userId, nickname: profile.nickname, avatarId: profile.avatarId, level: profile.level };
    if (this.cache.size >= 5000) this.evictExpired(nowMs);
    this.cache.set(userId, { sender, expiresAtMs: nowMs + this.ttlSeconds * 1000 });
    return sender;
  }

  /** Drops the cached profile of the player (renamed, new avatar): the next message reads it again. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  private evictExpired(nowMs: number): void {
    for (const [userId, entry] of this.cache) if (entry.expiresAtMs <= nowMs) this.cache.delete(userId);
  }
}
