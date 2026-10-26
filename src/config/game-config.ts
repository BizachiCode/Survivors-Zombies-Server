// Game content the server enforces. The Unity project mirrors it (Core/Backend/Catalog and the Offline backend), so keep
// both sides in sync when a currency, an avatar or a rule changes.

/** Wallet currencies (`user_currencies.currency_id`). Balances are only changed by the server (see WalletLedger). */
export const CURRENCY_IDS = ["coins", "gems"] as const;
export type CurrencyId = (typeof CURRENCY_IDS)[number];

/** Ceiling of any balance: credits beyond it are clamped (keeps every amount a safe integer). */
export const MAX_BALANCE = 999_999_999_999;

export function isCurrencyId(value: string): value is CurrencyId {
  return (CURRENCY_IDS as readonly string[]).includes(value);
}

/** Avatars every player may pick (Unity: Res/Resources/AvatarCatalog). The first one is the default of new profiles. */
export const AVATAR_IDS = [
  "avatar_zombie",
  "avatar_skeleton",
  "avatar_vampire",
  "avatar_ghost",
  "avatar_keeper",
  "avatar_pumpkin",
  "avatar_cactus",
  "avatar_mushroom",
] as const;

export const DEFAULT_AVATAR_ID: string = AVATAR_IDS[0];

export function isAvatarId(value: string): boolean {
  return (AVATAR_IDS as readonly string[]).includes(value);
}

/**
 * Nicknames: 3-16 characters after trimming, ASCII letters, digits, space, `_`, `.` and `-`, no double spaces.
 * Names are not unique (the default is "Player-#####"). `reserved` blocks names that impersonate the staff.
 */
export const NICKNAME_RULES = {
  minLength: 3,
  maxLength: 16,
  allowed: /^[A-Za-z0-9 _.\-]+$/,
  reserved: /(admin|moderator|official|developer)/i,
} as const;

/** Experience needed to go from `level` to `level + 1` (`user_profile.exp` counts the progress inside the level). */
export function expToNextLevel(level: number): number {
  return 100 + 50 * (Math.max(1, level) - 1);
}
