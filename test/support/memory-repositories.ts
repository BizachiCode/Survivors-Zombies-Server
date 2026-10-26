// In-memory adapters of the persistence ports, so services run in unit tests without MySQL.
// The unit of work snapshots the whole store and restores it when the work throws (rollback semantics).

import { DEFAULT_AVATAR_ID } from "../../src/config/game-config.js";
import type { DbSession, UnitOfWork } from "../../src/shared/kernel/unit-of-work.js";
import type { AccountRow, AuditKind, AuthRepository, RefreshLookupRow, RefreshTokenRecord } from "../../src/modules/auth/auth.ports.js";
import type { BattleRepository, BattleResultRow, StageProgressRow } from "../../src/modules/battle/battle.repository.js";
import type { Reward } from "../../src/modules/battle/content/battle-content.js";
import type { CollectionRepository, InventoryRepository, ItemLedgerEntry, OwnedCardRow } from "../../src/modules/collection/collection.repository.js";
import type { ShopRepository } from "../../src/modules/shop/shop.repository.js";
import type { LedgerEntry, WalletRepository } from "../../src/modules/economy/wallet.repository.js";
import type { ProfileRepository, ProfileRow } from "../../src/modules/profile/profile.repository.js";

type TokenRow = RefreshTokenRecord & { isRevoked: boolean };

export class MemoryStore {
  users = new Map<string, AccountRow>();
  devices = new Map<string, { userId: string; platform: string | null }>();
  tokens = new Map<string, TokenRow>();
  profiles = new Map<string, ProfileRow>();
  /** Balances keyed by `${userId}:${currencyId}`. */
  balances = new Map<string, number>();
  ledger: LedgerEntry[] = [];
  audit: Array<{ userId: string | null; kind: AuditKind; meta: Record<string, unknown> | null }> = [];
  /** Keyed by `${userId}:${stageId}`. */
  stageProgress = new Map<string, StageProgressRow>();
  battleResults = new Map<string, BattleResultRow>();
  /** Keyed by `${userId}:${cardId}`. */
  cards = new Map<string, OwnedCardRow>();
  decks = new Map<string, string[]>();
  /** Keyed by `${userId}:${itemId}`. */
  items = new Map<string, number>();
  itemLedger: ItemLedgerEntry[] = [];
  /** Keyed by `${userId}:${offerId}:${day}`. */
  shopPurchases = new Map<string, number>();

  snapshot(): string {
    return JSON.stringify({
      users: [...this.users], devices: [...this.devices], tokens: [...this.tokens], profiles: [...this.profiles],
      balances: [...this.balances], ledger: this.ledger, audit: this.audit,
      stageProgress: [...this.stageProgress], battleResults: [...this.battleResults],
      cards: [...this.cards], decks: [...this.decks], items: [...this.items], itemLedger: this.itemLedger,
      shopPurchases: [...this.shopPurchases],
    });
  }

  restore(raw: string): void {
    const data = JSON.parse(raw, (key, value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value));
    this.users = new Map(data.users);
    this.devices = new Map(data.devices);
    this.tokens = new Map(data.tokens);
    this.profiles = new Map(data.profiles);
    this.balances = new Map(data.balances);
    this.ledger = data.ledger;
    this.audit = data.audit;
    this.stageProgress = new Map(data.stageProgress);
    this.battleResults = new Map(data.battleResults);
    this.cards = new Map(data.cards);
    this.decks = new Map(data.decks);
    this.items = new Map(data.items);
    this.itemLedger = data.itemLedger;
    this.shopPurchases = new Map(data.shopPurchases);
  }
}

const session: DbSession = { kind: "db-session" };

export class MemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly store: MemoryStore) {}

  async transaction<T>(work: (session: DbSession) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    try {
      return await work(session);
    } catch (error) {
      this.store.restore(before);
      throw error;
    }
  }
}

/** Duplicate-key error shaped like mysql2's (see shared/errors/db-errors.ts). */
function duplicate(): Error {
  return Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
}

export class MemoryAuthRepository implements AuthRepository {
  constructor(private readonly store: MemoryStore, private readonly now: () => number = Date.now) {}

  async findDeviceBinding(deviceHash: string): Promise<string | null> {
    return this.store.devices.get(deviceHash)?.userId ?? null;
  }

  async bindDevice(userId: string, deviceHash: string, platform: string | null): Promise<void> {
    if (this.store.devices.has(deviceHash)) throw duplicate();
    this.store.devices.set(deviceHash, { userId, platform });
  }

  async touchDevice(deviceHash: string, platform: string | null): Promise<void> {
    const row = this.store.devices.get(deviceHash);
    if (row && platform) row.platform = platform;
  }

