// Refund pieces of the IAP module, built from the environment: the refund service (always), the App Store
// notification endpoint (when APPLE_BUNDLE_ID is set) and the Google voided-purchases poller (when
// GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_PLAY_SERVICE_ACCOUNT_FILE are set).

import type express from "express";

import type { Env } from "../../config/env.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { SettingsRepository } from "../admin/settings.repository.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger } from "../collection/inventory-ledger.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MailService } from "../mail/mail.service.js";
import { AppleNotificationHandler, createAppleNotificationRouter } from "./apple-notifications.js";
import { GoogleVoidedPurchasesPoller } from "./google-voided.poller.js";
import { IapRefundService } from "./iap-refund.service.js";
import type { IapRepository } from "./iap.repository.js";
import { GooglePlayApiClient, type GooglePlayVoidedApi } from "./validators/google-play-api.js";

export type IapRefundsDeps = {
  config: Env["iap"];
  catalog: BattleCatalog;
  purchases: IapRepository;
  settings: SettingsRepository;
  wallets: WalletLedger;
  inventory: InventoryLedger;
  mail: MailService;
  uow: UnitOfWork;
  clock: Clock;
  /** Test hooks. */
  googleApi?: GooglePlayVoidedApi;
  appleTrustedRoots?: Buffer[];
};

export type IapRefunds = {
  service: IapRefundService;
  /** null without APPLE_BUNDLE_ID. */
  apple: AppleNotificationHandler | null;
  /** Mount at `/iap/apple/notifications`; null without APPLE_BUNDLE_ID. */
  appleRouter: express.Router | null;
  /** null without a Google service account; call `start()` once the server listens. */
  googlePoller: GoogleVoidedPurchasesPoller | null;
};

export function createIapRefunds(deps: IapRefundsDeps): IapRefunds {
  const { config } = deps;
  const service = new IapRefundService(deps.catalog, deps.purchases, deps.wallets, deps.inventory, deps.mail, deps.uow, deps.clock);

  const apple = config.apple.bundleId
    ? new AppleNotificationHandler({ bundleId: config.apple.bundleId, allowSandbox: config.apple.allowSandbox, trustedRoots: deps.appleTrustedRoots }, service)
    : null;

  const googleApi = deps.googleApi ?? (config.google.packageName && config.google.serviceAccountFile ? GooglePlayApiClient.fromFile(config.google.serviceAccountFile) : null);
  const googlePoller = googleApi && config.google.packageName
    ? new GoogleVoidedPurchasesPoller(config.google.packageName, googleApi, service, deps.settings, deps.clock, config.google.voidedPollMinutes * 60_000)
    : null;

  return { service, apple, appleRouter: apple ? createAppleNotificationRouter(apple) : null, googlePoller };
}
