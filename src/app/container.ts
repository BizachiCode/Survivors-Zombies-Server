// Composition root: builds repositories, services, limiters and the bound room classes from the configuration.

import type Redis from "ioredis";

import type { Env } from "../config/env.js";
import { RedisSessionStore } from "../infrastructure/cache/redis.js";
import type { Database } from "../infrastructure/database/drizzle.js";
import { DrizzleUnitOfWork } from "../infrastructure/database/drizzle-unit-of-work.js";
import { AccountRoom } from "../modules/account/account.room.js";
import { AccountService } from "../modules/account/account.service.js";
import { DrizzleAuthRepository } from "../modules/auth/auth.repository.js";
import { DrizzleBattleRepository } from "../modules/battle/battle.repository.js";
import { bindBattleRoom } from "../modules/battle/battle.room.js";
import { BattleService } from "../modules/battle/battle.service.js";
import { CampaignRoom } from "../modules/battle/campaign.room.js";
import { BattleCatalog } from "../modules/battle/content/battle-content.js";
import { DrizzleCollectionRepository, DrizzleInventoryRepository } from "../modules/collection/collection.repository.js";
import { CollectionRoom } from "../modules/collection/collection.room.js";
import { CollectionService } from "../modules/collection/collection.service.js";
import { InventoryLedger } from "../modules/collection/inventory-ledger.js";
import { createReceiptValidators } from "../modules/iap/iap-validators.js";
import { DrizzleIapRepository } from "../modules/iap/iap.repository.js";
import { IapRoom } from "../modules/iap/iap.room.js";
import { IapService } from "../modules/iap/iap.service.js";
import type { ReceiptValidator } from "../modules/iap/validators/receipt.js";
import { DrizzleAdminRepository } from "../modules/admin/admin.repository.js";
import { createAdminModule } from "../modules/admin/admin.module.js";
import { MaintenanceFlag } from "../modules/admin/maintenance.js";
import { DrizzleSettingsRepository } from "../modules/admin/settings.repository.js";
import { createIapRefunds } from "../modules/iap/iap-refunds.js";
import { DrizzleArenaRepository } from "../modules/arena/arena.repository.js";
import { DrizzleTowerRepository } from "../modules/tower/tower.repository.js";
import { TowerRoom } from "../modules/tower/tower.room.js";
import { TowerService } from "../modules/tower/tower.service.js";
import { configureChatChannelAccess } from "../modules/chat/chat.room.js";
import { createClanChatAccess, createClanChatPort } from "../modules/clans/clan-chat.js";
import { DrizzleClansRepository } from "../modules/clans/clans.repository.js";
import { ClanRoom } from "../modules/clans/clans.room.js";
import { ClansService } from "../modules/clans/clans.service.js";
import { ArenaRoom } from "../modules/arena/arena.room.js";
import { ArenaService } from "../modules/arena/arena.service.js";
import { DrizzleFriendsRepository } from "../modules/friends/friends.repository.js";
import { FriendsRoom } from "../modules/friends/friends.room.js";
import { FriendsService } from "../modules/friends/friends.service.js";
import { DrizzleWheelRepository } from "../modules/wheel/wheel.repository.js";
import { WheelRoom } from "../modules/wheel/wheel.room.js";
import { WheelService } from "../modules/wheel/wheel.service.js";
import { RewardGranter } from "../modules/economy/reward-granter.js";
import { DrizzleMailRepository } from "../modules/mail/mail.repository.js";
import { MailRoom } from "../modules/mail/mail.room.js";
import { MailService } from "../modules/mail/mail.service.js";
import { NewsRoom } from "../modules/news/news.room.js";
import { NewsService } from "../modules/news/news.service.js";
import { ChatProfileCache } from "../modules/chat/chat-profiles.js";
import { ChatRoom } from "../modules/chat/chat.room.js";
import { DrizzleChatHistoryStore, MemoryChatHistoryStore, RedisChatHistoryStore, type ChatHistoryStore } from "../modules/chat/chat-history.js";
import { ChatService } from "../modules/chat/chat.service.js";
import { DrizzleRankingRepository } from "../modules/ranking/ranking.repository.js";
import { RankingRoom } from "../modules/ranking/ranking.room.js";
import { RankingService } from "../modules/ranking/ranking.service.js";
import { ProfileStatsReader } from "../modules/profile/profile-stats.js";
import { DailyRewardService } from "../modules/objectives/daily-rewards.service.js";
import { DrizzleObjectivesRepository } from "../modules/objectives/objectives.repository.js";
import { DailyRoom, ObjectivesRoom } from "../modules/objectives/objectives.room.js";
import { ObjectiveService } from "../modules/objectives/objectives.service.js";
import { DrizzleShopRepository } from "../modules/shop/shop.repository.js";
import { ShopRoom } from "../modules/shop/shop.room.js";
import { ShopService } from "../modules/shop/shop.service.js";
import { AuthRoom } from "../modules/auth/auth.room.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { WalletLedger } from "../modules/economy/wallet-ledger.js";
import { DrizzleWalletRepository } from "../modules/economy/wallet.repository.js";
import { DrizzleProfileRepository } from "../modules/profile/profile.repository.js";
import { ProfileRoom } from "../modules/profile/profile.room.js";
import { ProfileService } from "../modules/profile/profile.service.js";
import { systemClock, type Clock } from "../shared/kernel/clock.js";
import { bindRoom } from "../shared/rooms/base-room.js";
import { AccessAuthenticator } from "../shared/security/access-authenticator.js";
import { Argon2PasswordHasher, HmacTokenHasher } from "../shared/security/password-hasher.js";
import { TokenBucketRateLimiter } from "../shared/security/rate-limiter.js";
import { MemorySessionStore, type SessionStore } from "../shared/security/session-store.js";
import { JwtAccessTokenService } from "../shared/security/token-service.js";