  async deleteDeviceBinding(deviceHash: string): Promise<void> {
    this.store.devices.delete(deviceHash);
  }

  async deleteDeviceBindingsOf(userId: string): Promise<number> {
    let removed = 0;
    for (const [hash, row] of this.store.devices) if (row.userId === userId) { this.store.devices.delete(hash); removed++; }
    return removed;
  }

  async insertGuest(userId: string): Promise<void> {
    this.store.users.set(userId, {
      id: userId, email: null, passwordHash: null, isGuest: true, failedLogins: 0, lockedUntil: null,
      isBanned: false, banReason: null, banExpiresAt: null, createdAt: new Date(this.now()),
    });
  }

  async getAccountById(userId: string): Promise<AccountRow | null> {
    const row = this.store.users.get(userId);
    return row ? { ...row } : null;
  }

  async findByEmail(email: string): Promise<AccountRow | null> {
    for (const row of this.store.users.values()) if (row.email === email) return { ...row };
    return null;
  }

  async emailExists(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async setCredentials(userId: string, email: string, passwordHash: string): Promise<void> {
    if ([...this.store.users.values()].some((row) => row.email === email && row.id !== userId)) throw duplicate();
    Object.assign(this.store.users.get(userId)!, { email, passwordHash, isGuest: false, failedLogins: 0, lockedUntil: null });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    this.store.users.get(userId)!.passwordHash = passwordHash;
  }

  async setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null): Promise<void> {
    Object.assign(this.store.users.get(userId)!, { failedLogins, lockedUntil });
  }

  async markLogin(userId: string): Promise<void> {
    Object.assign(this.store.users.get(userId)!, { failedLogins: 0, lockedUntil: null });
  }

  async setBan(userId: string, banned: boolean, reason: string | null, until: Date | null): Promise<void> {
    Object.assign(this.store.users.get(userId)!, { isBanned: banned, banReason: banned ? reason : null, banExpiresAt: banned ? until : null });
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.store.tokens.set(`${record.userId}:${record.deviceKey}`, { ...record, isRevoked: false });
  }

  async findRefreshToken(userId: string, deviceKey: string, tokenHash: string): Promise<RefreshLookupRow | null> {
    const row = this.store.tokens.get(`${userId}:${deviceKey}`);
    if (!row || row.tokenHash !== tokenHash || row.expiresAt.getTime() <= this.now()) return null;
    const user = this.store.users.get(userId)!;
    return { isRevoked: row.isRevoked, isBanned: user.isBanned, banReason: user.banReason, banExpiresAt: user.banExpiresAt };
  }

  async revokeRefreshToken(userId: string, deviceKey: string, tokenHash: string): Promise<boolean> {
    const row = this.store.tokens.get(`${userId}:${deviceKey}`);
    if (!row || row.tokenHash !== tokenHash) return false;
    row.isRevoked = true;
    return true;
  }

  async revokeRefreshTokensExcept(userId: string, keepDeviceKey: string): Promise<string[]> {
    const revoked: string[] = [];
    for (const row of this.store.tokens.values()) {
      if (row.userId === userId && row.deviceKey !== keepDeviceKey && !row.isRevoked) { row.isRevoked = true; revoked.push(row.deviceKey); }
    }
    return revoked;
  }

  async audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null): Promise<void> {
    this.store.audit.push({ userId, kind, meta });
  }
}

export class MemoryProfileRepository implements ProfileRepository {
  constructor(private readonly store: MemoryStore) {}

  async ensureProfile(userId: string, nickname: string): Promise<void> {
    if (!this.store.profiles.has(userId)) this.store.profiles.set(userId, { userId, nickname, avatarId: DEFAULT_AVATAR_ID, level: 1, exp: 0 });
  }

  async getProfile(userId: string): Promise<ProfileRow | null> {
    const row = this.store.profiles.get(userId);
    return row ? { ...row } : null;
  }

  async updateNickname(userId: string, nickname: string): Promise<void> {
    const row = this.store.profiles.get(userId);
    if (row) row.nickname = nickname;
  }

  async updateAvatar(userId: string, avatarId: string): Promise<void> {
    const row = this.store.profiles.get(userId);
    if (row) row.avatarId = avatarId;
  }

  async updateLevel(userId: string, level: number, exp: number): Promise<void> {
    const row = this.store.profiles.get(userId);
    if (row) Object.assign(row, { level, exp });
  }
}

export class MemoryWalletRepository implements WalletRepository {
  constructor(private readonly store: MemoryStore) {}

