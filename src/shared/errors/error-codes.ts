// Stable error codes sent to the client (`{ ok: false, error }`). The Unity client maps them to BackendCode and
// localized messages, so a code is never renamed once released; add new ones instead.

export const ErrorCode = {
  // Generic
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  UNAUTHORIZED: "UNAUTHORIZED",
  RATE_LIMIT: "RATE_LIMIT",
  SERVER_ERROR: "SERVER_ERROR",
  MAINTENANCE: "MAINTENANCE",

  // auth room
  AUTH_INVALID_PAYLOAD: "AUTH_INVALID_PAYLOAD",
  AUTH_UNKNOWN_ACTION: "AUTH_UNKNOWN_ACTION",
  AUTH_RATE_LIMIT: "AUTH_RATE_LIMIT",
  /** Wrong email or password (same answer for an unknown email). */
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  /** Too many wrong passwords in a row: wait and retry. */
  AUTH_ACCOUNT_LOCKED: "AUTH_ACCOUNT_LOCKED",
  /** `extra`: { reason, until } (until null = permanent). */
  AUTH_BANNED: "AUTH_BANNED",
  /** Unknown, expired or revoked refresh token: the client signs in again (device guest or email). */
  AUTH_INVALID_REFRESH: "AUTH_INVALID_REFRESH",

  // account room
  /** The action needs a guest account (link_email on an account that already has an email). */
  ACCOUNT_NOT_GUEST: "ACCOUNT_NOT_GUEST",
  /** The action is not available to guests (change_password). */
  ACCOUNT_IS_GUEST: "ACCOUNT_IS_GUEST",
  ACCOUNT_EMAIL_TAKEN: "ACCOUNT_EMAIL_TAKEN",
  ACCOUNT_WRONG_PASSWORD: "ACCOUNT_WRONG_PASSWORD",
  ACCOUNT_SAME_PASSWORD: "ACCOUNT_SAME_PASSWORD",

  // profile room (nickname rules in src/config/game-config.ts)
  PROFILE_NICKNAME_TOO_SHORT: "PROFILE_NICKNAME_TOO_SHORT",
  PROFILE_NICKNAME_TOO_LONG: "PROFILE_NICKNAME_TOO_LONG",
  /** Characters outside the allowed set, or double spaces. */
  PROFILE_NICKNAME_INVALID_CHARS: "PROFILE_NICKNAME_INVALID_CHARS",
  /** Impersonates the staff (admin, moderator...). */
  PROFILE_NICKNAME_RESERVED: "PROFILE_NICKNAME_RESERVED",
  /** Not one of the avatars the player may pick. */
  PROFILE_INVALID_AVATAR: "PROFILE_INVALID_AVATAR",

  // economy
  /** `extra`: { currencyId, need, have }. */
  WALLET_INSUFFICIENT_FUNDS: "WALLET_INSUFFICIENT_FUNDS",

  // campaign / battle (joining the `battle` room fails with these as the matchmaking error message)
  /** No stage with this id in the server's content. */
  STAGE_UNKNOWN: "STAGE_UNKNOWN",
  /** `extra`: { requiredLevel, prerequisites }. */
  STAGE_LOCKED: "STAGE_LOCKED",
  /** The battle's result was already recorded (internal: rewards are never granted twice). */
  BATTLE_ALREADY_FINISHED: "BATTLE_ALREADY_FINISHED",
  /** The battle is paused, over or waiting for its player to reconnect. */
  BATTLE_NOT_RUNNING: "BATTLE_NOT_RUNNING",
  BATTLE_UNKNOWN_CARD: "BATTLE_UNKNOWN_CARD",
  BATTLE_UNKNOWN_ABILITY: "BATTLE_UNKNOWN_ABILITY",
  BATTLE_OUTSIDE_BOARD: "BATTLE_OUTSIDE_BOARD",
  BATTLE_OCCUPIED: "BATTLE_OCCUPIED",
  BATTLE_COOLING_DOWN: "BATTLE_COOLING_DOWN",
  BATTLE_INSUFFICIENT_ENERGY: "BATTLE_INSUFFICIENT_ENERGY",
  /** A lane ability with nothing to affect. */
  BATTLE_NO_TARGET: "BATTLE_NO_TARGET",
  /** Upgrade / remove / pause / resume that changed nothing (no defender there, max level, already paused...). */
  BATTLE_REJECTED: "BATTLE_REJECTED",

  // collection (cards, items, team)
  /** The content has no card collection (every battle uses its encounter's deck). */
  COLLECTION_DISABLED: "COLLECTION_DISABLED",
  CARD_UNKNOWN: "CARD_UNKNOWN",
  CARD_OWNED: "CARD_OWNED",
  CARD_NOT_OWNED: "CARD_NOT_OWNED",
  CARD_MAX_LEVEL: "CARD_MAX_LEVEL",
  /** The card can't be unlocked with that method (it isn't one of its unlock methods). */
  CARD_UNLOCK_UNAVAILABLE: "CARD_UNLOCK_UNAVAILABLE",
  /** `extra`: { itemId, need, have }. */
  ITEM_INSUFFICIENT: "ITEM_INSUFFICIENT",
  /** `extra`: { deckSize }. 1..deckSize owned cards, no duplicates. */
  DECK_INVALID: "DECK_INVALID",
  /** The team has no owned card. */
  DECK_EMPTY: "DECK_EMPTY",
  /** The content has no shop. */
  SHOP_DISABLED: "SHOP_DISABLED",
  SHOP_OFFER_UNKNOWN: "SHOP_OFFER_UNKNOWN",
  /** The offer's purchases for today are used up (extra: dailyLimit). */
  SHOP_LIMIT_REACHED: "SHOP_LIMIT_REACHED",
  /** The player's level is below the offer's (extra: requiredLevel). */
  SHOP_LOCKED: "SHOP_LOCKED",

  // objectives (daily / weekly missions, achievements, events) and the daily login calendar
  OBJECTIVE_UNKNOWN: "OBJECTIVE_UNKNOWN",
  /** Progress below the target (extra: { progress, target }). */
  OBJECTIVE_NOT_COMPLETED: "OBJECTIVE_NOT_COMPLETED",
  OBJECTIVE_CLAIMED: "OBJECTIVE_CLAIMED",
  /** The objective's event is not running, or its level is not reached. */
  OBJECTIVE_INACTIVE: "OBJECTIVE_INACTIVE",
  /** Today's daily reward was already claimed. */
  DAILY_ALREADY_CLAIMED: "DAILY_ALREADY_CLAIMED",

  // mail (inbox with attachments)
  MAIL_UNKNOWN: "MAIL_UNKNOWN",
  MAIL_EXPIRED: "MAIL_EXPIRED",
  MAIL_ALREADY_CLAIMED: "MAIL_ALREADY_CLAIMED",
  MAIL_NO_ATTACHMENTS: "MAIL_NO_ATTACHMENTS",
  /** Deleting a mail whose attachments were not claimed. */
  MAIL_UNCLAIMED: "MAIL_UNCLAIMED",

  // ranking and chat
  RANKING_UNKNOWN_BOARD: "RANKING_UNKNOWN_BOARD",
  /** Empty, too long, or only filtered characters. */
  CHAT_INVALID_MESSAGE: "CHAT_INVALID_MESSAGE",
  /** The account may not chat right now (extra: { untilUnix }). */
  CHAT_MUTED: "CHAT_MUTED",

  // players and friends
  /** No player with that public id (friend code). */
  PLAYER_NOT_FOUND: "PLAYER_NOT_FOUND",
  FRIEND_SELF: "FRIEND_SELF",
  FRIEND_ALREADY: "FRIEND_ALREADY",
  /** A request between the two players is already waiting. */
  FRIEND_REQUEST_PENDING: "FRIEND_REQUEST_PENDING",
  FRIEND_REQUEST_UNKNOWN: "FRIEND_REQUEST_UNKNOWN",
  /** Friend list or pending requests full (extra: { max }). */
  FRIEND_LIMIT: "FRIEND_LIMIT",
  FRIEND_NOT_FRIENDS: "FRIEND_NOT_FRIENDS",
  /** A gift to this friend was already sent today. */
  FRIEND_GIFT_ALREADY_SENT: "FRIEND_GIFT_ALREADY_SENT",
  FRIEND_NO_GIFTS: "FRIEND_NO_GIFTS",

  // lucky wheel
  WHEEL_DISABLED: "WHEEL_DISABLED",
  /** No free spin left and spins can't be bought. */
  WHEEL_NO_SPINS: "WHEEL_NO_SPINS",
  /** Today's spins are used up (extra: { dailyLimit }). */
  WHEEL_LIMIT_REACHED: "WHEEL_LIMIT_REACHED",

  // in-app purchases (real money)
  IAP_DISABLED: "IAP_DISABLED",
  IAP_PRODUCT_UNKNOWN: "IAP_PRODUCT_UNKNOWN",
  /** The server is not configured for that store (or the fake store outside development). */
  IAP_STORE_UNSUPPORTED: "IAP_STORE_UNSUPPORTED",
  /** Signature, bundle, product or state check failed. */
  IAP_RECEIPT_INVALID: "IAP_RECEIPT_INVALID",
  /** The receipt belongs to another account. */
  IAP_ACCOUNT_MISMATCH: "IAP_ACCOUNT_MISMATCH",
  /** A limited product was already bought as many times as allowed (extra: { limit }). */
  IAP_LIMIT_REACHED: "IAP_LIMIT_REACHED",
  /** The store reports the purchase as not completed yet (pending payment). */
  IAP_PENDING: "IAP_PENDING",

  // battle modes
  /** The battle join asked for a mode the server doesn't run. */
  BATTLE_MODE_UNKNOWN: "BATTLE_MODE_UNKNOWN",

  // arena
  /** The content has no arena. */
  ARENA_DISABLED: "ARENA_DISABLED",
  /** No arena ticket left (extra: { nextTicketAtUnix }). */
  ARENA_NO_TICKETS: "ARENA_NO_TICKETS",

  // event towers
  TOWER_UNKNOWN: "TOWER_UNKNOWN",
  /** The tower's event window is closed. */
  TOWER_NOT_RUNNING: "TOWER_NOT_RUNNING",
  /** The previous floor is not cleared (extra: { nextFloor }). */
  TOWER_FLOOR_LOCKED: "TOWER_FLOOR_LOCKED",

  // clans
  CLAN_NOT_FOUND: "CLAN_NOT_FOUND",
  /** The player is already in a clan. */
  CLAN_ALREADY_MEMBER: "CLAN_ALREADY_MEMBER",
  CLAN_NOT_MEMBER: "CLAN_NOT_MEMBER",
  /** (extra: { max }) */
  CLAN_FULL: "CLAN_FULL",
  CLAN_NAME_TAKEN: "CLAN_NAME_TAKEN",
  CLAN_NAME_INVALID: "CLAN_NAME_INVALID",
  /** (extra: { minLevel }) */
  CLAN_LEVEL_TOO_LOW: "CLAN_LEVEL_TOO_LOW",
  /** The clan accepts no new members (or only by request). */
  CLAN_CLOSED: "CLAN_CLOSED",
  /** The player's role can't do this. */
  CLAN_FORBIDDEN: "CLAN_FORBIDDEN",
  CLAN_REQUEST_PENDING: "CLAN_REQUEST_PENDING",
  CLAN_REQUEST_UNKNOWN: "CLAN_REQUEST_UNKNOWN",
  /** Too many donation requests or donations (extra: { nextAtUnix }). */
  CLAN_DONATION_LIMIT: "CLAN_DONATION_LIMIT",
  CLAN_DONATION_UNKNOWN: "CLAN_DONATION_UNKNOWN",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
