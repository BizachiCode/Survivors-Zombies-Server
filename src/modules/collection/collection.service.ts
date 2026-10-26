// Card collection use cases: what the player owns (with automatic grants), unlocking a card (seeds or purchase),
// levelling it up (costs in currencies through WalletLedger and items through InventoryLedger), the team, and the team a
// battle runs with. Every rule comes from the content (collection-content.ts); nothing is taken from the client.

import { isCurrencyId, type CurrencyId } from "../../config/game-config.js";
import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { BattleRepository } from "../battle/battle.repository.js";
import type { BattleCatalog, TeamCard } from "../battle/content/battle-content.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { CollectionCatalog, Cost, UnlockMethod } from "./collection-content.js";
import type { CardSource, CollectionRepository, OwnedCardRow } from "./collection.repository.js";
import type { InventoryLedger, ItemAmounts } from "./inventory-ledger.js";
import { NO_RECORDER, type ObjectiveRecorder } from "../objectives/objectives.service.js";

export type UnlockMethodDto = UnlockMethod & {
  /** True when this method can be used now (player methods) or is already met (automatic ones). */
  ready: boolean;
  /** seeds: held seeds and wild seeds. */
  have?: number;
  wildHave?: number;
};

export type AbilityDto = { level: number; name: string; description: string; unlocked: boolean };

export type CardDto = {
  id: string;
  name: string;
  role: string;
  /** Energy cost and recharge in battle. */
  cost: number;
  recharge: number;
  rarity: string;
  owned: boolean;
  /** Collection level (1 when not owned). */
  level: number;
  maxLevel: number;
  /** Battle stats at this level (curve multipliers and abilities applied; first in-battle level). */
  health: number;
  damage: number;
  production: number;
  interval: number;
  range: number;
  /** The next level (null when not owned or at the top); `ability` = what it brings (the card's abilities, else the curve's text). */
  next: { level: number; cost: Cost[]; health: number; damage: number; production: number; interval: number; ability: string; affordable: boolean } | null;
  abilities: AbilityDto[];
  unlock: UnlockMethodDto[];
};

export type CollectionDto = {
  enabled: boolean;
  deckSize: number;
  deck: string[];
  cards: CardDto[];
  items: ItemAmounts;
  wallet: WalletDto;
};