export type ContainerOptions = {
  config: Env;
  database: Database;
  /** Required when `config.sessionStore` or `config.chatHistoryStore` is "redis". */
  redis?: Redis;
  /** Battle content; loaded from `config.battleContentPath` when omitted. */
  catalog?: BattleCatalog;
  clock?: Clock;
  /** Receipt validators; built from `config.iap` when omitted. */
  iapValidators?: ReceiptValidator[];
};

/** Rate limits (token buckets). */
export const RATE_LIMITS = {
  /** Credential attempts per IP: 10 at once, then one every 3 s. */
  auth: { tokensPerInterval: 20, intervalMs: 60_000, burst: 10 },
  /** Requests per IP across authenticated rooms. */
  ip: { tokensPerInterval: 600, intervalMs: 60_000, burst: 120 },
  /** Room joins per account. */
  join: { tokensPerInterval: 60, intervalMs: 60_000, burst: 30 },
  /** account/info per account. */
  accountQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** account state changes / password checks per account. */
  account: { tokensPerInterval: 6, intervalMs: 60_000, burst: 6 },
  /** profile/info per account. */
  profileQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** Nickname / avatar changes per account. */
  profileChange: { tokensPerInterval: 10, intervalMs: 60_000, burst: 5 },
  /** campaign/info per account. */
  campaignQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** Battle commands (cmd, speed) per account: 10 per second sustained. */
  battleCommand: { tokensPerInterval: 600, intervalMs: 60_000, burst: 40 },
  /** Full-state resyncs per account. */
  battleSync: { tokensPerInterval: 20, intervalMs: 60_000, burst: 5 },
  /** collection/info per account. */
  collectionQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** Unlocks, upgrades and team changes per account. */
  collectionChange: { tokensPerInterval: 120, intervalMs: 60_000, burst: 30 },
  /** shop/info and purchases per account. */
  shopQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  shopBuy: { tokensPerInterval: 60, intervalMs: 60_000, burst: 10 },
  /** objectives/daily info and claims per account. */
  objectivesQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  objectivesClaim: { tokensPerInterval: 120, intervalMs: 60_000, burst: 30 },
  /** news/info, mail/info and mail changes per account. */
  newsQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  mailQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  mailChange: { tokensPerInterval: 120, intervalMs: 60_000, burst: 30 },
  /** ranking/info per account. */
  rankingQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** chat history requests per account (the join/leave of the chat page). */
  chatHistory: { tokensPerInterval: 20, intervalMs: 60_000, burst: 10 },
  /** iap/info per account. */
  iapQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** Receipt verifications per account (each may call a store API). */
  iapVerify: { tokensPerInterval: 30, intervalMs: 60_000, burst: 10 },
  /** wheel/info and wheel/spin per account. */
  wheelQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  wheelSpin: { tokensPerInterval: 30, intervalMs: 60_000, burst: 10 },
  /** friends/info and player cards; friend changes (requests, gifts). */
  friendsQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  friendsChange: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** arena/info; arena changes (ticket purchases). Matches are limited by the battle room. */
  arenaQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  arenaChange: { tokensPerInterval: 30, intervalMs: 60_000, burst: 10 },
  /** clan info / search / view / ranking; clan changes (join, donations, roles...). */
  clanQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  clanChange: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
  /** tower/info per account (floors are battles of the battle room). */
  towerQuery: { tokensPerInterval: 60, intervalMs: 60_000, burst: 20 },
} as const;

