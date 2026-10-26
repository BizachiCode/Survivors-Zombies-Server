// Grants a reward bundle (currencies, collection items, experience with level ups) inside the caller's transaction.
// Used by every feature that hands out rewards (objectives, daily rewards, mail attachments) so they all go through the
// ledgers the same way.

import { z } from "zod";

import { CURRENCY_IDS, type CurrencyId } from "../../config/game-config.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { InventoryLedger, ItemLedgerReason } from "../collection/inventory-ledger.js";
import { applyExperience } from "../profile/experience.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { LedgerReason, WalletLedger } from "./wallet-ledger.js";

const amount = z.number().int().min(1).max(1_000_000_000);

/** A reward in content files and answers: currencies, collection items (ids of the content's items) and experience. */
export const RewardBundleSchema = z.strictObject({
  currencies: z.partialRecord(z.enum(CURRENCY_IDS), amount).default({}),
  items: z.record(z.string(), amount).default({}),
  exp: z.number().int().min(0).max(1_000_000_000).default(0),
});

export type RewardBundle = { currencies: Partial<Record<CurrencyId, number>>; items: Record<string, number>; exp: number };

export const EMPTY_REWARD: RewardBundle = Object.freeze({ currencies: {}, items: {}, exp: 0 }) as RewardBundle;

export function isEmptyReward(reward: RewardBundle): boolean {
  return Object.keys(reward.currencies).length === 0 && Object.keys(reward.items).length === 0 && reward.exp <= 0;
}

/** Item ids of a reward that the content does not know (empty when valid). */
export function unknownRewardItems(reward: RewardBundle, knownItem: (itemId: string) => boolean): string[] {
  return Object.keys(reward.items).filter((itemId) => !knownItem(itemId));
}

export class RewardGranter {
  constructor(
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
  ) {}

  /** Credits everything in `reward` (all or nothing with the caller's transaction); returns the level ups. */
  async grant(session: DbSession, userId: string, reward: RewardBundle, reason: LedgerReason & ItemLedgerReason): Promise<{ levelsGained: number }> {
    if (Object.keys(reward.currencies).length > 0) await this.wallets.credit(session, userId, reward.currencies, reason);
    if (Object.keys(reward.items).length > 0) await this.inventory.credit(session, userId, { ...reward.items }, reason);
    if (reward.exp <= 0) return { levelsGained: 0 };
    const profile = await this.profiles.getProfile(userId, session, true);
    if (!profile) return { levelsGained: 0 };
    const levelled = applyExperience(profile.level, profile.exp, reward.exp);
    await this.profiles.updateLevel(userId, levelled.level, levelled.exp, session);
    return { levelsGained: levelled.levelsGained };
  }
}
