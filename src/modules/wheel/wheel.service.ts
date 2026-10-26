// Lucky wheel use cases. The segment is drawn here (crypto RNG over the content's weights); the spin is counted, paid
// (when it is not a free one) and rewarded in ONE transaction, so a failed payment or grant never burns a spin.
// Everything comes from the content file; the client only asks to spin.

import { randomInt } from "node:crypto";

import type { CurrencyId } from "../../config/game-config.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { RewardBundle, RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileDto } from "../profile/profile.dto.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { WheelCatalog } from "./wheel-content.js";
import type { WheelRepository } from "./wheel.repository.js";

/** Uniform random integer in [0, maxExclusive). Injected so tests are deterministic. */
export type WheelRng = (maxExclusive: number) => number;

export const cryptoWheelRng: WheelRng = (maxExclusive) => randomInt(maxExclusive);

export type WheelInfoDto = {
  enabled: boolean;
  /** Wedges in wheel order (weights stay on the server). */
  segments: Array<{ id: string; reward: RewardBundle }>;
  /** Free spins left today (0 when the daily limit is reached). */
  freeSpinsLeft: number;
  spinsToday: number;
  /** 0 = unlimited. */
  dailyLimit: number;
  /** Price of a spin that is not free; amount 0 = cannot be bought. */
  spinCost: { currency: CurrencyId; amount: number };
  /** Next UTC midnight: free spins and the daily limit reset then. */
  resetsAtUnix: number;
};

export type WheelSpinDto = WheelInfoDto & {
  segmentIndex: number;
  segmentId: string;
  granted: RewardBundle;
  levelsGained: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ProfileDto;
};

/** UTC day of a moment, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class WheelService {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly days: WheelRepository,
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly rng: WheelRng = cryptoWheelRng,
  ) {}

  private get wheel(): WheelCatalog {
    const wheel = this.catalog.wheel;
    if (!wheel) throw new AppError(ErrorCode.WHEEL_DISABLED);
    return wheel;
  }

  async info(userId: string): Promise<WheelInfoDto> {
    const wheel = this.catalog.wheel;
    if (!wheel) {
      return { enabled: false, segments: [], freeSpinsLeft: 0, spinsToday: 0, dailyLimit: 0, spinCost: { currency: "gems", amount: 0 }, resetsAtUnix: this.resetsAt() };
    }
    return this.describe(wheel, await this.days.get(userId, utcDay(this.clock.nowMs())));
  }

  /** One spin: free while the day's allowance lasts, then for the price (if any), until the daily limit. */
  async spin(userId: string): Promise<WheelSpinDto> {
    const wheel = this.wheel;
    const day = utcDay(this.clock.nowMs());
    const outcome = await this.uow.transaction(async (session) => {
      const row = await this.days.lockDay(userId, day, session);
      if (wheel.dailyLimit > 0 && row.spins >= wheel.dailyLimit) {
        throw new AppError(ErrorCode.WHEEL_LIMIT_REACHED, { extra: { dailyLimit: wheel.dailyLimit } });
      }
      const free = row.freeSpins < wheel.freeSpinsPerDay;
      if (!free && wheel.spinCost.amount <= 0) throw new AppError(ErrorCode.WHEEL_NO_SPINS);

      const segmentIndex = wheel.segmentAt(this.rng(wheel.totalWeight));
      const segment = wheel.segments[segmentIndex];
      if (!free) await this.wallets.debit(session, userId, { [wheel.spinCost.currency]: wheel.spinCost.amount }, "WHEEL_SPIN");
      const { levelsGained } = await this.rewards.grant(session, userId, segment.reward, "WHEEL_SPIN");
      const next = { spins: row.spins + 1, freeSpins: row.freeSpins + (free ? 1 : 0) };
      await this.days.save(userId, day, next, session);
      return { segmentIndex, segment, levelsGained, next };
    });

    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    return {
      ...this.describe(wheel, outcome.next),
      segmentIndex: outcome.segmentIndex,
      segmentId: outcome.segment.id,
      granted: outcome.segment.reward,
      levelsGained: outcome.levelsGained,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }

  private describe(wheel: WheelCatalog, row: { spins: number; freeSpins: number }): WheelInfoDto {
    const room = wheel.dailyLimit > 0 ? Math.max(0, wheel.dailyLimit - row.spins) : Number.POSITIVE_INFINITY;
    return {
      enabled: true,
      segments: wheel.segments.map((segment) => ({ id: segment.id, reward: segment.reward })),
      freeSpinsLeft: Math.min(Math.max(0, wheel.freeSpinsPerDay - row.freeSpins), room),
      spinsToday: row.spins,
      dailyLimit: wheel.dailyLimit,
      spinCost: { currency: wheel.spinCost.currency, amount: wheel.spinCost.amount },
      resetsAtUnix: this.resetsAt(),
    };
  }

  private resetsAt(): number {
    const now = new Date(this.clock.nowMs());
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
  }
}
