// App Store Server Notifications V2: Apple POSTs `{ "signedPayload": "<JWS>" }` to the URL configured in App Store
// Connect (App Information > App Store Server Notifications, Production and Sandbox URL: https://<host>/iap/apple/notifications).
// The JWS is verified exactly like a StoreKit 2 transaction (apple-jws.ts). REFUND and REVOKE take the purchase's grants
// back; every other valid notification is acknowledged and ignored. Answers: 200 for every valid notification (Apple
// retries anything else), 400 for a body or signature that does not verify, 500 when our own processing failed (Apple retries).

import type { X509Certificate } from "node:crypto";

import express from "express";

import { AppError } from "../../shared/errors/app-error.js";
import { createLogger } from "../../shared/logger.js";
import type { IapRefundService } from "./iap-refund.service.js";
import { appleTrustedRoots, verifyAppleJws } from "./validators/apple-jws.js";

const log = createLogger("apple-notifications");

/** ResponseBodyV2DecodedPayload (fields used). */
type NotificationPayload = {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string };
};

type TransactionPayload = {
  transactionId?: string;
  bundleId?: string;
  environment?: string;
  signedDate?: number;
};

export type AppleNotificationOptions = {
  bundleId: string;
  allowSandbox: boolean;
  /** DER roots to trust (tests use their own); default Apple Root CA - G3. */
  trustedRoots?: Buffer[];
};

export type AppleNotificationResult = { status: 200 | 400 | 500; error?: string };

export class AppleNotificationHandler {
  private readonly roots: X509Certificate[];

  constructor(private readonly options: AppleNotificationOptions, private readonly refunds: IapRefundService) {
    if (!options.bundleId) throw new Error("[iap] APPLE_BUNDLE_ID is required for App Store notifications.");
    this.roots = appleTrustedRoots(options.trustedRoots);
  }

  async handle(body: unknown): Promise<AppleNotificationResult> {
    const signedPayload = (body as { signedPayload?: unknown } | null)?.signedPayload;
    if (typeof signedPayload !== "string" || signedPayload.length === 0 || signedPayload.length > 64 * 1024) return { status: 400, error: "INVALID_BODY" };

    let notification: NotificationPayload;
    let transaction: TransactionPayload | null = null;
    try {
      notification = verifyAppleJws<NotificationPayload>(signedPayload, this.roots);
      const type = notification.notificationType;
      if ((type === "REFUND" || type === "REVOKE") && notification.data?.bundleId === this.options.bundleId) {
        const signedTransaction = notification.data.signedTransactionInfo;
        if (typeof signedTransaction !== "string") return { status: 400, error: "INVALID_BODY" };
        transaction = verifyAppleJws<TransactionPayload>(signedTransaction, this.roots);
      }
    } catch (error) {
      if (error instanceof AppError) return { status: 400, error: "INVALID_SIGNATURE" };
      throw error;
    }

    const type = notification.notificationType ?? "";
    if (notification.data?.bundleId !== this.options.bundleId) {
      log.warn(`notification ${type} for another app (${notification.data?.bundleId ?? "no bundle"}) ignored`);
      return { status: 200 };
    }
    if (type !== "REFUND" && type !== "REVOKE") return { status: 200 };

    const environment = notification.data?.environment ?? transaction?.environment;
    if (environment === "Sandbox" && !this.options.allowSandbox) return { status: 200 };
    if (!transaction?.transactionId || transaction.bundleId !== this.options.bundleId) {
      log.warn(`${type} notification without a transaction of this app ignored`);
      return { status: 200 };
    }

    try {
      const outcome = await this.refunds.refund("apple", transaction.transactionId, `apple_${type.toLowerCase()}`);
      if (outcome.status === "unknown") log.info(`${type} for transaction ${transaction.transactionId}: no such purchase recorded`);
      return { status: 200 };
    } catch (error) {
      log.error(`could not process ${type} of transaction ${transaction.transactionId}:`, error);
      return { status: 500, error: "SERVER_ERROR" };
    }
  }
}

/** Express router for the notification URL: `POST /` (mount it at `/iap/apple/notifications`). */
export function createAppleNotificationRouter(handler: AppleNotificationHandler, maxBodyBytes = 128 * 1024): express.Router {
  const router = express.Router();
  router.post("/", express.json({ limit: maxBodyBytes }), async (req, res) => {
    let result: AppleNotificationResult;
    try {
      result = await handler.handle(req.body);
    } catch (error) {
      log.error("notification failed:", error);
      result = { status: 500, error: "SERVER_ERROR" };
    }
    res.status(result.status).json(result.status === 200 ? { ok: true } : { ok: false, error: result.error });
  });
  // Malformed or oversized JSON bodies: a plain 400, never a stack trace.
  router.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
  });
  return router;
}
