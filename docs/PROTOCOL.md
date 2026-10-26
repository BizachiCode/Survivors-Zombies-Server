# Protocol

Colyseus 0.18 request/response: the client joins a room and calls `room.Request(type, payload)`; the server's handler
returns the answer. Every answer has `ok` (bool), and failures carry a stable `error` code (see
`src/shared/errors/error-codes.ts`, mapped on the client by `BackendErrors.FromServer`). Payloads are validated with
strict zod schemas: unknown keys are rejected. Identity never comes from a payload, only from the session.

## Room `auth` (anonymous)

One request type, `auth`, multiplexed by `type`. Rate limit: per IP (`AUTH_RATE_LIMIT`).

| `type` | Payload | Notes |
| --- | --- | --- |
| `device` | `deviceId` (8-128), `platform?`, `userAgent?` | Signs the device into its guest account; creates it (with its profile and wallet) on the first call. A device whose account linked an email gets a fresh guest. |
| `login` | `email`, `password`, `deviceId`, `platform?`, `userAgent?` | Accounts with a linked email (another device, reinstall). |
| `refresh` | `userId`, `refreshToken`, `deviceId`, `userAgent?` | Rotates the refresh token. The new access token keeps the session id, so joined rooms stay valid. |
| `logout` | `userId`, `refreshToken`, `deviceId` | Revokes the device's refresh token and session. Same answer whether or not the token matched. |

Success of `device`, `login` and `refresh`:

```json
{
  "action": "device", "ok": true,
  "userId": "uuid", "accessToken": "jwt", "accessExpiresAtUnix": 0, "refreshToken": "opaque",
  "account": { "userId": "uuid", "isGuest": true, "email": null, "createdAtUnix": 0 },
  "profile": { "nickname": "Player-12345", "avatarId": "avatar_zombie", "level": 1, "exp": 0, "expToNext": 100 },
  "wallet": { "coins": 0, "gems": 0 },
  "created": true, "serverTimeUnix": 0
}
```

`profile.exp` is the progress inside the current level and `expToNext` the experience that level needs. `wallet` has
every currency of `src/config/game-config.ts` (0 when the player has none); a new account starts with `START_COINS` /
`START_GEMS`.

Errors: `AUTH_INVALID_PAYLOAD`, `AUTH_UNKNOWN_ACTION`, `AUTH_RATE_LIMIT`, `AUTH_INVALID_CREDENTIALS`,
`AUTH_ACCOUNT_LOCKED`, `AUTH_BANNED` (`extra: { reason, until }`, until in unix seconds or null), `AUTH_INVALID_REFRESH`,
`MAINTENANCE`, `SERVER_ERROR`. Error answers are `{ action, ok: false, error, extra? }`.

## Authenticated rooms

Join option `accessToken` (from `auth`). The token is checked at matchmaking (`onAuth`: an invalid or expired token is
answered HTTP 401, the client renews it with `refresh` and joins again) and the session is re-checked on requests, so a
logout or a newer sign-in on the same device closes access within seconds (`UNAUTHORIZED`).

### Room `account`

One request type, `account`, multiplexed by `type`. Rate limits per account (`RATE_LIMIT`).

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | none | `{ account }` |
| `link_email` | `email`, `password` (8+) | `{ account }`. Guest → registered; removes the device binding (the account then opens with its refresh token or email + password). Errors: `ACCOUNT_NOT_GUEST`, `ACCOUNT_EMAIL_TAKEN`. |
| `change_password` | `currentPassword`, `newPassword` (8+) | `{ revokedDevices }`; signs the other devices out. Errors: `ACCOUNT_IS_GUEST`, `ACCOUNT_WRONG_PASSWORD`, `ACCOUNT_SAME_PASSWORD`, `AUTH_ACCOUNT_LOCKED`. |

### Room `profile`

One request type, `profile`, multiplexed by `type`. Rate limits per account: `info` 60/min, changes 10/min.

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | none | `{ profile, wallet, stats }` (what the HUD and the profile screen show; `profile` and `wallet` have the shapes of the `auth` answer). `stats`: `{ battlesPlayed, battlesWon, starsTotal, starsMax, stagesCleared, stagesTotal, crewOwned, crewTotal, bestCrewLevel, achievementsCompleted, achievementsTotal }`, read from the battle, collection and objectives tables (`src/modules/profile/profile-stats.ts`). |
| `set_nickname` | `nickname` | `{ profile }`. Trimmed; 3-16 characters, ASCII letters, digits, space, `_`, `.`, `-`, no double spaces; names are not unique. Errors: `PROFILE_NICKNAME_TOO_SHORT`, `PROFILE_NICKNAME_TOO_LONG`, `PROFILE_NICKNAME_INVALID_CHARS`, `PROFILE_NICKNAME_RESERVED`. |
| `set_avatar` | `avatarId` | `{ profile }`. One of `AVATAR_IDS` (`src/config/game-config.ts`). Error: `PROFILE_INVALID_AVATAR`. |

Error answers are `{ action, ok: false, error }`; an unknown `type` answers `{ action: "unknown", ok: false, error: "INVALID_PAYLOAD" }`.

## Languages

Texts of live content are a plain string or `{ en, pt?, es?, zh?, ja?, ko? }` (`zh` = Simplified Chinese). Requests that
return texts accept `lang` (`zh-Hans`, `ja-JP`, `pt-BR`... are normalized; unknown = English) and get one string back,
falling back to English. The battle room's join options take `lang` too (stage, arena and tower titles).

### Room `campaign`

One request type, `campaign`, multiplexed by `type`. Rate limit per account: 60/min.

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | `lang?` | `{ stages: [{ id, title, location, requiredLevel, prerequisites, unlocked, stars, wins }] }`, in content order; `title` in `lang` (English fallback; content titles are a string or `{ en, pt?, es?, zh?, ja?, ko? }`); `location` is the world map node the stage belongs to (empty: none). A stage is unlocked at its `requiredLevel` once every prerequisite has at least one star. |

### Room `battle` (authoritative, deterministic lockstep)

One room per battle: the client **creates** it (`client.Create("battle", { accessToken, mode, target })`; campaign
battles may still send `{ stageId }`). The server runs the
battle (`src/modules/battle/sim`, a port of the Unity core's `BattleSimulation`, checked bit for bit by
`test/battle_parity_test.ts`) and decides everything: which commands apply, when the battle ends, stars and rewards. The
client plays a replica (`BattleLockstep.cs`) that only advances to the ticks the server confirmed.

**Modes.** Every authoritative battle runs here; its **mode** (default `campaign`) decides who may play the **target**,
what runs and what the result grants (`src/modules/battle/battle-modes.ts`, `BattleService.registerMode`):

| Mode | Target | Grants |
| --- | --- | --- |
| `campaign` | stage id | Stars, stage progress, victory / first clear / defeat rewards. |
| `arena` | empty (the current season) | Spends a ticket; the score counts for the week (see room `arena`). Nothing directly. |
| `tower` | `towerId:floor` | The floor's reward on its first clear (see room `tower`). |

**Joining.** Matchmaking checks the token, then asks the mode: unknown stage / mode / tower → HTTP 404 (`STAGE_UNKNOWN`,
`BATTLE_MODE_UNKNOWN`, `TOWER_UNKNOWN`, `ARENA_DISABLED`), anything else refused (locked stage, no ticket, locked floor...)
→ HTTP 409 with the code (the code is the matchmaking error message; no room is created). Battle time does not run until the
client asks for `start`, so its message handlers exist before the first frame.

**Requests** (`room.Request`, answers `{ ok, error? }`):

