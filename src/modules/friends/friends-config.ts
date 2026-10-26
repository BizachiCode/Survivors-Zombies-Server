// Tunables of the friends feature (the Unity Offline backend answers ONLINE_ONLY: friends need other players).

import type { RewardBundle } from "../economy/reward-granter.js";

export type FriendsConfig = {
  maxFriends: number;
  /** Requests other players sent to one player. */
  maxIncoming: number;
  /** Requests one player sent and nobody answered yet. */
  maxOutgoing: number;
  /** What a friend gift is worth to the receiver (same shape as every reward, so it can grow items or exp). */
  gift: RewardBundle;
  /** Gifts a player can collect per UTC day; the rest stay waiting. */
  maxGiftsCollectedPerDay: number;
  /** Pending requests older than this are ignored and replaced by a new request. */
  requestTtlDays: number;
  /** Gifts that wait longer than this are gone. */
  giftTtlDays: number;
};

export const FRIENDS_CONFIG: FriendsConfig = Object.freeze({
  maxFriends: 50,
  maxIncoming: 50,
  maxOutgoing: 30,
  gift: { currencies: { coins: 20 }, items: {}, exp: 0 },
  maxGiftsCollectedPerDay: 10,
  requestTtlDays: 30,
  giftTtlDays: 30,
});
