// Tunables of the clans feature (the Unity Offline backend answers ONLINE_ONLY: clans need other players).
// Mirrored by the Unity client for display only (cost, member cap, limits arrive in every `info` answer as `limits`).

export const CLAN_TYPES = ["open", "request", "closed"] as const;
export type ClanType = (typeof CLAN_TYPES)[number];

export const CLAN_ROLES = ["leader", "co_leader", "member"] as const;
export type ClanRole = (typeof CLAN_ROLES)[number];

/** Emblem ids `badge_01` .. `badge_12` (sprites live in Unity: Res/Resources/ClanBadgeCatalog). */
export const CLAN_BADGE_COUNT = 12;
export const CLAN_BADGES: readonly string[] = Array.from({ length: CLAN_BADGE_COUNT }, (_, i) => `badge_${String(i + 1).padStart(2, "0")}`);

export type ClansConfig = {
  maxMembers: number;
  /** Coins a new clan costs (wallet ledger reason CLAN_CREATE). */
  createCostCoins: number;
  nameMinLength: number;
  nameMaxLength: number;
  descriptionMaxLength: number;
  maxMinLevel: number;
  /** Join requests older than this are ignored and replaced by a new request. */
  requestTtlDays: number;
  /** Clans listed by `search` / as recommendations. */
  searchLimit: number;
  recommendedLimit: number;
  /** Clans of the ranking (top N) and the cache of the top and of a clan's own standing. */
  rankingTopSize: number;
  rankingCacheSeconds: number;
  donation: {
    /** Most tokens one request asks for. */
    maxRequestAmount: number;
    /** A member can open a new request this long after the previous one (a request also expires after it). */
    requestCooldownHours: number;
    /** Donations one donor can make to a single request. */
    maxPerDonorPerRequest: number;
    /** Donations one donor can make per UTC day. */
    maxPerDonorPerDay: number;
    /** Coins the donor earns per donated token. */
    rewardCoins: number;
  };
};

export const CLANS_CONFIG: ClansConfig = Object.freeze({
  maxMembers: 30,
  createCostCoins: 1000,
  nameMinLength: 3,
  nameMaxLength: 20,
  descriptionMaxLength: 140,
  maxMinLevel: 100,
  requestTtlDays: 7,
  searchLimit: 20,
  recommendedLimit: 10,
  rankingTopSize: 100,
  rankingCacheSeconds: 60,
  donation: Object.freeze({
    maxRequestAmount: 10,
    requestCooldownHours: 8,
    maxPerDonorPerRequest: 5,
    maxPerDonorPerDay: 30,
    rewardCoins: 10,
  }),
});

/** Tags: 6 characters of Crockford base32 (no I, L, O, U), e.g. `QX7R2K`. */
export const CLAN_TAG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CLAN_TAG_LENGTH = 6;

/** Prefix of the chat channel of a clan (`clan:<clanId>`). */
export const CLAN_CHAT_PREFIX = "clan:";
export const clanChannel = (clanId: string) => `${CLAN_CHAT_PREFIX}${clanId}`;
export const clanIdOfChannel = (channel: string): string | null => (channel.startsWith(CLAN_CHAT_PREFIX) ? channel.slice(CLAN_CHAT_PREFIX.length) : null);