| Type | Payload | Answer |
| --- | --- | --- |
| `start` | `{}` | `{ battleId, mode, target, stageId, title, threeStarSeconds, spec, contentHash, hashEvery, tick, speed, checkpoint }`, plus the mode's start info (arena: `arena: { seasonId, scoring, bestScore, league }`). `spec` is the battle as **JSON text** (C# `BattleSpec`: settings, seed, cards with ranks applied, enemies with the difficulty applied, waves, abilities): text keeps every number bit-exact. Build it, check `contentHash` (`BattleSimulation.ContentHash`), and restore `checkpoint` (JSON text of a C# `BattleCheckpoint`) when `tick > 0`. Starts battle time. |
| `cmd` | `{ kind: "place", id, lane, column }`, `{ kind: "upgrade" \| "remove", lane, column }`, `{ kind: "cast", id, lane }`, `{ kind: "pause" }`, `{ kind: "resume" }` | `{ tick }`: applied at that tick. Errors: `BATTLE_NOT_RUNNING`, `BATTLE_UNKNOWN_CARD`, `BATTLE_UNKNOWN_ABILITY`, `BATTLE_OUTSIDE_BOARD`, `BATTLE_OCCUPIED`, `BATTLE_COOLING_DOWN`, `BATTLE_INSUFFICIENT_ENERGY`, `BATTLE_NO_TARGET`, `BATTLE_REJECTED`, `INVALID_PAYLOAD`, `RATE_LIMIT` (10/s sustained, burst 40). |
| `speed` | `{ speed: 1 \| 2 }` | `{ speed }`. Battle seconds per real second; the change reaches the replica in the next frame. |
| `sync` | `{}` | `{ tick, speed, checkpoint }`: the full state. Pending frames are flushed first, so everything received before this answer is already in the checkpoint: restore it and drop what you had queued. Use it after a desync or a reconnection. Rate limit 20/min. |

**Messages** (server → client):

- `f` (frame, every 50 ms while something changed): `{ t, c?, h?, s? }`. `t` = tick the server reached; `c` = accepted
  commands `[[tick, kind, id, lane, column], ...]` in the order they were applied; `h` = state hashes
  `[[tick, hash], ...]` (`BattleSimulation.StateHash()`, every `hashEvery` ticks and at the final tick); `s` = new speed.
  Replica order per tick: step to the tick, compare its hash, then apply that tick's commands. A mismatch or a refused
  command means a desync: ask for `sync`.
- `result` (once, when the simulation ended and the result was recorded): `{ ok: true, battleId, stageId, outcome,
  stars, bestStars, firstClear, seconds, reward: { currencies, items, exp }, levelsGained, unlockedCards, profile, wallet,
  items }` or `{ ok: false, error }`. `reward.items` = collection items granted (seeds, upgrade XP, materials);
  `unlockedCards` = cards the battle unlocked (stage won, player level reached); `items` = the item balances after it.
  The room closes 30 s later.

**Lifecycle.** A dropped client has 60 s to reconnect (the SDK's automatic reconnection keeps the same room object);
battle time stands still meanwhile and resumes with the next `sync`. Leaving, failing to reconnect, pausing for more than
10 minutes, playing for more than an hour or starting another battle records the battle as `ABANDONED` (no reward).

**Cards.** When the content has a `collection` and the stage's encounter has `deckMode: "player"` (the default), the
battle is played with the player's team (room `collection`, `set_deck`) at its collection levels: each card's health,
damage and burn are multiplied by its curve's level multipliers, then the card's abilities reached at that level modify
its stats. Merging (the same card played on its own defender) is the `upgrade` command: it moves the defender to its
next in-battle level for that level's `upgradeCost`. `deckMode: "fixed"` (tutorials, puzzles) and content
without a collection use the encounter's `deck`. Joining with an empty team fails with `DECK_EMPTY`.

**Results.** Recorded once per battle id (`battle_results`, primary key): victory = 1 star + 1 if the base is untouched +
1 within the stage's `threeStarSeconds`; reward = victory reward (+ first clear bonus on the first win), the defeat
reward, or nothing when abandoned; currencies through `WalletLedger` (`STAGE_REWARD`), items through `InventoryLedger`
(`STAGE_REWARD`), experience with level ups, progress in `user_stage_progress`, then the collection's automatic unlocks. Rules: `src/modules/battle/battle-rules.ts` (mirrored by the Unity Offline backend's
`CampaignRules`).

**Content.** `content/battle-content.json` (path: `BATTLE_CONTENT_PATH`) is exported from Unity with
*Tools > Card Tower Defense > Export Server Content*; it is validated at boot (references, prerequisite cycles, every stage
must build). Restart the server after exporting.

### Room `collection`

The card collection (the Almanac / crew screen). One request type, `collection`, multiplexed by `type`. Rate limits per
account: `info` 60/min, changes 120/min (burst 30). Every answer that succeeds is the whole collection:

`{ action, ok: true, enabled, deckSize, deck, cards, items, wallet }`

- `enabled`: false when the content has no `collection` (battles use their encounter's deck; changes fail with
  `COLLECTION_DISABLED`).
- `deck`: the team, card ids in play order (1..`deckSize`).
- `items`: held items by id (absent = 0). `wallet`: balances (an unlock or upgrade may have spent some).
- `cards[]`: `{ id, name, role, cost, recharge, rarity, owned, level, maxLevel, health, damage, production, interval,
  range, next, abilities, unlock }`, in content order. `level` is 1 while not owned; the stats are the battle numbers at
  that level (curve multipliers and abilities applied). `next` (null when not owned or at the top) =
  `{ level, cost: [{ id, amount }], health, damage, production, interval, ability, affordable }`; a cost `id` is a
  currency or an item; `ability` names what the level brings. `abilities[]` = `{ level, name, description, unlocked }`:
  the card's own abilities (stat modifiers applied from their level on, in battles too). `unlock[]` = every way to get the card, each with `ready` (player methods: usable now; automatic
  ones: met): `{ method: "starter" }`, `{ method: "seeds", item, amount, wildItem, have, wildHave }`,
  `{ method: "stage", stage }`, `{ method: "purchase", currency, amount }`, `{ method: "level", level }`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | Applies the automatic unlocks first (starters + starting items for a new collection, cards of won stages and reached player levels, a first team). |
| `unlock` | `cardId`, `method: "seeds" \| "purchase"` | Seeds: spends `amount` of the card's seed item, the wild seed item covering what is missing (`ITEM_INSUFFICIENT`, `extra: { itemId, need, have }`). Purchase: debits the price (`WALLET_INSUFFICIENT_FUNDS`). The card joins the team while it has a free slot. Errors: `CARD_UNKNOWN`, `CARD_OWNED`, `CARD_UNLOCK_UNAVAILABLE` (the card has no such method). |
| `upgrade` | `cardId` | One level up, paying `next.cost` (currencies and items, all or nothing). Errors: `CARD_UNKNOWN`, `CARD_NOT_OWNED`, `CARD_MAX_LEVEL`, `WALLET_INSUFFICIENT_FUNDS`, `ITEM_INSUFFICIENT`. |
| `set_deck` | `cards: string[]` | Replaces the team: 1..`deckSize` owned cards, no duplicates (`DECK_INVALID`, `extra: { deckSize }`). |

