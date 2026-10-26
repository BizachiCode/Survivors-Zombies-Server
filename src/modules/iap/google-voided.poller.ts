// Google Play has no refund webhook in this setup: the Voided Purchases API lists the purchases Google refunded,
// cancelled or charged back. This poller asks for them every few minutes (only when a service account is configured)
// and refunds each `purchaseToken` it finds in iap_purchases. Refunds are idempotent, so the window it re-reads is
// harmless: after a successful run the cursor (`google_voided_start_ms`, in server_settings) moves to "now minus an
// hour" so a voided purchase Google reports late is still seen. A failed run leaves the cursor and tries again.

import type { Clock } from "../../shared/kernel/clock.js";
import { createLogger } from "../../shared/logger.js";
import type { SettingsRepository } from "../admin/settings.repository.js";
import type { IapRefundService } from "./iap-refund.service.js";
import type { GooglePlayVoidedApi } from "./validators/google-play-api.js";

const log = createLogger("google-voided");

export const VOIDED_CURSOR_KEY = "google_voided_start_ms";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** First run: how far back to look. */
const FIRST_LOOKBACK_MS = 7 * DAY_MS;
/** Google only answers for the last 30 days. */
const MAX_LOOKBACK_MS = 29 * DAY_MS;
const MAX_PAGES = 50;

export type VoidedPollResult = { checked: number; refunded: number; failed: number };

export class GoogleVoidedPurchasesPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly packageName: string,
    private readonly api: GooglePlayVoidedApi,
    private readonly refunds: IapRefundService,
    private readonly settings: SettingsRepository,
    private readonly clock: Clock,
    private readonly intervalMs: number,
  ) {}

  /** Starts the periodic poll (first run after a short delay). */
  start(): void {
    if (this.timer) return;
    const run = () => {
      this.runOnce().catch((error) => log.error("poll failed:", error));
    };
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
    setTimeout(run, 30_000).unref();
    log.info(`polling Google Play voided purchases every ${Math.round(this.intervalMs / 60_000)} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Never overlaps with another; errors are logged and leave the cursor untouched. */
  async runOnce(): Promise<VoidedPollResult> {
    const result: VoidedPollResult = { checked: 0, refunded: 0, failed: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.clock.nowMs();
      const stored = Number(await this.settings.get(VOIDED_CURSOR_KEY));
      const start = Math.max(Number.isFinite(stored) && stored > 0 ? stored : now - FIRST_LOOKBACK_MS, now - MAX_LOOKBACK_MS);

      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { items, nextPageToken } = await this.api.listVoidedPurchases(this.packageName, start, pageToken);
        for (const voided of items) {
          result.checked++;
          try {
            const outcome = await this.refunds.refund("google", voided.purchaseToken, `google_voided_src${voided.voidedSource}_r${voided.voidedReason}`);
            if (outcome.status === "refunded") result.refunded++;
          } catch (error) {
            result.failed++;
            log.error(`could not refund voided purchase ${voided.orderId}:`, error);
          }
        }
        if (!nextPageToken) break;
        pageToken = nextPageToken;
      }

      if (result.failed === 0) await this.settings.set(VOIDED_CURSOR_KEY, String(Math.max(start, now - HOUR_MS)));
      return result;
    } finally {
      this.running = false;
    }
  }
}
