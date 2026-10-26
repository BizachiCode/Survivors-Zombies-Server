// Access control of the admin panel: the panel is invisible (404) unless ADMIN_TOKEN is set and the caller's address is
// allowed; the API needs `Authorization: Bearer <ADMIN_TOKEN>` (constant-time comparison) and a caller that keeps
// failing is locked out per IP for a while. The token is never logged.

import { createHash, timingSafeEqual } from "node:crypto";

import type express from "express";

import { createLogger } from "../../shared/logger.js";
import { normalizeAddress } from "../../shared/rooms/client-address.js";

const log = createLogger("admin");

export type AdminGateOptions = {
  /** Empty = the admin routes are off. */
  token: string;
  /** Empty = any address. */
  allowedIps: readonly string[];
  /** Failed attempts allowed per address within the window. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_ADDRESSES = 10_000;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export class AdminGate {
  private readonly tokenDigest: Buffer;
  private readonly allowed: Set<string>;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AdminGateOptions) {
    this.tokenDigest = digest(options.token);
    this.allowed = new Set(options.allowedIps.map((ip) => normalizeAddress(ip)).filter((ip): ip is string => ip !== null));
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.token.length > 0;
  }

  /** Address of the caller as the audit trail and the limits see it. */
  static addressOf(req: express.Request): string {
    return normalizeAddress(req.ip ?? req.socket?.remoteAddress) ?? "unknown";
  }

  /** Static panel files: off (404) when disabled or the address is not allowed. No token needed to load the page. */
  readonly guardPage: express.RequestHandler = (req, res, next) => {
    if (!this.enabled || !this.addressAllowed(AdminGate.addressOf(req))) {
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    next();
  };

  /** API: address allow-list, lockout after repeated failures, then the bearer token. Sets `res.locals.adminIp`. */
  readonly guardApi: express.RequestHandler = (req, res, next) => {
    const ip = AdminGate.addressOf(req);
    if (!this.enabled || !this.addressAllowed(ip)) {
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");

    const lockedFor = this.lockedForMs(ip);
    if (lockedFor > 0) {
      res.setHeader("Retry-After", String(Math.ceil(lockedFor / 1000)));
      res.status(429).json({ ok: false, error: "ADMIN_RATE_LIMIT" });
      return;
    }
    if (!this.tokenMatches(req.headers.authorization)) {
      this.recordFailure(ip);
      res.status(401).json({ ok: false, error: "ADMIN_UNAUTHORIZED" });
      return;
    }
    res.locals.adminIp = ip;
    next();
  };

  private addressAllowed(ip: string): boolean {
    return this.allowed.size === 0 || this.allowed.has(ip);
  }

  private tokenMatches(header: string | undefined): boolean {
    const match = /^Bearer (.+)$/i.exec(header ?? "");
    if (!match) return false;
    return timingSafeEqual(digest(match[1].trim()), this.tokenDigest);
  }

  private lockedForMs(ip: string): number {
    const entry = this.failures.get(ip);
    if (!entry) return 0;
    const now = this.now();
    if (entry.resetAt <= now) {
      this.failures.delete(ip);
      return 0;
    }
    return entry.count >= this.maxFailures ? entry.resetAt - now : 0;
  }

  private recordFailure(ip: string): void {
    const now = this.now();
    if (this.failures.size >= MAX_TRACKED_ADDRESSES) {
      for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
      if (this.failures.size >= MAX_TRACKED_ADDRESSES) this.failures.clear();
    }
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= now) this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
    const count = this.failures.get(ip)!.count;
    if (count === this.maxFailures) log.warn(`${ip} locked out of the admin API after ${count} failed attempts`);
  }
}