export function createContainer(options: ContainerOptions) {
  const { config, database } = options;
  const clock = options.clock ?? systemClock;

  const sessions: SessionStore = config.sessionStore === "redis"
    ? new RedisSessionStore(requireRedis(options.redis, "SESSION_STORE"), config.accessTtlMin)
    : new MemorySessionStore(config.accessTtlMin);
  const tokens = new JwtAccessTokenService(config.jwtAccessSecret, config.accessTtlMin);
  const passwords = new Argon2PasswordHasher(config.passwordPepper);
  const refreshHasher = new HmacTokenHasher(config.refreshPepper);
  const deviceHasher = new HmacTokenHasher(config.devicePepper);
  const uow = new DrizzleUnitOfWork(database);

  const repositories = {
    users: new DrizzleAuthRepository(database),
    profiles: new DrizzleProfileRepository(database),
    wallets: new DrizzleWalletRepository(database),
    battles: new DrizzleBattleRepository(database),
    cards: new DrizzleCollectionRepository(database),
    items: new DrizzleInventoryRepository(database),
    shop: new DrizzleShopRepository(database),
    objectives: new DrizzleObjectivesRepository(database),
    mail: new DrizzleMailRepository(database),
    ranking: new DrizzleRankingRepository(database),
    iap: new DrizzleIapRepository(database),
    wheel: new DrizzleWheelRepository(database),
    friends: new DrizzleFriendsRepository(database),
    arena: new DrizzleArenaRepository(database),
    admin: new DrizzleAdminRepository(database),
    settings: new DrizzleSettingsRepository(database),
    clans: new DrizzleClansRepository(database),
    tower: new DrizzleTowerRepository(database),
  };
  const catalog = options.catalog ?? BattleCatalog.fromFile(config.battleContentPath);

  const wallets = new WalletLedger(repositories.wallets, config.startingBalances);
  const inventory = new InventoryLedger(repositories.items, (itemId) => catalog.items.has(itemId));
  const rewards = new RewardGranter(wallets, inventory, repositories.profiles);
  const objectives = new ObjectiveService(catalog, repositories.objectives, rewards, wallets, inventory, repositories.profiles, uow, clock);
  const collection = catalog.collection
    ? new CollectionService(catalog, repositories.cards, inventory, wallets, repositories.profiles, repositories.battles, uow, objectives)
    : null;
  const stats = new ProfileStatsReader(catalog, repositories.battles, repositories.cards, repositories.objectives);
  const chatHistory: ChatHistoryStore = config.chatHistoryStore === "db" ? new DrizzleChatHistoryStore(database)
    : config.chatHistoryStore === "redis" ? new RedisChatHistoryStore(requireRedis(options.redis, "CHAT_HISTORY_STORE"))
    : new MemoryChatHistoryStore();
  const chat = new ChatService(clock, undefined, chatHistory);
  const mail = new MailService(config.mailContentPath, repositories.mail, rewards, wallets, inventory, repositories.profiles, uow, clock,
    (itemId) => catalog.items.has(itemId));
  const services = {
    auth: new AuthService(repositories.users, repositories.profiles, wallets, sessions, tokens, passwords, refreshHasher, deviceHasher, uow, clock, {
      refreshTtlDays: config.refreshTtlDays,
    }),
    accounts: new AccountService(repositories.users, passwords, sessions, uow, clock),
    profiles: new ProfileService(repositories.profiles, wallets, repositories.users, uow, stats),
    battles: new BattleService(catalog, repositories.battles, repositories.profiles, wallets, uow, inventory, collection, objectives),
    collection: collection ?? new CollectionService(catalog, repositories.cards, inventory, wallets, repositories.profiles, repositories.battles, uow, objectives),
    shop: new ShopService(catalog, repositories.shop, wallets, inventory, repositories.profiles, uow, clock, objectives),
    objectives,
    daily: new DailyRewardService(catalog, repositories.objectives, rewards, wallets, inventory, repositories.profiles, uow, clock, objectives),
    wallets,
    inventory,
    rewards,
    news: new NewsService(config.newsContentPath, clock),
    mail,
    ranking: new RankingService(repositories.ranking, clock),
    chat,
    chatProfiles: new ChatProfileCache(repositories.profiles, clock),
    iap: new IapService(catalog, repositories.iap, options.iapValidators ?? createReceiptValidators(config.iap), rewards, wallets, inventory,
      repositories.profiles, uow, clock, { requireAccountBinding: config.iap.requireAccountBinding, testMode: config.iap.testMode }),
    wheel: new WheelService(catalog, repositories.wheel, rewards, wallets, inventory, repositories.profiles, uow, clock),
    friends: new FriendsService(repositories.friends, repositories.profiles, rewards, wallets, inventory, stats, uow, clock),
    arena: new ArenaService(catalog, repositories.arena, wallets, mail, uow, clock),
    clans: new ClansService(repositories.clans, repositories.profiles, wallets, inventory, repositories.cards, catalog, createClanChatPort(chat), uow, clock),
    tower: new TowerService(catalog, repositories.tower, clock),
  };
  // A rename or a new avatar shows in the very next chat message (the chat caches who talks for 30 seconds).
  services.profiles.onProfileChanged((userId) => services.chatProfiles.forget(userId));
  // Clan chat channels (clan:<id>): the chat room's static onAuth asks the clans whether the player is a member.
  configureChatChannelAccess(createClanChatAccess(repositories.clans));
  // Battle modes besides the campaign: their battles run in the same `battle` room.
  services.battles.registerMode(services.arena.mode);
  services.battles.registerMode(services.tower.mode);

  // Runtime maintenance switch (admin panel), refunds of store purchases, and the admin API.
  const maintenance = new MaintenanceFlag(config.maintenanceMode);
  const iapRefunds = createIapRefunds({
    config: config.iap, catalog, purchases: repositories.iap, settings: repositories.settings, wallets, inventory, mail: services.mail, uow, clock,
  });
  const admin = createAdminModule({
    config, repo: repositories.admin, users: repositories.users, profiles: repositories.profiles, wallets, inventory, mail: services.mail,
    purchases: repositories.iap, refunds: iapRefunds.service, sessions, uow, clock, maintenance,
    knownItem: (itemId) => catalog.items.has(itemId), itemIds: () => [...catalog.items.keys()],
  });

  const limiters = {
    auth: new TokenBucketRateLimiter(RATE_LIMITS.auth),
    ip: new TokenBucketRateLimiter(RATE_LIMITS.ip),
    join: new TokenBucketRateLimiter(RATE_LIMITS.join),
    accountQuery: new TokenBucketRateLimiter(RATE_LIMITS.accountQuery),
    account: new TokenBucketRateLimiter(RATE_LIMITS.account),
    profileQuery: new TokenBucketRateLimiter(RATE_LIMITS.profileQuery),
    profileChange: new TokenBucketRateLimiter(RATE_LIMITS.profileChange),
    campaignQuery: new TokenBucketRateLimiter(RATE_LIMITS.campaignQuery),
    battleCommand: new TokenBucketRateLimiter(RATE_LIMITS.battleCommand),
    battleSync: new TokenBucketRateLimiter(RATE_LIMITS.battleSync),
    collectionQuery: new TokenBucketRateLimiter(RATE_LIMITS.collectionQuery),
    collectionChange: new TokenBucketRateLimiter(RATE_LIMITS.collectionChange),
    shopQuery: new TokenBucketRateLimiter(RATE_LIMITS.shopQuery),
    shopBuy: new TokenBucketRateLimiter(RATE_LIMITS.shopBuy),
    objectivesQuery: new TokenBucketRateLimiter(RATE_LIMITS.objectivesQuery),
    objectivesClaim: new TokenBucketRateLimiter(RATE_LIMITS.objectivesClaim),
    newsQuery: new TokenBucketRateLimiter(RATE_LIMITS.newsQuery),
    mailQuery: new TokenBucketRateLimiter(RATE_LIMITS.mailQuery),
    mailChange: new TokenBucketRateLimiter(RATE_LIMITS.mailChange),
    rankingQuery: new TokenBucketRateLimiter(RATE_LIMITS.rankingQuery),
    chatHistory: new TokenBucketRateLimiter(RATE_LIMITS.chatHistory),
    iapQuery: new TokenBucketRateLimiter(RATE_LIMITS.iapQuery),
    iapVerify: new TokenBucketRateLimiter(RATE_LIMITS.iapVerify),
    wheelQuery: new TokenBucketRateLimiter(RATE_LIMITS.wheelQuery),
    wheelSpin: new TokenBucketRateLimiter(RATE_LIMITS.wheelSpin),
    friendsQuery: new TokenBucketRateLimiter(RATE_LIMITS.friendsQuery),
    friendsChange: new TokenBucketRateLimiter(RATE_LIMITS.friendsChange),
    arenaQuery: new TokenBucketRateLimiter(RATE_LIMITS.arenaQuery),
    arenaChange: new TokenBucketRateLimiter(RATE_LIMITS.arenaChange),
    clanQuery: new TokenBucketRateLimiter(RATE_LIMITS.clanQuery),
    clanChange: new TokenBucketRateLimiter(RATE_LIMITS.clanChange),
    towerQuery: new TokenBucketRateLimiter(RATE_LIMITS.towerQuery),
  };

  const rooms = {
    auth: bindRoom(AuthRoom, { auth: services.auth, limiter: limiters.auth, isMaintenanceEnabled: () => maintenance.isEnabled() }),
    account: bindRoom(AccountRoom, { accounts: services.accounts, queryLimiter: limiters.accountQuery, accountLimiter: limiters.account }),
    profile: bindRoom(ProfileRoom, { profiles: services.profiles, queryLimiter: limiters.profileQuery, changeLimiter: limiters.profileChange }),
    campaign: bindRoom(CampaignRoom, { battles: services.battles, queryLimiter: limiters.campaignQuery }),
    battle: bindBattleRoom({ battles: services.battles, commandLimiter: limiters.battleCommand, syncLimiter: limiters.battleSync }),
    collection: bindRoom(CollectionRoom, { collection: services.collection, queryLimiter: limiters.collectionQuery, changeLimiter: limiters.collectionChange }),
    shop: bindRoom(ShopRoom, { shop: services.shop, queryLimiter: limiters.shopQuery, buyLimiter: limiters.shopBuy }),
    objectives: bindRoom(ObjectivesRoom, { objectives: services.objectives, queryLimiter: limiters.objectivesQuery, claimLimiter: limiters.objectivesClaim }),
    daily: bindRoom(DailyRoom, { daily: services.daily, queryLimiter: limiters.objectivesQuery, claimLimiter: limiters.objectivesClaim }),
    news: bindRoom(NewsRoom, { news: services.news, queryLimiter: limiters.newsQuery }),
    mail: bindRoom(MailRoom, { mail: services.mail, queryLimiter: limiters.mailQuery, changeLimiter: limiters.mailChange }),
    ranking: bindRoom(RankingRoom, { rankings: services.ranking, queryLimiter: limiters.rankingQuery }),
    chat: bindRoom(ChatRoom, { chat: services.chat, profiles: services.chatProfiles, historyLimiter: limiters.chatHistory }),
    iap: bindRoom(IapRoom, { iap: services.iap, queryLimiter: limiters.iapQuery, verifyLimiter: limiters.iapVerify }),
    wheel: bindRoom(WheelRoom, { wheel: services.wheel, queryLimiter: limiters.wheelQuery, spinLimiter: limiters.wheelSpin }),
    friends: bindRoom(FriendsRoom, { friends: services.friends, queryLimiter: limiters.friendsQuery, changeLimiter: limiters.friendsChange }),
    arena: bindRoom(ArenaRoom, { arena: services.arena, queryLimiter: limiters.arenaQuery, changeLimiter: limiters.arenaChange }),
    clan: bindRoom(ClanRoom, { clans: services.clans, queryLimiter: limiters.clanQuery, changeLimiter: limiters.clanChange }),
    tower: bindRoom(TowerRoom, { tower: services.tower, queryLimiter: limiters.towerQuery }),
  };

  return {
    config,
    catalog,
    sessions,
    repositories,
    services,
    limiters,
    rooms,
    maintenance,
    admin,
    iapRefunds,
    authenticator: new AccessAuthenticator(tokens, sessions),
  };
}

export type AppContainer = ReturnType<typeof createContainer>;

function requireRedis(redis: Redis | undefined, setting: string): Redis {
  if (!redis) throw new Error(`${setting}=redis needs a Redis client (createContainer({ redis })).`);
  return redis;
}