Error answers are `{ action, ok: false, error, extra? }`. Rules: `src/modules/collection/collection.service.ts`
(mirrored by the Unity Offline backend's `CollectionRules`); content: `collection-content.ts`.

### Room `shop`

One request type, `shop`, multiplexed by `type`. Rate limits per account: `info` 60/min, purchases 60/min (burst 10).
Answers: `{ action, ok: true, enabled, offers, resetsAtUnix, wallet, items }`.

- `offers[]`: `{ id, name, price: { currency, amount }, grants: { currencies, items }, dailyLimit, requiredLevel, tag,
  remaining, available }`. `dailyLimit` 0 = unlimited (`remaining` null); limits reset at UTC midnight (`resetsAtUnix`).

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The offers with what is left today. |
| `buy` | `offerId` | Debits the price, credits the grants (currencies through `WalletLedger`, items through `InventoryLedger`, reason `SHOP_PURCHASE`) and counts the purchase, in one transaction. Errors: `SHOP_OFFER_UNKNOWN`, `SHOP_LOCKED` (`extra: { requiredLevel }`), `SHOP_LIMIT_REACHED` (`extra: { dailyLimit }`), `WALLET_INSUFFICIENT_FUNDS`, `SHOP_DISABLED` (no shop in the content). |

Rules: `src/modules/shop/shop.service.ts` (mirrored by the Unity Offline backend's `ShopRules`); content: `shop-content.ts`.

### Room `iap` (real-money purchases)

Products sold through Google Play / the App Store, from the content's `shop.products`. The client buys with the platform
store (Unity IAP), sends the receipt here, and confirms (consumes) the store order only after a successful answer, so a
paid purchase is never lost: orders the server could not verify stay unconfirmed and are sent again on the next launch.
One request type, `iap`, multiplexed by `type`. Rate limits per account: `info` 60/min (burst 20), `verify` 30/min (burst 10).

Answers: `{ action, ok: true, enabled, testMode, stores, products }`.

- `stores`: the stores this server verifies (`google`, `apple`, `fake`); `enabled: false` without products or stores.
- `testMode` (`IAP_TEST_MODE`): the client buys without the platform store and sends a test receipt of the `fake` store
  (`{ "Store": "fake", "TransactionID": "test-<guid>" }`); nothing is paid. For demo / QA servers, allowed in production.
- A product: `{ id, name, kind ("consumable" | "non_consumable"), storeIds: { google, apple }, grants: { currencies, items, exp },
  firstPurchaseBonus (empty once bought), limit (0 = unlimited; a non-consumable is 1), purchased, available, requiredLevel, tag,
  referencePrice }`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The products with the player's purchase counts. |
| `verify` | `store`, `productId`, `receipt` (Unity IAP unified receipt), `jws?` (StoreKit 2 `jwsRepresentation`) | Verifies the receipt, then in one transaction records the store transaction (unique per store) and grants the product (`grants` × quantity, plus `firstPurchaseBonus` on the account's first purchase of it) through `RewardGranter`, reason `IAP_PURCHASE`. Also answers `productId`, `orderId`, `alreadyProcessed`, `granted`, `levelsGained`, `wallet`, `items`, `profile`. |

**Verification** (`src/modules/iap/validators/`):
- `google`: the purchase JSON must be signed with the app's licensing key (`GOOGLE_PLAY_LICENSE_KEY`, RSA/SHA1) and/or
  known to the Google Play Developer API (`GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`, which also reports cancelled, pending and
  test purchases); `packageName` must be `GOOGLE_PLAY_PACKAGE_NAME`. The product comes from the receipt's `productId`;
  the replay key is the purchase token.
- `apple`: the JWS's `x5c` chain must end at Apple Root CA - G3 (pinned), every certificate must be signed by the next and
  valid at `signedDate`, the leaf / intermediate must carry Apple's signing OIDs and the ES256 signature must match; then
  `bundleId` = `APPLE_BUNDLE_ID`, no `revocationDate`, `environment` Production (or Sandbox while `APPLE_ALLOW_SANDBOX`).
  The product comes from the transaction's `productId`; the replay key is `transactionId`.
- `fake`: Unity's Editor store while `IAP_ALLOW_FAKE_STORE` (development; refused in production), and the test purchases
  while `IAP_TEST_MODE` (demo / QA servers, also in production). Its receipt does not name the product, so `productId` is used.
- Account binding: the client sets the Apple `appAccountToken` to the user id and the Google `obfuscatedAccountId` to
  sha256(user id); a receipt bound to another account answers `IAP_ACCOUNT_MISMATCH`, one without binding too while
  `IAP_REQUIRE_ACCOUNT_BINDING` (default).
- Replays: the same store transaction grants once. Sent again by the same account it answers `alreadyProcessed: true` (the
  client confirms the order); by another account, `IAP_ACCOUNT_MISMATCH`.
- A purchase over the product's `limit` (two devices at once) still grants (the money was taken), without the bonus.

Errors: `IAP_DISABLED`, `IAP_STORE_UNSUPPORTED`, `IAP_RECEIPT_INVALID`, `IAP_PENDING` (not paid yet: keep the order),
`IAP_PRODUCT_UNKNOWN`, `IAP_ACCOUNT_MISMATCH`, `SERVER_ERROR` (store API unreachable: retry later), `RATE_LIMIT`,
`INVALID_PAYLOAD`. Table `iap_purchases` (unique `store` + sha256 of the transaction id); rules in `iap.service.ts`.

### Room `wheel`

The lucky wheel. Segments, weights, free spins, the price of an extra spin and the daily limit come only from the
content (`content/battle-content.json`, optional `wheel` block, exported by Unity from the `WheelAsset` assigned in
`BackendSettings.wheel`). One request type, `wheel`, multiplexed by `type`. Rate limits per account: `info` 60/min
(burst 20), `spin` 30/min (burst 10). The client sends no amounts and no segment: the server draws the segment.

Info answer (`info`, and part of the `spin` answer): `{ action, ok: true, enabled, segments, freeSpinsLeft, spinsToday,
dailyLimit, spinCost, resetsAtUnix }`.

- `enabled`: false when the content has no wheel (then `segments` is empty).
- `segments[]`, in wheel order: `{ id, reward: { currencies, items, exp } }`. Weights are not sent.
- `freeSpinsLeft`: free spins left today (never more than what the daily limit still allows).
- `spinsToday` counts free and bought spins; `dailyLimit` 0 = unlimited.
- `spinCost`: `{ currency, amount }`, the price of a spin when no free spin is left; amount 0 = spins cannot be bought.
- `resetsAtUnix`: next UTC midnight (free spins and the daily limit reset then).

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The wheel and the player's spins of today. |
| `spin` | none | In ONE transaction: checks the daily limit, decides free or paid, draws the segment with `crypto.randomInt` over the weights, debits `spinCost` through `WalletLedger` when the spin is not free (reason `WHEEL_SPIN`), grants the segment's reward through `RewardGranter` (reason `WHEEL_SPIN`) and counts the spin (table `wheel_spins`, one row per player and UTC day, locked while spinning). Errors: `WHEEL_DISABLED` (no wheel in the content), `WHEEL_LIMIT_REACHED` (`extra: { dailyLimit }`), `WHEEL_NO_SPINS` (free spins used and spins cannot be bought), `WALLET_INSUFFICIENT_FUNDS` (`extra: { currencyId, need, have }`). |

`spin` answers the info fields (already updated for the spin) plus `segmentIndex` (index in `segments`), `segmentId`,
`granted` (the reward credited), `levelsGained`, `wallet`, `items` (item balances) and `profile`
`{ nickname, avatarId, level, exp, expToNext }`.

Errors: `{ action, ok: false, error, extra? }` (`action` is `unknown` for an unrecognised `type`), plus `INVALID_PAYLOAD`,
`RATE_LIMIT`, `UNAUTHORIZED`.

Content (`src/modules/wheel/wheel-content.ts`): `wheel: { segments: [{ id, weight >= 1, reward: { currencies, items, exp } }]
(2 to 12), freeSpinsPerDay = 1, spinCost: { currency = "gems", amount = 0 }, dailyLimit = 0 }`. Segment ids are unique,
rewards are not empty and item ids must exist in `items` (otherwise the content is rejected at boot). Rules in
`src/modules/wheel/wheel.service.ts`, mirrored by the Unity Offline backend (`OfflineBackendService.Wheel.cs`).

### Room `arena` (weekly arena)

Weekly arena from the content's `arena` (exported from the Unity `ArenaAsset`). Seasons run Monday 00:00 UTC to the
next Monday; the season id is that Monday (`YYYY-MM-DD`). A player's first match of a season puts them in a group of
their league (`groupSize` players, filled in order of arrival). Matches are battles of mode `arena` in the `battle` room:
each one spends a ticket at the start; the server scores it when it ends and keeps the player's best score of the week.
One request type, `arena`, multiplexed by `type`, with an optional `lang`. Rate limits per account: `info` 60/min (burst
20), `buy_ticket` 30/min (burst 10).

Answers: `{ action, ok: true, enabled, seasonId, startsAtUnix, endsAtUnix, title, league, leagues, tickets, maxTickets,
nextTicketAtUnix, ticketPrice, scoring, joined, bestScore, plays, rank, groupSize, group, lastSeason }`.

- `league`: `{ index, id, name, promote, demote, rewards: [{ fromRank, toRank, reward }] }` (the league the player competes
  in this season); `leagues`: every league `{ id, name }` in order.
- Tickets: one comes back every `regenMinutes` up to `maxTickets`; `nextTicketAtUnix` is 0 while full. Bought tickets go
  beyond the maximum.
- `group[]`: `{ rank, code, nickname, avatarId, level, score, me }`, best score first, ties to who reached it first.
- `lastSeason` (only on the answer that settled it): `{ seasonId, rank, groupSize, leagueBefore, leagueAfter, change
  ("promoted" | "demoted" | "stayed"), reward }`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | Settles the player's finished seasons first, then the arena. |
| `buy_ticket` | none | Debits `ticketPrice` (WalletLedger, reason `ARENA_TICKET`) and adds a ticket. Also answers `wallet`. Errors: `WALLET_INSUFFICIENT_FUNDS`, `ARENA_DISABLED` (no price). |

**Matches.** Join `battle` with `{ mode: "arena", target: "" }`; refused with `ARENA_NO_TICKETS` (`extra:
{ nextTicketAtUnix }`) or `ARENA_DISABLED`. Score = kills × `perKill` + waves reached × `perWave` + (victory ?
`victoryBonus` + base health left × `perBaseHealth` : 0); an abandoned match scores 0. The result carries `arena: { seasonId,
score, bestScore, newBest, rank, groupSize, league }`; matches grant nothing directly.

**End of season.** The first time a player comes back after the season ended (`info` or a match), the season is settled
once in a transaction: rank in the group → promotion (`rank <= promote`, not in the top league) or demotion (`rank >
max(promote, groupSize - demote)`, not in the first league), and the league's reward for that rank sent by mail (`MailService.send`,
expires after 30 days). Tables `arena_players` (league, tickets), `arena_groups`, `arena_entries` (season, group, best score,
settlement). Rules in `src/modules/arena/arena.service.ts`.

## Room `tower` (authenticated)

Event towers: a timed tower is a list of floors (1..50) climbed in order. Every floor is an
authoritative battle (an encounter with a difficulty) played in the `battle` room; the **first victory on the next
floor** raises the player's progress and grants that floor's reward (ledger reason `TOWER_REWARD`) in the battle's
result transaction. Replaying a cleared floor is allowed and grants nothing. Content: the `towers` array of
`battle-content.json` (Unity `TowerEventAsset`), validated at boot (`src/modules/tower/tower-content.ts`; every floor must
build). Progress: table `tower_progress` (`user_id`, `tower_id`, `highest_cleared`, `updated_at`).

One request type, `tower`, multiplexed by `type`. Rate limited per account like the other queries (`RATE_LIMIT`).

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | `lang?` (`en` / `pt` / `es` / `zh` / `ja` / `ko`) | `{ towers: Tower[] }`: the towers running now plus the ones that ended in the last 2 days (to show how far the player got), ordered by start. |

`Tower`:

```json
{
  "id": "kraken_tower", "title": "Kraken's Tower", "description": "...", "banner": "kraken",
  "startsAtUnix": 1760918400, "endsAtUnix": 1795996800, "running": true, "highestCleared": 3,
  "floors": [
    { "floor": 1, "title": "", "reward": { "currencies": { "coins": 100 }, "items": {}, "exp": 0 }, "cleared": true, "current": false, "locked": false },
    { "floor": 4, "title": "", "reward": { "currencies": {}, "items": { "plant_xp": 5 }, "exp": 20 }, "cleared": false, "current": true, "locked": false }
  ]
}
```

`floor` is 1-based; `title` is empty when the floor has no name (clients show "Floor N"); exactly one floor is
`current` (the next to clear) until the whole tower is cleared; floors above it are `locked`. `banner` is an art key the
Unity asset resolves.

### Playing a floor

Join the `battle` room with `{ mode: "tower", target: "<towerId>:<floor>" }` (floor 1-based, e.g. `kraken_tower:4`), then
the usual battle protocol (see `docs/PROTOCOL.md`). The `start` answer carries `tower: { towerId, floor, floors }`. The join
is refused with:

| Error | When |
| --- | --- |
| `TOWER_UNKNOWN` | Unknown tower, floor outside `1..floors`, or a malformed target. |
| `TOWER_NOT_RUNNING` | The tower has not started or has ended. |
| `TOWER_FLOOR_LOCKED` | The floor is above `highestCleared + 1`; `extra: { nextFloor }`. |

The battle `result` carries the usual fields (`stars` and `bestStars` are always 0, `stageId` is `tower:<id>:<floor>`;
`reward` is the floor reward when it was granted, else empty; `firstClear` is true when the floor was cleared for the first
time; the result does not count as a campaign stage clear) plus:

```json
{ "tower": { "towerId": "kraken_tower", "floor": 4, "floors": 10, "cleared": true, "highestCleared": 4 } }
```

`cleared` is true only for a victory on the floor right above the progress. A defeat or an abandoned battle never
changes the progress. A battle that started while the tower was running still settles after it ended.

### Room `objectives`

Daily and weekly missions, achievements and event goals from the `progression` block of `battle-content.json`
(exported by Unity with the battle content). One request type, `objectives`, multiplexed by `type`; every payload accepts
an optional `lang` (`en`, `pt`, `es`) for titles and descriptions. Rate limits per account: `info` 60/min (burst 20),
claims 120/min (burst 30).

Answers: `{ action, ok: true, enabled, daily, weekly, achievements, events, claimable }`.

- `daily` / `weekly`: `{ resetsAtUnix, objectives }`. Daily missions reset at UTC midnight, weekly ones on Monday 00:00 UTC.
- `achievements`: one row per chain (the first tier not claimed yet; a finished chain shows its last tier as claimed).
- `events[]`: `{ id, title, description, banner, startsAtUnix, endsAtUnix, objectives }`, only while the event runs.
- An objective: `{ id, kind, title, description, metric, target, progress, completed, claimed, reward: { currencies, items, exp }, tier, tiers }`
  (`progress` is capped at `target`; `tiers` is 1 outside achievement chains).
- `claimable`: completed and unclaimed objectives per list (`daily`, `weekly`, `achievements`, `events`), for the badges.
- `enabled: false` when the content has no progression.
- Claim answers also carry `granted` (the reward credited), `levelsGained`, `wallet`, `items` and `profile`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The lists above. |
| `claim` | `objectiveId` | Credits the reward (currencies, items, experience with level ups, reason `OBJECTIVE_REWARD`) and marks the objective claimed for its period, in one transaction. Errors: `OBJECTIVE_UNKNOWN`, `OBJECTIVE_INACTIVE` (event not running, level too low, or the previous tier of the chain is not claimed), `OBJECTIVE_NOT_COMPLETED` (`extra: { progress, target }`), `OBJECTIVE_CLAIMED`. |
| `claim_all` | optional `kind` (`daily`, `weekly`, `achievement`, `event`) | Claims every completed objective (of that kind) in one transaction; `granted` is the sum (empty when nothing was ready). Achievement tiers are claimed in order. |

**Progress is never sent by the client.** Gameplay features record metrics inside their own transactions
(`ObjectiveService.record`): the battle room (`battles_played`, `battles_won`, `stars_earned`, `stages_cleared`,
`enemies_killed`, `defenders_placed`, `merges`), the collection room (`cards_unlocked`, `cards_upgraded`, `coins_spent`, `gems_spent`),
the shop (`shop_purchases`, `coins_spent`, `gems_spent`) and the daily calendar (`daily_rewards_claimed`). A metric adds
to every active objective that counts it, in the objective's period: `D:yyyy-mm-dd` (daily), `W:<monday>` (weekly),
`E:<eventId>` (event, counted only between `startsAt` and `endsAt`) and `A` (achievements, forever). Table
`user_objectives` (`user_id`, `objective_id`, `period`, `progress`, `claimed_at`).

Content (`src/modules/objectives/objectives-content.ts`), `progression` in `battle-content.json`:
`{ objectives: [{ id, kind, title, description = "", metric, target, reward, event = "", group = "", tier = 1, requiredLevel = 0 }],
events: [{ id, title, description = "", banner = "", startsAt, endsAt }], dailyRewards: [reward, ...] }`. Texts are a
string or `{ en, pt?, es?, zh?, ja?, ko? }`; rewards are `{ currencies, items, exp }` and their item ids must exist in `items`.
Rules: `objectives.service.ts`, mirrored by the Unity Offline backend's `ObjectiveRules`.

### Room `daily`

The login calendar (`progression.dailyRewards`): one reward per UTC day claimed, looping after the last day. A missed day
does not reset the streak; the next claim simply gives the next day. One request type, `daily`, multiplexed by `type`;
rate limits shared with `objectives`.

Answers: `{ action, ok: true, enabled, days, next, claimedToday, resetsAtUnix }`.

- `days[]`: the current cycle, `{ day, reward, state }` with `state` `claimed`, `available` or `locked`; `next` is the
  index of the next day to claim; `resetsAtUnix` is the next UTC midnight.
- `claim` answers also carry `granted`, `levelsGained`, `wallet`, `items` and `profile`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The calendar. |
| `claim` | none | Credits today's reward (reason `DAILY_REWARD`), advances the step and records `daily_rewards_claimed`, in one transaction. Error: `DAILY_ALREADY_CLAIMED`. |

Table `user_daily_rewards` (`step`, `last_claim_day`); rules: `daily-rewards.service.ts`.

### Room `news`

Announcements from `content/news.json` (written by Unity's `Tools > Card Tower Defense > Export Live Content` or by
hand). The server re-reads the file when its modification time changes; a broken file is logged and the last good
content keeps being served. One request type, `news`, multiplexed by `type`. Rate limit per account: 60/min (burst 20).

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | optional `lang` (`en`, `pt`, `es`; `pt-BR` style tags are accepted, anything else is English) | `{ action: "info", ok: true, items }` |

- `items[]`: `{ id, title, body, image, url, publishedAtUnix, pinned }`, already in the requested language (a text
  without that translation falls back to English). Only published, non-expired items are listed: pinned first, then
  newest first. `image` is an art key the client maps to a sprite (may be empty); `url` is empty or `http(s)://`.
- Which items a player has seen is kept on the device.

Errors: `{ action: "info", ok: false, error }` with `INVALID_PAYLOAD`, `RATE_LIMIT`, `UNAUTHORIZED`.

Content (`src/modules/news/news-content.ts`): `{ items: [{ id, title, body, image = "", url = "", publishedAt, expiresAt?, pinned = false }] }`;
`title` / `body` are a string or `{ en, pt?, es?, zh?, ja?, ko? }`, dates are ISO 8601.

### Room `mail`

The player's inbox: broadcasts from `content/mail.json` (delivered once per player) plus mail sent by server features
(`MailService.send`: compensation, rewards). One request type, `mail`, multiplexed by `type`; every payload accepts an
optional `lang` like `news`. Rate limits per account: `info` 60/min (burst 20), the other types 120/min (burst 30).
Answers: `{ action, ok: true, mails, unread, claimable }`.

- `mails[]` (newest first): `{ id, title, body, sender, attachments: { currencies, items, exp }, sentAtUnix, expiresAtUnix, read, claimed }`.
  `expiresAtUnix` 0 = never. `unread` counts mails not read yet, `claimable` counts mails with unclaimed attachments.
  Expired and deleted mails are not listed.
- Claim answers (`claim`, `claim_all`) also carry the HUD state: `granted` (the reward credited), `levelsGained`,
  `wallet`, `items` (item balances) and `profile` `{ nickname, avatarId, level, exp, expToNext }`.

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | Delivers the active broadcasts the player has not received yet (each is copied into the inbox exactly once, even if the player deleted it), then lists the inbox. A broadcast is active between its `startsAt` and `endsAt`; the delivered mail expires `expiresAfterDays` later (0 = never). |
| `read` | `mailId` | Marks the mail read. Errors: `MAIL_UNKNOWN`, `MAIL_EXPIRED`. |
| `claim` | `mailId` | Credits the attachments (currencies, items, experience with level ups, reason `MAIL_ATTACHMENT`) all or nothing in one transaction and marks the mail claimed and read. Errors: `MAIL_UNKNOWN`, `MAIL_EXPIRED`, `MAIL_NO_ATTACHMENTS`, `MAIL_ALREADY_CLAIMED`. |
| `claim_all` | none | Claims every claimable mail in one transaction (one combined grant, `granted` is the sum). Error `MAIL_NO_ATTACHMENTS` when nothing is claimable. |
| `delete` | `mailId` | Removes a mail from the inbox (the row is kept, so a broadcast never comes back). Refused with `MAIL_UNCLAIMED` while the mail still has unclaimed attachments (expired mail can always be deleted). Errors: `MAIL_UNKNOWN`, `MAIL_UNCLAIMED`. |

Errors: `{ action, ok: false, error, extra? }` (`action` is `unknown` for an unrecognised `type`), plus `INVALID_PAYLOAD`,
`RATE_LIMIT`, `UNAUTHORIZED`. Attachments come only from the content file or from server code, never from the client.

Content (`src/modules/mail/mail-content.ts`): `{ broadcasts: [{ id, sender = "Pirate Cove", title, body, attachments = { currencies, items, exp },
startsAt?, endsAt?, expiresAfterDays = 30 }] }`; item ids in `attachments.items` must exist in `battle-content.json`
`items` (otherwise the whole file is rejected and the previous content stays). Table `user_mail` (unique on
`(user_id, broadcast_id)`); rules in `src/modules/mail/mail.service.ts`, mirrored by the Unity Offline backend.

### Room `ranking`

The leaderboards. One request type, `ranking`, joined with `{ accessToken }`. Rate limit per account: 60/min (burst 20).

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | `{ board: "stars" \| "level" \| "wins" }` | `{ action: "info", ok: true, board, top, me, refreshedAtUnix }` |

- `top[]` (at most 100): `{ rank, userId, nickname, avatarId, level, score }`. `userId` is the **public id**: the first 8 hex
  digits of the user id, upper case (the full id never leaves the server).
- `me`: the player's own row in the same shape, also when outside the top; `null` while the player has no score on the
  board (stars and wins = 0).
- Boards: `stars` = sum of the best stars of every stage (`user_stage_progress`); `level` = player level, then experience
  (the score shown is the level); `wins` = battles won (`battle_results` with outcome `VICTORY`).
- Order: score (for `level`: level then experience) desc, then level desc, then the older account. Ties share a rank:
  `rank` = 1 + the number of players with a strictly better score (the same rule for `top` and `me`).
- The top of each board is cached for 60 s (`refreshedAtUnix` = when it was computed); `me` is computed per request.
- Errors (`{ action, ok: false, error }`): `RANKING_UNKNOWN_BOARD`, `INVALID_PAYLOAD`, `RATE_LIMIT`.

Rules: `src/modules/ranking/ranking.service.ts`; queries: `ranking.repository.ts`.

### Room `chat`

The global chat. Join with `{ accessToken, channel: "global" }` (only `global` exists; any other channel is refused at
matchmaking with HTTP 400 `INVALID_PAYLOAD`). `filterBy(["channel"])` gives every channel its own rooms; up to 500
clients per room. Requests use the type `chat`:

| `type` | Payload | Answer |
| --- | --- | --- |
| `history` | `{}` | `{ action: "history", ok: true, messages }`: a system welcome line followed by the last 50 messages, oldest first. Subscribes the client to live messages. Rate limit 20/min. |
| `say` | `{ text }` | `{ action: "say", ok: true, message }`; the same message is broadcast to every subscribed client (the sender too). |

**Messages** (server → client): `message` = `{ id, userId, nickname, avatarId, level, text, atUnix, system }`. `id` is a
string, unique and growing inside the channel (`"0"` = the welcome line); `userId` is the public id (8 hex digits, empty on
system messages). Nickname, avatar and level are read from the sender's profile (cached 30 s).

**Subscription.** Nothing is pushed to a client until it asked for `history` (so its `message` handler exists), and a
client whose connection dropped has to ask for `history` again after the SDK reconnected it (a dropped client has 30 s).
Messages that arrive between the history snapshot and the first broadcast are never lost; a client that registers its
handler before requesting the history only has to de-duplicate by `id`.

**Rules for `say`** (`chat-config.ts`, `chat.service.ts`): the text is trimmed, whitespace collapsed and control /
invisible characters stripped; at most 140 characters. Listed words (whole words, any case) are replaced by `*`.
Rate: 1 message / 1.5 s with a burst of 3 per account. The same message (ignoring case) 3 times in a row mutes the
account for 60 s. Errors (`{ action, ok: false, error, extra? }`): `CHAT_INVALID_MESSAGE` (empty or too long),
`CHAT_MUTED` (`extra: { untilUnix }`), `RATE_LIMIT`, `INVALID_PAYLOAD`.

History and mutes live in the memory of the process: with several server processes each one has its own chat.

### Room `friends`

Friend list, requests, daily gifts and public player cards. Joined with `{ accessToken }`. One request type, `friends`,
multiplexed by `type`. Rate limits per account: `info` and `player` 60/min (burst 20), every other type 60/min (burst 20).
The Unity Offline backend answers `ONLINE_ONLY` (friends need other players), except `player` for the own code.

**Friend code** = the public id: the first 8 hex digits of the user uuid, upper case (`src/shared/kernel/public-id.ts`,
the same id rankings and chat show). A payload `code` is trimmed and case-insensitive. A code that is not 8 hex digits,
that matches no account, or that matches **more than one** account (a collision, about 1 in 4 billion per pair of
accounts) answers `PLAYER_NOT_FOUND`: nobody can be added by a colliding code.

Every change (`request`, `accept`, `decline`, `cancel`, `remove`, `send_gift`, `claim_gifts`) answers the fresh `info`
payload, so the client re-renders from one source. `info` answer (`{ action, ok: true, ... }`):

```json
{
  "myCode": "9F3A21BC",
  "friends": [{ "code": "1A2B3C4D", "nickname": "Ana", "avatarId": "avatar_zombie", "level": 7, "since": 1792000000,
                "giftSentToday": false, "giftWaiting": true, "lastSeenUnix": 1792100000 }],
  "incoming": [{ "code": "...", "nickname": "...", "avatarId": "...", "level": 1, "sentAtUnix": 0 }],
  "outgoing": [{ "code": "...", "nickname": "...", "avatarId": "...", "level": 1, "sentAtUnix": 0 }],
  "giftsWaiting": 3,
  "giftsCollectableToday": 3,
  "limits": { "maxFriends": 50, "maxIncoming": 50, "maxOutgoing": 30, "giftsPerDay": 10,
              "gift": { "currencies": { "coins": 20 }, "items": {}, "exp": 0 } }
}
```

- `friends[]` sorted by nickname. `since` = unix seconds the friendship started. `giftSentToday`: I already sent this friend
  today's (UTC) gift. `giftWaiting`: this friend sent me a gift I have not collected. `lastSeenUnix` is the account's
  last sign-in (`users.last_login_at`, not live presence) and is **absent** when the server has none.
- `incoming` / `outgoing` are the pending requests (oldest first). Requests older than 30 days are ignored and replaced
  by a new request.
- `giftsWaiting`: uncollected gifts (a gift waits 30 days at most). `giftsCollectableToday`: how many of them the daily
  collect cap still lets the player take now.
- `limits.gift` is what one gift is worth (a reward bundle, tunable in `src/modules/friends/friends-config.ts`).

| `type` | Payload | Effect |
| --- | --- | --- |
| `info` | none | The payload above. |
| `request` | `code` | Asks the owner of `code` to be friends. If that player already asked me, both become friends at once. Errors: `PLAYER_NOT_FOUND`, `FRIEND_SELF`, `FRIEND_ALREADY`, `FRIEND_REQUEST_PENDING` (I already asked), `FRIEND_LIMIT` (`extra: { max, which }`, `which` = `friends` (my list is full) / `target_friends` / `outgoing` (30 pending requests of mine) / `target_incoming` (their inbox of requests is full)). |
| `accept` | `code` | Accepts the request that player sent me. Errors: `FRIEND_REQUEST_UNKNOWN`, `FRIEND_LIMIT` (either list full). |
| `decline` | `code` | Declines the request that player sent me. Error `FRIEND_REQUEST_UNKNOWN`. |
| `cancel` | `code` | Takes back my own request to that player. Error `FRIEND_REQUEST_UNKNOWN`. |
| `remove` | `code` | Ends the friendship for both sides (gifts already sent stay collectable). Error `FRIEND_NOT_FRIENDS`. |
| `send_gift` | `code` | Sends a gift to a friend: once per friend per UTC day. Errors: `FRIEND_NOT_FRIENDS`, `FRIEND_SELF`, `FRIEND_GIFT_ALREADY_SENT`. The sender gets nothing; the amount is decided when the receiver collects. |
| `claim_gifts` | none | Collects the waiting gifts, oldest first, at most 10 per UTC day (the rest stay waiting). One transaction: a combined grant through `RewardGranter` (ledger reason `FRIEND_GIFT`) and the gifts marked collected. Answer = `info` plus `granted` (reward bundle credited), `claimed` (gifts collected), `levelsGained`, `wallet`, `items`, `profile` `{ nickname, avatarId, level, exp, expToNext }`. Error `FRIEND_NO_GIFTS` (nothing waiting, or the cap is reached today). |
| `player` | `code` | Public card of any player, the own one included: `{ code, nickname, avatarId, level, stats: { battlesWon, starsTotal, crewOwned, achievementsCompleted }, relation }`, `relation` = `self` / `friend` / `incoming` (they asked me) / `outgoing` (I asked them) / `none`. Error `PLAYER_NOT_FOUND`. |

Errors: `{ action, ok: false, error, extra? }` (`action` is `unknown` for an unrecognised `type`), plus `INVALID_PAYLOAD`,
`RATE_LIMIT`, `UNAUTHORIZED`. Full user ids never leave the server; the client only knows codes.

Tables (`src/infrastructure/database/schema/friends.schema.ts`):
- `user_friendships` (`user_a` < `user_b`, primary key on the pair: one row per friendship).
- `friend_requests` (`pair_key` = `<smaller id>:<larger id>` is the primary key: one pending request per pair whatever the
  direction; two players asking each other at once end up friends).
- `friend_gifts` (unique `(from_user_id, to_user_id, sent_day)`: one gift per friend per UTC day even under races;
  `claimed_day` counts towards the daily collect cap).

Concurrency: request / accept / remove / claim lock the `user_profile` rows of the players involved (in id order, so there
are no deadlocks) before reading counts, so the friend/request limits and the daily collect cap cannot be beaten by parallel
requests. Rules in `src/modules/friends/friends.service.ts`.

### Room `clan`

Clans (guilds): a player is in at most one clan; roles `leader`, `co_leader`, `member`; at most 30 members. One request
type, `clan`, multiplexed by `type` (the clan's own type travels as `clanType` because `type` is the action). Rate limits
per account: `info`, `search`, `view`, `ranking` are queries; everything else is a change (`RATE_LIMIT`). Config:
`src/modules/clans/clans-config.ts` (the limits are echoed to the client in every `info` as `limits`).

Clan data: `tag` (6 characters of an unambiguous base32, e.g. `QX7R2K`, unique; typed tags are case-insensitive, `#` and
the look-alikes O / I / L are normalized), `name` (3-20 characters, nickname character rules, unique ignoring case),
`description` (0-140), `badge` (`badge_01` .. `badge_12`), `clanType` (`open` | `request` | `closed`), `minLevel` (0-100).
The clan **score** is the sum of its members' campaign stars (computed, never stored; the ranking is cached for 60 s).

| `type` | Payload | Answer |
| --- | --- | --- |
| `info` | none | `ClanInfo` (below). |
| `search` | `query` (1-32) | `{ clans: ClanSummary[] }`: open / request clans whose name starts with the query, plus the clan with that exact tag. Never closed clans. |
| `create` | `name`, `description`, `badge`, `clanType`, `minLevel` | `ClanInfo` + `wallet`. Costs `limits.createCostCoins` coins (wallet ledger `CLAN_CREATE`); I become leader. Errors: `CLAN_ALREADY_MEMBER`, `CLAN_NAME_INVALID`, `CLAN_NAME_TAKEN`, `WALLET_INSUFFICIENT_FUNDS`. |
| `join` | `tag` | `ClanInfo`. `open` clan: I am a member at once; `request` clan: a join request is created (`pendingRequest`); one pending request per player. Errors: `CLAN_NOT_FOUND`, `CLAN_ALREADY_MEMBER`, `CLAN_CLOSED`, `CLAN_LEVEL_TOO_LOW` (`extra.minLevel`), `CLAN_FULL` (`extra.max`), `CLAN_REQUEST_PENDING`. Requests expire after 7 days. |
| `cancel_request` | none | `ClanInfo`. `CLAN_REQUEST_UNKNOWN` when none. |
| `accept` / `decline` | `code` (player code) | `ClanInfo`. Leader or co-leader; `CLAN_FORBIDDEN` for members, `CLAN_REQUEST_UNKNOWN`, `CLAN_FULL`. |
| `leave` | none | `ClanInfo` (no clan). A leaving leader passes the leadership to the oldest co-leader, else the oldest member; the last member leaving deletes the clan. |
| `kick` | `code` | `ClanInfo`. Leader kicks anyone; a co-leader kicks members only (`CLAN_FORBIDDEN`); `CLAN_NOT_MEMBER` for an unknown code. |
| `promote` | `code` | `ClanInfo`. Leader only: member -> co-leader; **promoting a co-leader hands the leadership over** (I become co-leader). |
| `demote` | `code` | `ClanInfo`. Leader only: co-leader -> member. |
| `edit` | `description`, `badge`, `clanType`, `minLevel` | `ClanInfo`. Leader or co-leader. The name is fixed. |
| `view` | `tag` | `{ clan: ClanCard }`: public card (any type) with the roster. |
| `ranking` | none | `{ top: ClanRankingEntry[] (100), me: ClanRankingEntry \| null, refreshedAtUnix }`. Ties share the best rank. |
| `request_donation` | `itemId` (`tokens.<card>`), `amount?` (1-10, default 10) | `ClanInfo`. I must be a member and own the card; wild tokens and other items are `CLAN_DONATION_UNKNOWN`, an unowned card `CARD_NOT_OWNED`. One request every 8 h (`CLAN_DONATION_LIMIT`, `extra.nextAtUnix`); a request also expires after 8 h. |
| `donate` | `code` (the requester) | `ClanInfo` + `wallet`, `items`, `rewardCoins`. Gives 1 token from my inventory to the requester and earns 10 coins, in one transaction (ledger reason `CLAN_DONATION`). Up to 5 per donor per request and 30 per donor per UTC day (`CLAN_DONATION_LIMIT`, `extra.nextAtUnix`); `CLAN_DONATION_UNKNOWN` (no open request / myself / not in my clan), `ITEM_INSUFFICIENT`. |

`ClanInfo`:

```json
{
  "action": "info", "ok": true, "myCode": "9F3A12BC",
  "clan": null,
  "pendingRequest": { "tag": "QX7R2K", "name": "Sea Wolves", "description": "", "badge": "badge_03", "type": "request", "minLevel": 0, "members": 3, "maxMembers": 30, "score": 12 },
  "recommended": [ { "...": "ClanSummary" } ],
  "donation": { "nextRequestAtUnix": 0, "donatedToday": 0 },
  "limits": { "maxMembers": 30, "createCostCoins": 1000, "nameMinLength": 3, "nameMaxLength": 20, "descriptionMaxLength": 140, "maxMinLevel": 100, "badges": 12,
              "donation": { "maxRequestAmount": 10, "requestCooldownHours": 8, "maxPerDonorPerRequest": 5, "maxPerDonorPerDay": 30, "rewardCoins": 10 } }
}
```

`clan` (when I am in one; `pendingRequest` and `recommended` are then empty) is a `ClanSummary`
(`tag, name, description, badge, type, minLevel, members, maxMembers, score`) plus:

```json
{ "id": "uuid", "channel": "clan:<id>", "createdAtUnix": 0, "rank": 1, "myRole": "leader",
  "roster": [ { "code": "9F3A12BC", "nickname": "Ana", "avatarId": "avatar_zombie", "level": 4, "role": "leader", "joinedAtUnix": 0, "lastSeenUnix": 0, "stars": 12 } ],
  "requests": [ { "code": "...", "nickname": "...", "avatarId": "...", "level": 1, "sentAtUnix": 0 } ],
  "donations": [ { "code": "...", "nickname": "Ana", "itemId": "tokens.anne", "cardId": "anne", "requested": 10, "received": 3,
                   "createdAtUnix": 0, "expiresAtUnix": 0, "mine": false, "myDonations": 1, "canDonate": true } ] }
```

`roster` is ordered leader, co-leaders, then members by stars. `requests` is only filled for leaders and co-leaders.
`rank` is cached for a minute. Member `code` is the public player id (the friend code, usable with the `friends` room
`player` request and in the Unity `UIPlayerCard`).

Errors (besides the generic ones): `CLAN_NOT_FOUND`, `CLAN_ALREADY_MEMBER`, `CLAN_NOT_MEMBER`, `CLAN_FULL`,
`CLAN_NAME_TAKEN`, `CLAN_NAME_INVALID`, `CLAN_LEVEL_TOO_LOW`, `CLAN_CLOSED`, `CLAN_FORBIDDEN`, `CLAN_REQUEST_PENDING`,
`CLAN_REQUEST_UNKNOWN`, `CLAN_DONATION_LIMIT`, `CLAN_DONATION_UNKNOWN`; invalid values answer `INVALID_PAYLOAD`.

#### Clan chat (room `chat`, channel `clan:<clanId>`)

The existing chat room (`filterBy(["channel"])`) now also serves `clan:<clanId>` (the `channel` field of
`clan.channel`). Join options: `accessToken`, `channel`. Membership is checked at matchmaking (a non-member is refused
with HTTP 403 `CLAN_NOT_MEMBER`) and again on `history` / `say` (at most every 5 s per client). Everything else is the
global chat protocol (`history`, `say`, `message` broadcasts, same spam / filter rules); the first history line is the
clan welcome, and joins / leaves / kicks / promotions are **system lines** (`system: true`, empty sender). A member who
leaves or is kicked receives an `evicted` message and is disconnected from the channel (close code 4000); when the clan
is deleted everybody is disconnected. The `global` channel is unchanged.

## Admin panel, admin API and purchase refunds (HTTP)

Both are plain HTTP on the same port as the game server (Express routes next to the Colyseus transport, see
`src/app/http.ts`). They are not Colyseus rooms: the game client never uses them.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | empty | Secret of the admin panel. **Empty = the panel is off** (`/admin` and `/admin/api/*` answer `404 NOT_FOUND` like unknown paths). When set it must have 32+ characters and not be a placeholder (`change-me...`), in every environment, or the server refuses to boot. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ADMIN_ALLOWED_IPS` | empty | Comma separated addresses allowed to reach the panel (empty = any). Others get `404`. Behind a reverse proxy set `TRUST_PROXY=true` (and `TRUSTED_PROXIES`) so the real address is seen. |
| `APPLE_BUNDLE_ID`, `APPLE_ALLOW_SANDBOX` | | Also enable the App Store notification URL (below). |
| `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` | | Both set = the Google voided purchases poller runs. |
| `GOOGLE_VOIDED_POLL_MINUTES` | `15` | Poll interval. |

Always serve the panel over HTTPS (the token travels in a header). Never put the token in a URL or share it in chat.

### Access rules

- Every `/admin/api/*` request needs `Authorization: Bearer <ADMIN_TOKEN>`. The comparison is constant time.
- A caller address with 10 failed attempts in 15 minutes is locked out of the API for the rest of that window
  (`429 ADMIN_RATE_LIMIT`, `Retry-After`), even with the right token afterwards.
- The static page (`/admin`) carries no secret and needs no token; it asks for the token and keeps it in
  `sessionStorage` (gone when the tab closes). Its Content-Security-Policy allows only same-origin scripts and styles.
- The token is never logged and never stored in `admin_audit`.

### Answers

`{ "ok": true, ...data }` or `{ "ok": false, "error": "CODE", "message"?, "issues"? }`. Status codes: `400` invalid
payload (`ADMIN_INVALID_PAYLOAD`, `issues: [{ path, message }]`), `401 ADMIN_UNAUTHORIZED`, `404` unknown route / player /
content id / purchase, `409` conflicts (duplicate content id, content file on disk invalid, a game error such as
`WALLET_INSUFFICIENT_FUNDS`), `413 PAYLOAD_TOO_LARGE`, `429 ADMIN_RATE_LIMIT`. Every payload is a strict zod schema
(unknown keys are rejected).

### API

`<id>` is a player's full user id (uuid). Search accepts the 8-hex public code, a nickname prefix, an email or a user id.

| Method and path | Payload | Notes |
| --- | --- | --- |
| `GET /admin/api/dashboard` | | `players { total, activeToday, activeWeek, newToday }` (active = `users.last_login_at`, days are UTC), `purchasesToday { total, refunded, byProduct[] }`, `server { version, nodeEnv, uptimeSec, maintenance, serverTimeUnix }`. |
| `GET /admin/api/meta` | | `{ currencies[], items[] }` for the panel's forms. |
| `GET /admin/api/players?q=` | | `{ players[] }` (max 20). |
| `GET /admin/api/players/<id>` | | Profile, ban, wallet, items, friends count, last 10 battles, last 30 purchases (with refund state) and the admin history of that player. |
| `POST /admin/api/players/<id>/adjust` | `{ mode: "grant" or "remove", currencies?: {id: n}, items?: {id: n}, note? }` | Through `WalletLedger` / `InventoryLedger`, reason `ADMIN`. `remove` takes only what the player has (never below zero) and answers `applied` and `shortfall`. Unknown items: `ADMIN_UNKNOWN_ITEM`. |
| `POST /admin/api/players/<id>/mail` | `{ title, body, sender?, attachments?, expiresInDays? }` | `MailService.send`. `title` / `body` are a string or `{ en, pt?, es?, zh?, ja?, ko? }`; `attachments` is `{ currencies, items, exp }`. |
| `POST /admin/api/players/<id>/ban` | `{ reason, until?: ISO date, durationHours? }` | No end = permanent. Sets `users.is_banned / ban_reason / ban_expires_at` and deletes the account's sessions (connected devices are kicked; login and refresh answer `AUTH_BANNED`). |
| `POST /admin/api/players/<id>/unban` | | |
| `POST /admin/api/refunds` | `{ store: "google", "apple" or "fake", transactionId, reason }` | Manual refund of a recorded purchase (below). Answer `refund { status: "refunded" or "already_refunded", taken, shortfall }`; `404 ADMIN_PURCHASE_NOT_FOUND`. |
| `GET` / `POST /admin/api/maintenance` | `{ enabled }` | In-memory override of `MAINTENANCE_MODE`, read by the `auth` room and `/health`. Lost on restart. |
| `GET /admin/api/audit?target=&limit=` | | Newest first. |
| `GET` / `POST` `/admin/api/news`, `PUT` / `DELETE` `/admin/api/news/<contentId>` | a news entry (`content/news.json` schema) | Lists / creates / replaces / removes one entry. The whole document is validated with the news schema and written atomically (temporary file + rename); the news service hot-reloads it. A file on disk that is already invalid is refused (`409 ADMIN_CONTENT_INVALID`). |
| the same on `/admin/api/mail-broadcasts` | a broadcast (`content/mail.json` schema) | Attachments with unknown items are refused. Copies already delivered to inboxes are not changed. |

#### Audit trail

Every mutating call writes a row of `admin_audit` (`created_at`, `ip`, `action`, `target`, `payload` JSON): `player.grant`,
`player.remove`, `player.mail`, `player.ban`, `player.unban`, `iap.refund`, `maintenance`, `news.create|update|delete`,
`mail_broadcast.create|update|delete`. Balance, mail and ban changes are written in the same transaction as the change.

### Purchase refunds

`iap_purchases` has `status` (`granted` or `refunded`), `refunded_at`, `refund_reason` and `refund_shortfall`
(`{ currencies, items, exp }`: what could not be taken back).

`IapRefundService.refund(store, transactionId, reason)`:

- idempotent: a purchase already `refunded` changes nothing; an unknown transaction answers `unknown`;
- debits what the purchase granted (`iap_purchases.granted`) from the wallet and the items up to the player's current
  balances (ledger reason `IAP_REFUND`, never negative). What was already spent is recorded in `refund_shortfall` and
  logged (warning). Experience and levels are never revoked (the granted `exp` is listed in the shortfall);
- sends the player a mail without attachments (in the six languages) saying the purchase was refunded.

Reasons: `apple_refund`, `apple_revoke`, `google_voided_src<source>_r<reason>`, `admin:<text>`.
A refunded receipt that the client sends again is answered as already processed and grants nothing.

#### App Store (Server Notifications V2)

Configure in App Store Connect > your app > App Information > App Store Server Notifications, both the Production and the
Sandbox URL:

```
https://<your host>/iap/apple/notifications
```

Version 2 notifications. `POST` body `{ "signedPayload": "<JWS>" }`. The JWS is verified exactly like a StoreKit 2
transaction (certificate chain to the pinned Apple Root CA - G3, ES256 signature, Apple's signing OIDs). `REFUND` and
`REVOKE` take the purchase back (`data.signedTransactionInfo` is verified too and must carry this app's `APPLE_BUNDLE_ID`);
every other valid notification (`TEST`, `DID_RENEW`, `REFUND_REVERSED`, ...), another app's notification and a
transaction the server never recorded are acknowledged and ignored. Answers: `200` for every valid notification,
`400` for a malformed body or a signature that does not verify, `500` when processing failed (Apple retries non-2xx).
The route exists only when `APPLE_BUNDLE_ID` is set. Sandbox notifications are ignored when `APPLE_ALLOW_SANDBOX=false`.

#### Google Play (Voided Purchases API)

The server polls `purchases.voidedpurchases.list` (in-app purchases) every `GOOGLE_VOIDED_POLL_MINUTES` (15) when
`GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` are set. The service account needs access to the app in
Play Console (Users and permissions: view financial data and manage orders; the same account that verifies purchases).
Each voided `purchaseToken` found in `iap_purchases` is refunded. The cursor lives in `server_settings`
(`google_voided_start_ms`); after a clean run it moves to "now minus one hour" so a voided purchase that Google reports
late is still seen (re-reading is harmless: refunds are idempotent). A run with a failed refund keeps the cursor and tries
again. The first run looks back 7 days; Google only keeps 30.

### Database

New tables `admin_audit` and `server_settings` (`src/infrastructure/database/schema/admin.schema.ts`) and new columns on
`iap_purchases` (`status`, `refunded_at`, `refund_reason`, `refund_shortfall`, index on `created_at`), all part of
`drizzle/0000_initial.sql`.

## Inventory

Items (card seeds, upgrade XP, materials) change only through `InventoryLedger`
(`src/modules/collection/inventory-ledger.ts`), like currencies through `WalletLedger`: inside the feature's
transaction, rows locked, all or nothing, one `item_ledger` row per item with its reason (`STAGE_REWARD`,
`STARTING_ITEMS`, `CARD_UNLOCK`, `CARD_UPGRADE`, `SHOP_PURCHASE`, `OBJECTIVE_REWARD`, `DAILY_REWARD`, `MAIL_ATTACHMENT`,
`IAP_PURCHASE`, `WHEEL_SPIN`, `FRIEND_GIFT`, `ADMIN`). Item ids must exist in the content's `items`.

## Wallet

Balances change only on the server, through `WalletLedger` (`src/modules/economy/wallet-ledger.ts`): credits and debits
run inside the feature's transaction, lock the touched rows, are all or nothing, and append a `currency_ledger` row per
currency with its reason (`STARTING_BALANCE`, `STAGE_REWARD`, `SHOP_PURCHASE`, `CARD_UNLOCK`, `CARD_UPGRADE`,
`OBJECTIVE_REWARD`, `DAILY_REWARD`, `MAIL_ATTACHMENT`, `IAP_PURCHASE`, `WHEEL_SPIN`, `FRIEND_GIFT`, `ADMIN`). No room
accepts an amount from the client; features (rewards, shop, objectives, mail, purchases) answer the new `wallet`. Rewards with experience go through `RewardGranter`
(`src/modules/economy/reward-granter.ts`), which credits currencies, items and experience (with level ups) together.
A debit beyond a balance fails with `WALLET_INSUFFICIENT_FUNDS` (`extra: { currencyId, need, have }`).
