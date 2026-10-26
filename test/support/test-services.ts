// Service graph of the server on top of the in-memory repositories (unit and protocol tests).

import { join } from "node:path";

import { AccountService } from "../../src/modules/account/account.service.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { BattleService } from "../../src/modules/battle/battle.service.js";
import { BattleCatalog } from "../../src/modules/battle/content/battle-content.js";
import { CollectionService } from "../../src/modules/collection/collection.service.js";
import { InventoryLedger } from "../../src/modules/collection/inventory-ledger.js";
import { RewardGranter } from "../../src/modules/economy/reward-granter.js";
import { WalletLedger, type CurrencyAmounts } from "../../src/modules/economy/wallet-ledger.js";
import { ProfileService } from "../../src/modules/profile/profile.service.js";
import { ShopService } from "../../src/modules/shop/shop.service.js";
import { DailyRewardService } from "../../src/modules/objectives/daily-rewards.service.js";
import { ObjectiveService } from "../../src/modules/objectives/objectives.service.js";
import { MemoryObjectivesRepository } from "./memory-objectives.js";
import { fixedClock, systemClock, type Clock } from "../../src/shared/kernel/clock.js";
import { AccessAuthenticator } from "../../src/shared/security/access-authenticator.js";
import { Argon2PasswordHasher, HmacTokenHasher } from "../../src/shared/security/password-hasher.js";
import { MemorySessionStore } from "../../src/shared/security/session-store.js";
import { JwtAccessTokenService } from "../../src/shared/security/token-service.js";
import {
  MemoryAuthRepository, MemoryBattleRepository, MemoryCollectionRepository, MemoryInventoryRepository, MemoryProfileRepository, MemoryShopRepository,
  MemoryStore, MemoryUnitOfWork, MemoryWalletRepository,
} from "./memory-repositories.js";

/** Small campaign whose battles end within about a second (test/fixtures/battle-content.test.json). */
export const TEST_CONTENT_PATH = join(__dirname, "..", "fixtures", "battle-content.test.json");

export type TestServiceOptions<C extends Clock> = {
  clock?: C;
  startingBalances?: CurrencyAmounts;
  catalog?: BattleCatalog;
};

export function createTestServices<C extends Clock = Clock>(options: TestServiceOptions<C> = {}) {
  const clock = (options.clock ?? systemClock) as C;
  const store = new MemoryStore();
  const users = new MemoryAuthRepository(store, clock.nowMs);
  const profileRepository = new MemoryProfileRepository(store);
  const wallets = new WalletLedger(new MemoryWalletRepository(store), options.startingBalances ?? {});
  const sessions = new MemorySessionStore(15, clock.nowMs);
  const tokens = new JwtAccessTokenService("test-access-secret-0123456789", 15);
  const passwords = new Argon2PasswordHasher("test-pepper");
  const uow = new MemoryUnitOfWork(store);
  const auth = new AuthService(users, profileRepository, wallets, sessions, tokens, passwords, new HmacTokenHasher("refresh"), new HmacTokenHasher("device"), uow, clock, {
    refreshTtlDays: 60,
  });
  const accounts = new AccountService(users, passwords, sessions, uow, clock);
  const profiles = new ProfileService(profileRepository, wallets, users, uow);
  const catalog = options.catalog ?? BattleCatalog.fromFile(TEST_CONTENT_PATH);
  const battleRepository = new MemoryBattleRepository(store);
  const inventory = new InventoryLedger(new MemoryInventoryRepository(store), (itemId) => catalog.items.has(itemId));
  const rewards = new RewardGranter(wallets, inventory, profileRepository);
  const objectivesRepository = new MemoryObjectivesRepository();
  const objectives = new ObjectiveService(catalog, objectivesRepository, rewards, wallets, inventory, profileRepository, uow, clock);
  const daily = new DailyRewardService(catalog, objectivesRepository, rewards, wallets, inventory, profileRepository, uow, clock, objectives);
  const collection = new CollectionService(catalog, new MemoryCollectionRepository(store), inventory, wallets, profileRepository, battleRepository, uow, objectives);
  const battles = new BattleService(catalog, battleRepository, profileRepository, wallets, uow, inventory, catalog.collection ? collection : null, objectives);
  const shop = new ShopService(catalog, new MemoryShopRepository(store), wallets, inventory, profileRepository, uow, clock, objectives);
  const authenticator = new AccessAuthenticator(tokens, sessions);
  return {
    clock, store, users, uow, wallets, sessions, auth, accounts, profiles, profileRepository, catalog, battleRepository, battles, inventory, collection, shop,
    rewards, objectives, objectivesRepository, daily, authenticator,
  };
}

/** A fixed clock at 2026-10-21 12:00 UTC (advance it with `set`). */
export function testClock() {
  return fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0));
}