export class CollectionService {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly cards: CollectionRepository,
    private readonly inventory: InventoryLedger,
    private readonly wallets: WalletLedger,
    private readonly profiles: ProfileRepository,
    private readonly battles: BattleRepository,
    private readonly uow: UnitOfWork,
    private readonly recorder: ObjectiveRecorder = NO_RECORDER,
  ) {}

  private get collection(): CollectionCatalog {
    const collection = this.catalog.collection;
    if (!collection) throw new AppError(ErrorCode.COLLECTION_DISABLED);
    return collection;
  }

  /** Everything the collection screen shows (automatic grants applied first). */
  async info(userId: string): Promise<CollectionDto> {
    if (!this.catalog.collection) {
      return { enabled: false, deckSize: 0, deck: [], cards: [], items: await this.inventory.snapshot(userId), wallet: await this.wallets.snapshot(userId) };
    }
    await this.uow.transaction((session) => this.grant(session, userId));
    return this.snapshot(userId);
  }

  /** Unlocks a card with a player method: its seeds (wild seeds cover what is missing) or a purchase. */
  async unlock(userId: string, cardId: string, method: "seeds" | "purchase"): Promise<CollectionDto> {
    const entry = this.collection.card(cardId);
    if (!entry) throw new AppError(ErrorCode.CARD_UNKNOWN);
    await this.uow.transaction(async (session) => {
      await this.grant(session, userId);
      if (await this.cards.getCard(userId, cardId, session, true)) throw new AppError(ErrorCode.CARD_OWNED);
      const rule = entry.unlock.find((m) => m.method === method);
      if (!rule) throw new AppError(ErrorCode.CARD_UNLOCK_UNAVAILABLE);
      if (rule.method === "seeds") {
        const held = await this.inventory.snapshot(userId, session);
        const own = Math.min(held[rule.item] ?? 0, rule.amount);
        const missing = rule.amount - own;
        if (missing > 0 && (!rule.wildItem || (held[rule.wildItem] ?? 0) < missing)) {
          throw new AppError(ErrorCode.ITEM_INSUFFICIENT, { extra: { itemId: rule.item, need: rule.amount, have: held[rule.item] ?? 0 } });
        }
        await this.inventory.debit(session, userId, missing > 0 ? { [rule.item]: own, [rule.wildItem]: missing } : { [rule.item]: own }, "CARD_UNLOCK");
      } else if (rule.method === "purchase") {
        if (rule.amount > 0) await this.wallets.debit(session, userId, { [rule.currency]: rule.amount }, "CARD_UNLOCK");
      }
      await this.add(session, userId, cardId, method);
      await this.addToTeamIfRoom(session, userId, cardId);
      await this.recorder.record(session, userId, { cards_unlocked: 1 });
    });
    return this.snapshot(userId);
  }

  /** One level up, paying the curve's cost (all or nothing). */
  async upgrade(userId: string, cardId: string): Promise<CollectionDto> {
    if (!this.collection.card(cardId)) throw new AppError(ErrorCode.CARD_UNKNOWN);
    await this.uow.transaction(async (session) => {
      const owned = await this.cards.getCard(userId, cardId, session, true);
      if (!owned) throw new AppError(ErrorCode.CARD_NOT_OWNED);
      const next = this.collection.nextLevel(cardId, owned.level);
      if (!next) throw new AppError(ErrorCode.CARD_MAX_LEVEL);
      const { currencies, items } = splitCosts(next.cost);
      if (Object.keys(currencies).length > 0) await this.wallets.debit(session, userId, currencies, "CARD_UPGRADE");
      await this.inventory.debit(session, userId, items, "CARD_UPGRADE");
      await this.cards.updateLevel(userId, cardId, next.level, session);
      await this.recorder.record(session, userId, { cards_upgraded: 1, coins_spent: currencies.coins ?? 0, gems_spent: currencies.gems ?? 0 });
    });
    return this.snapshot(userId);
  }

  /** Replaces the team: 1..deckSize owned cards, no duplicates, in play order. */
  async setDeck(userId: string, cardIds: readonly string[]): Promise<CollectionDto> {
    const collection = this.collection;
    if (cardIds.length === 0 || cardIds.length > collection.deckSize || new Set(cardIds).size !== cardIds.length) {
      throw new AppError(ErrorCode.DECK_INVALID, { extra: { deckSize: collection.deckSize } });
    }
    await this.uow.transaction(async (session) => {
      const owned = new Set((await this.cards.listCards(userId, session)).map((c) => c.cardId));
      if (cardIds.some((id) => !owned.has(id) || !collection.card(id))) throw new AppError(ErrorCode.DECK_INVALID, { extra: { deckSize: collection.deckSize } });
      await this.cards.saveDeck(userId, cardIds, session);
    });
    return this.snapshot(userId);
  }

  /** The team a battle runs with (owned cards of the saved team, with their levels). */
  async team(userId: string): Promise<TeamCard[]> {
    return this.uow.transaction(async (session) => {
      await this.grant(session, userId);
      const owned = new Map((await this.cards.listCards(userId, session)).map((c) => [c.cardId, c]));
      const deck = (await this.cards.getDeck(userId, session)) ?? [];
      const team = deck.filter((id) => owned.has(id)).map((id) => ({ cardId: id, level: owned.get(id).level }));
      if (team.length === 0) throw new AppError(ErrorCode.DECK_EMPTY);
      return team;
    });
  }

  /**
   * Automatic grants inside the caller's transaction (also called by the battle service after a result): starter
   * cards and starting items for a new collection, cards of won stages and of reached player levels, and a first team.
   * Returns the newly owned card ids.
   */
  async grant(session: DbSession, userId: string): Promise<string[]> {
    const collection = this.catalog.collection;
    if (!collection) return [];
    const owned = new Set((await this.cards.listCards(userId, session)).map((c) => c.cardId));
    const isNew = owned.size === 0;
    const profile = await this.profiles.getProfile(userId, session);
    const cleared = new Set((await this.battles.listProgress(userId, session)).filter((p) => p.bestStars > 0).map((p) => p.stageId));
    const granted: string[] = [];
    for (const entry of collection.cards) {
      if (owned.has(entry.card)) continue;
      const method = entry.unlock.find((m) => m.method === "starter"
        || (m.method === "stage" && cleared.has(m.stage))
        || (m.method === "level" && (profile?.level ?? 1) >= m.level));
      if (!method) continue;
      if (await this.add(session, userId, entry.card, method.method as CardSource)) granted.push(entry.card);
    }
    if (isNew && Object.keys(collection.startingItems).length > 0) {
      await this.inventory.credit(session, userId, { ...collection.startingItems }, "STARTING_ITEMS");
    }
    if ((await this.cards.getDeck(userId, session)) === null) {
      const first = collection.cards.map((c) => c.card).filter((id) => owned.has(id) || granted.includes(id)).slice(0, collection.deckSize);
      if (first.length > 0) await this.cards.saveDeck(userId, first, session);
    } else {
      for (const cardId of granted) await this.addToTeamIfRoom(session, userId, cardId);
    }
    return granted;
  }

  private async add(session: DbSession, userId: string, cardId: string, source: CardSource): Promise<boolean> {
    try {
      await this.cards.insertCard({ userId, cardId, level: 1, source }, session);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /** A new card joins the team while it has a free slot (the team fills up as cards unlock). */
  private async addToTeamIfRoom(session: DbSession, userId: string, cardId: string): Promise<void> {
    const deck = (await this.cards.getDeck(userId, session)) ?? [];
    if (deck.includes(cardId) || deck.length >= this.collection.deckSize) return;
    await this.cards.saveDeck(userId, [...deck, cardId], session);
  }

  private async snapshot(userId: string): Promise<CollectionDto> {
    const collection = this.collection;
    const owned = new Map((await this.cards.listCards(userId)).map((c) => [c.cardId, c] as [string, OwnedCardRow]));
    const items = await this.inventory.snapshot(userId);
    const wallet = await this.wallets.snapshot(userId);
    const profile = await this.profiles.getProfile(userId);
    const cleared = new Set((await this.battles.listProgress(userId)).filter((p) => p.bestStars > 0).map((p) => p.stageId));
    const canPay = (costs: readonly Cost[]) => costs.every((c) => (isCurrencyId(c.id) ? wallet[c.id] : items[c.id] ?? 0) >= c.amount);
    const cards: CardDto[] = collection.cards.map((entry) => {
      const spec = this.catalog.defender(entry.card);
      const own = owned.get(entry.card);
      const level = own?.level ?? 1;
      const now = collection.apply(spec, level);
      const next = own ? collection.nextLevel(entry.card, level) : null;
      const then = next ? collection.apply(spec, next.level).levels[0] : null;
      const abilities = collection.abilities(entry.card);
      const nextAbilities = next ? abilities.filter((a) => a.level === next.level).map((a) => a.name) : [];
      return {
        id: entry.card,
        name: spec.name,
        role: spec.role,
        cost: now.cost,
        recharge: now.recharge,
        rarity: entry.rarity,
        owned: !!own,
        level,
        maxLevel: collection.maxLevel(entry.card),
        health: now.levels[0].health,
        damage: now.levels[0].damage,
        production: now.levels[0].production,
        interval: now.levels[0].interval,
        range: now.levels[0].range,
        next: next && {
          level: next.level, cost: next.cost, health: then.health, damage: then.damage, production: then.production, interval: then.interval,
          ability: nextAbilities.length > 0 ? nextAbilities.join(", ") : next.ability, affordable: canPay(next.cost),
        },
        abilities: abilities.map((a) => ({ level: a.level, name: a.name, description: a.description, unlocked: !!own && a.level <= level })),
        unlock: entry.unlock.map((m): UnlockMethodDto => {
          switch (m.method) {
            case "starter": return { ...m, ready: true };
            case "seeds": {
              const have = items[m.item] ?? 0;
              const wildHave = m.wildItem ? items[m.wildItem] ?? 0 : 0;
              return { ...m, have, wildHave, ready: have + wildHave >= m.amount };
            }
            case "stage": return { ...m, ready: cleared.has(m.stage) };
            case "purchase": return { ...m, ready: wallet[m.currency] >= m.amount };
            case "level": return { ...m, ready: (profile?.level ?? 1) >= m.level };
          }
        }),
      };
    });
    const deck = ((await this.cards.getDeck(userId)) ?? []).filter((id) => owned.has(id));
    return { enabled: true, deckSize: collection.deckSize, deck, cards, items, wallet };
  }
}

/** Costs split into wallet currencies and items. */
export function splitCosts(costs: readonly Cost[]): { currencies: Partial<Record<CurrencyId, number>>; items: ItemAmounts } {
  const currencies: Partial<Record<CurrencyId, number>> = {};
  const items: ItemAmounts = {};
  for (const cost of costs) {
    if (isCurrencyId(cost.id)) currencies[cost.id] = (currencies[cost.id] ?? 0) + cost.amount;
    else items[cost.id] = (items[cost.id] ?? 0) + cost.amount;
  }
  return { currencies, items };
}
