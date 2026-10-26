// Daily login calendar: one reward per UTC day, in order, looping after the last day. Missing a day doesn't reset it.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { RewardBundle, RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import { dayKey, nextDayMs } from "./objectives-content.js";
import type { ObjectiveRecorder } from "./objectives.service.js";
import type { ObjectivesRepository } from "./objectives.repository.js";

export type DailyDayDto = { day: number; reward: RewardBundle; state: "claimed" | "available" | "locked" };

export type DailyRewardsDto = {
  enabled: boolean;
  /** The cycle (days 1..N) the player is in; claimed days of it come first. */
  days: DailyDayDto[];
  /** Index (0-based) of the next day to claim in `days`. */
  next: number;
  claimedToday: boolean;
  resetsAtUnix: number;
};

export type DailyClaimDto = DailyRewardsDto & {
  granted: RewardBundle;
  levelsGained: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ReturnType<typeof toProfileDto>;
};

export class DailyRewardService {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly repository: ObjectivesRepository,
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly recorder: ObjectiveRecorder,
  ) {}

  private get days(): readonly RewardBundle[] {
    return this.catalog.progression?.dailyRewards ?? [];
  }

  async info(userId: string): Promise<DailyRewardsDto> {
    const row = await this.repository.getDaily(userId);
    return this.snapshot(row?.step ?? 0, row?.lastClaimDay ?? null);
  }

  async claim(userId: string): Promise<DailyClaimDto> {
    if (this.days.length === 0) throw new AppError(ErrorCode.OBJECTIVE_UNKNOWN);
    const today = dayKey(this.clock.nowMs());
    const outcome = await this.uow.transaction(async (session) => {
      const row = await this.repository.getDaily(userId, session, true);
      if (row?.lastClaimDay === today) throw new AppError(ErrorCode.DAILY_ALREADY_CLAIMED);
      const step = row?.step ?? 0;
      const reward = this.days[step % this.days.length];
      await this.repository.saveDaily({ userId, step: step + 1, lastClaimDay: today }, session);
      const { levelsGained } = await this.rewards.grant(session, userId, reward, "DAILY_REWARD");
      await this.recorder.record(session, userId, { daily_rewards_claimed: 1 });
      return { step: step + 1, reward, levelsGained };
    });
    const profile = await this.profiles.getProfile(userId);
    return {
      ...this.snapshot(outcome.step, today),
      granted: outcome.reward,
      levelsGained: outcome.levelsGained,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }

  /**
   * The current cycle. While today's reward is still to claim, the cycle is the one holding `step`; once claimed, it
   * stays on the cycle of the day just claimed (so the last day of a cycle shows as claimed until tomorrow).
   */
  private snapshot(step: number, lastClaimDay: string | null): DailyRewardsDto {
    const now = this.clock.nowMs();
    const length = this.days.length;
    if (length === 0) return { enabled: false, days: [], next: 0, claimedToday: false, resetsAtUnix: Math.floor(nextDayMs(now) / 1000) };
    const claimedToday = lastClaimDay === dayKey(now);
    const shown = claimedToday ? step - 1 : step; // the step the cycle is chosen from
    const cycleStart = Math.floor(Math.max(0, shown) / length) * length;
    const days: DailyDayDto[] = this.days.map((reward, index) => {
      const absolute = cycleStart + index;
      const state = absolute < step ? "claimed" : absolute === step && !claimedToday ? "available" : "locked";
      return { day: index + 1, reward, state };
    });
    return { enabled: true, days, next: Math.min(length - 1, Math.max(0, step - cycleStart)), claimedToday, resetsAtUnix: Math.floor(nextDayMs(now) / 1000) };
  }
}