  async listBalances(userId: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const [key, amount] of this.store.balances) {
      const [owner, currencyId] = key.split(":");
      if (owner === userId) result.set(currencyId, amount);
    }
    return result;
  }

  async lockBalances(userId: string, currencyIds: readonly string[]): Promise<Map<string, number>> {
    const all = await this.listBalances(userId);
    return new Map([...all].filter(([currencyId]) => currencyIds.includes(currencyId)));
  }

  async saveBalance(userId: string, currencyId: string, amount: number): Promise<void> {
    this.store.balances.set(`${userId}:${currencyId}`, amount);
  }

  async appendLedger(entries: readonly LedgerEntry[]): Promise<void> {
    this.store.ledger.push(...entries.map((entry) => ({ ...entry })));
  }
}

export class MemoryBattleRepository implements BattleRepository {
  constructor(private readonly store: MemoryStore) {}

  async listProgress(userId: string): Promise<StageProgressRow[]> {
    return [...this.store.stageProgress.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async getProgress(userId: string, stageId: string, _session?: DbSession, _forUpdate?: boolean): Promise<StageProgressRow | null> {
    const row = this.store.stageProgress.get(`${userId}:${stageId}`);
    return row ? { ...row } : null;
  }

  async saveProgress(row: StageProgressRow): Promise<void> {
    this.store.stageProgress.set(`${row.userId}:${row.stageId}`, { ...row });
  }

  async insertResult(row: BattleResultRow): Promise<void> {
    if (this.store.battleResults.has(row.id)) throw duplicate();
    this.store.battleResults.set(row.id, structuredClone(row));
  }

  async updateResult(battleId: string, stars: number, reward: Reward): Promise<void> {
    const row = this.store.battleResults.get(battleId);
    if (row) this.store.battleResults.set(battleId, { ...row, stars, reward: structuredClone(reward) });
  }

  async getResult(battleId: string): Promise<BattleResultRow | null> {
    const row = this.store.battleResults.get(battleId);
    return row ? structuredClone(row) : null;
  }
}

export class MemoryCollectionRepository implements CollectionRepository {
  constructor(private readonly store: MemoryStore) {}

  async listCards(userId: string): Promise<OwnedCardRow[]> {
    return [...this.store.cards.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async getCard(userId: string, cardId: string, _session?: DbSession, _forUpdate?: boolean): Promise<OwnedCardRow | null> {
    const row = this.store.cards.get(`${userId}:${cardId}`);
    return row ? { ...row } : null;
  }

  async insertCard(row: OwnedCardRow): Promise<void> {
    const key = `${row.userId}:${row.cardId}`;
    if (this.store.cards.has(key)) throw duplicate();
    this.store.cards.set(key, { ...row });
  }

  async updateLevel(userId: string, cardId: string, level: number): Promise<void> {
    const row = this.store.cards.get(`${userId}:${cardId}`);
    if (row) row.level = level;
  }

  async getDeck(userId: string): Promise<string[] | null> {
    const deck = this.store.decks.get(userId);
    return deck ? [...deck] : null;
  }

  async saveDeck(userId: string, cards: readonly string[]): Promise<void> {
    this.store.decks.set(userId, [...cards]);
  }
}

export class MemoryInventoryRepository implements InventoryRepository {
  constructor(private readonly store: MemoryStore) {}

  async listItems(userId: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const [key, amount] of this.store.items) {
      const [owner, itemId] = key.split(":");
      if (owner === userId) result.set(itemId, amount);
    }
    return result;
  }

  async lockItems(userId: string, itemIds: readonly string[]): Promise<Map<string, number>> {
    const all = await this.listItems(userId);
    return new Map([...all].filter(([itemId]) => itemIds.includes(itemId)));
  }

  async saveItem(userId: string, itemId: string, amount: number): Promise<void> {
    this.store.items.set(`${userId}:${itemId}`, amount);
  }

  async appendLedger(entries: readonly ItemLedgerEntry[]): Promise<void> {
    this.store.itemLedger.push(...entries.map((entry) => ({ ...entry })));
  }
}

export class MemoryShopRepository implements ShopRepository {
  constructor(private readonly store: MemoryStore) {}

  async countsOn(userId: string, day: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const [key, count] of this.store.shopPurchases) {
      const [owner, offerId, on] = key.split(":");
      if (owner === userId && on === day) result.set(offerId, count);
    }
    return result;
  }

  async lockCount(userId: string, offerId: string, day: string): Promise<number> {
    return this.store.shopPurchases.get(`${userId}:${offerId}:${day}`) ?? 0;
  }

  async saveCount(userId: string, offerId: string, day: string, count: number): Promise<void> {
    this.store.shopPurchases.set(`${userId}:${offerId}:${day}`, count);
  }
}
