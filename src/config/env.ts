// Typed environment variables: the single source of truth for configuration.
// Production refuses to boot with missing/default secrets or with developer tools enabled.

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";
const isTest = nodeEnv === "test";

/** Values that must never reach production (shipped defaults / documentation placeholders). */
const INSECURE_SECRET_PATTERNS: RegExp[] = [/^change-me/i, /^replace-me/i, /^dev-/i, /^secret$/i, /^password$/i];
const MIN_PRODUCTION_SECRET_LENGTH = 16;
const MIN_ADMIN_TOKEN_LENGTH = 32;

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const value = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function list(key: string): string[] {
  return optional(key, "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function isInsecureSecret(value: string): boolean {
  return INSECURE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Reads a secret. In development a fallback is accepted (with a warning); in production the value
 * must be set, must not be a known default and must be at least 16 characters long.
 */
function secret(key: string, devFallback: string): string {
  const value = process.env[key];
  if (isProd) {
    if (!value) throw new Error(`[env] Missing required secret ${key} (production).`);
    if (isInsecureSecret(value)) throw new Error(`[env] ${key} uses a default/placeholder value; set a real secret before booting in production.`);
    if (value.length < MIN_PRODUCTION_SECRET_LENGTH) throw new Error(`[env] ${key} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`);
    return value;
  }
  if ((!value || isInsecureSecret(value)) && !isTest) console.warn(`[env] ${key} is using an insecure development value.`);
  return value || devFallback;
}

/** Where the chat history survives restarts: `db` (default), `redis` or `memory` (lost on restart). */
function chatHistoryStore(): "db" | "redis" | "memory" {
  const value = optional("CHAT_HISTORY_STORE", "db").trim().toLowerCase();
  if (value === "db" || value === "redis" || value === "memory") return value;
  throw new Error(`[env] CHAT_HISTORY_STORE must be db, redis or memory (got "${value}").`);
}

function devTools(): boolean {
  const requested = optionalBool("DEV_TOOLS", !isProd);
  if (requested && isProd) throw new Error("[env] DEV_TOOLS=true is not allowed when NODE_ENV=production.");
  return requested;
}

/** Unity's fake store (Editor purchases) grants real content: development only. */
function iapFakeStore(): boolean {
  const requested = optionalBool("IAP_ALLOW_FAKE_STORE", !isProd);
  if (requested && isProd) throw new Error("[env] IAP_ALLOW_FAKE_STORE=true is not allowed when NODE_ENV=production.");
  return requested;
}

/**
 * Admin panel token (`/admin`). Empty = the panel is off (its routes answer 404). A token that is set must be at least
 * 32 characters and not a placeholder, in every environment: it opens every player account.
 */
function adminToken(): string {
  const value = (process.env.ADMIN_TOKEN || "").trim();
  if (!value) return "";
  if (value.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`[env] ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters.`);
  if (isInsecureSecret(value)) throw new Error("[env] ADMIN_TOKEN uses a default/placeholder value; set a real secret.");
  return value;
}

export const env = {
  nodeEnv,
  isProd,
  isTest,
  port: optionalInt("PORT", 2567),

  // JWT access tokens (short lived) and opaque refresh tokens
  jwtAccessSecret: secret("JWT_ACCESS_SECRET", "change-me-access"),
  accessTtlMin: optionalInt("ACCESS_TTL_MIN", 15),
  refreshTtlDays: optionalInt("REFRESH_TTL_DAYS", 60),

  // Hashing peppers
  passwordPepper: secret("PASSWORD_PEPPER", "change-me-pepper"),
  refreshPepper: secret("REFRESH_PEPPER", "change-me-refresh-pepper"),
  devicePepper: secret("DEVICE_PEPPER", "change-me-device-pepper"),

  // MySQL / MariaDB
  mysql: {
    host: optional("MYSQL_HOST", "127.0.0.1"),
    port: optionalInt("MYSQL_PORT", 3306),
    user: optional("MYSQL_USER", "root"),
    password: optional("MYSQL_PASSWORD", ""),
    database: optional("MYSQL_DATABASE", "ctd_game_db"),
    connectionLimit: optionalInt("MYSQL_POOL_SIZE", 12),
  },
  dbAutoMigrate: optionalBool("DB_AUTO_MIGRATE", !isProd),

  // Active sessions
  sessionStore: (optional("SESSION_STORE", "redis") === "memory" ? "memory" : "redis") as "memory" | "redis",
  redis: {
    host: optional("REDIS_HOST", "127.0.0.1"),
    port: optionalInt("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: optionalInt("REDIS_DB", 0),
    keyPrefix: optional("REDIS_KEY_PREFIX", "ctd:"),
  },

  // Chat history kept between restarts (global and clan channels): db, redis or memory
  chatHistoryStore: chatHistoryStore(),

  // Transport / HTTP
  wsMaxPayloadBytes: optionalInt("WS_MAX_PAYLOAD_BYTES", 64 * 1024),
  httpMaxBodyBytes: Math.max(1024, optionalInt("HTTP_MAX_BODY_BYTES", 64 * 1024)),
  corsOrigins: list("CORS_ORIGINS"),
  /** true = behind a reverse proxy that sets x-forwarded-for (see shared/rooms/client-address.ts). */
  trustProxy: optionalBool("TRUST_PROXY", false),
  trustedProxies: list("TRUSTED_PROXIES"),

  // Economy: balances granted once to every new account (currencies in src/config/game-config.ts)
  startingBalances: {
    coins: Math.max(0, optionalInt("START_COINS", 0)),
    gems: Math.max(0, optionalInt("START_GEMS", 0)),
  },

  // Battle content exported from Unity (Tools > Card Tower Defense > Export Server Content), relative to the server folder
  battleContentPath: optional("BATTLE_CONTENT_PATH", "content/battle-content.json"),

  // Live content (Tools > Card Tower Defense > Export Live Content): announcements and mail broadcasts, hot-reloaded when the file changes
  newsContentPath: optional("NEWS_CONTENT_PATH", "content/news.json"),
  mailContentPath: optional("MAIL_CONTENT_PATH", "content/mail.json"),

  // In-app purchases (products in the content's shop.products). A store without settings is refused (IAP_STORE_UNSUPPORTED).
  iap: {
    allowFakeStore: iapFakeStore(),
    /**
     * Test purchases (demo servers, QA): every real-money product is granted without a store payment, on every platform
     * (the client skips Google Play / the App Store while the server says so). Allowed in production, with a warning.
     */
    testMode: optionalBool("IAP_TEST_MODE", false),
    /** Receipts must carry the buyer's account (Apple appAccountToken / Google obfuscatedAccountId, set by the client). */
    requireAccountBinding: optionalBool("IAP_REQUIRE_ACCOUNT_BINDING", true),
    google: {
      packageName: optional("GOOGLE_PLAY_PACKAGE_NAME", ""),
      /** Play Console > Monetization setup > licensing key (base64): verifies the purchase signature offline. */
      licenseKey: optional("GOOGLE_PLAY_LICENSE_KEY", ""),
      /** Service account JSON with access to the Google Play Developer API: also checks the purchase state online. */
      serviceAccountFile: optional("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE", ""),
      /** Minutes between two polls of the Voided Purchases API (refunds); only runs with a service account. */
      voidedPollMinutes: Math.max(1, optionalInt("GOOGLE_VOIDED_POLL_MINUTES", 15)),
    },
    apple: {
      bundleId: optional("APPLE_BUNDLE_ID", ""),
      /** Sandbox transactions (TestFlight, App Review) are accepted and recorded as such. */
      allowSandbox: optionalBool("APPLE_ALLOW_SANDBOX", true),
    },
  },

  // Admin panel and API (/admin): off unless ADMIN_TOKEN is set. ADMIN_ALLOWED_IPS (comma separated) narrows who may reach it.
  admin: {
    token: adminToken(),
    allowedIps: list("ADMIN_ALLOWED_IPS"),
  },

  devTools: devTools(),
  maintenanceMode: optionalBool("MAINTENANCE_MODE", false),
} as const;

export type Env = typeof env;
