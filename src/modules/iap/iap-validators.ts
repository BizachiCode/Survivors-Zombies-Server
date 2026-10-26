// Builds the receipt validators from the environment: each store is enabled only when it is configured.

import type { Env } from "../../config/env.js";
import { createLogger } from "../../shared/logger.js";
import { AppleAppStoreValidator } from "./validators/apple-app-store.validator.js";
import { FakeStoreValidator } from "./validators/fake-store.validator.js";
import { GooglePlayApiClient } from "./validators/google-play-api.js";
import { GooglePlayValidator } from "./validators/google-play.validator.js";
import type { ReceiptValidator } from "./validators/receipt.js";

const log = createLogger("iap");

export function createReceiptValidators(config: Env["iap"]): ReceiptValidator[] {
  const validators: ReceiptValidator[] = [];
  if (config.testMode) log.warn("IAP_TEST_MODE=true: real-money products are granted WITHOUT payment (demo / QA servers only).");
  if (config.allowFakeStore || config.testMode) validators.push(new FakeStoreValidator());
  const google = config.google;
  if (google.packageName && (google.licenseKey || google.serviceAccountFile)) {
    validators.push(new GooglePlayValidator({
      packageName: google.packageName,
      licenseKey: google.licenseKey,
      api: google.serviceAccountFile ? GooglePlayApiClient.fromFile(google.serviceAccountFile) : null,
    }));
  }
  if (config.apple.bundleId) validators.push(new AppleAppStoreValidator({ bundleId: config.apple.bundleId, allowSandbox: config.apple.allowSandbox }));
  log.info(`stores: ${validators.map((v) => v.store).join(", ") || "none (purchases disabled)"}`);
  return validators;
}
