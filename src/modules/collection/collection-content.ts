// Card collection content (exported from Unity with the battle content): items, how each card is unlocked, how it is
// upgraded and what a level is worth (stat multipliers of the curve + the card's own abilities), and the team size. Every rule is data, so a game can mix a seeds model (seeds
// unlock, coins + XP + meteorites level up) with others (buy with coins, win a stage, reach a player level...).

import { z } from "zod";

import { CURRENCY_IDS, isCurrencyId } from "../../config/game-config.js";
import { BattleContentError } from "../battle/sim/definitions.js";
import { buildDefender, type DefenderSpec } from "../battle/sim/battle-spec.js";

const int = z.number().int();
const num = z.number().finite();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const ITEM_KINDS = ["seed", "material", "resource"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Something players hold besides wallet currencies: card seeds, upgrade materials, upgrade XP... */
export const ItemSchema = z.strictObject({
  id,
  name: z.string().min(1).max(64),
  kind: z.enum(ITEM_KINDS),
  /** Seeds of this card (kind "seed"); empty for wild seeds and other items. */
  card: z.string().max(64).default(""),
});

/** One way to get a card. A card may list several; any of them unlocks it. */
export const UnlockMethodSchema = z.discriminatedUnion("method", [
  /** Owned from the start. */
  z.strictObject({ method: z.literal("starter") }),
  /** Spend `amount` of `item` (the card's seeds); `wildItem` (wild seeds) covers what is missing. Player action. */
  z.strictObject({ method: z.literal("seeds"), item: id, amount: int.min(1), wildItem: z.string().max(64).default("") }),
  /** Granted when `stage` is won the first time. */
  z.strictObject({ method: z.literal("stage"), stage: id }),
  /** Bought with a wallet currency. Player action. */
  z.strictObject({ method: z.literal("purchase"), currency: z.enum(CURRENCY_IDS), amount: int.min(0) }),
  /** Granted when the player reaches `level`. */
  z.strictObject({ method: z.literal("level"), level: int.min(1) }),
]);

/** A cost: a wallet currency id or an item id. */
export const CostSchema = z.strictObject({ id, amount: int.min(1).max(1_000_000_000) });

/** Reaching `level`: what it costs and the card's stat multipliers at that level (level 1 = x1, free). */
export const CurveLevelSchema = z.strictObject({
  level: int.min(2).max(100),
  cost: z.array(CostSchema),
  health: num.positive(),
  damage: num.positive(),
  /** Shown to players (e.g. the ability this level adds); gameplay ignores it. */
  ability: z.string().max(200).default(""),
});

export const CurveSchema = z.strictObject({
  id,
  levels: z.array(CurveLevelSchema).max(99),
});

/** Card numbers an ability changes: a stat of every in-battle level, or the card's `cost` / `recharge`. */
export const DEFENDER_STATS = [
  "health", "damage", "interval", "range", "projectileSpeed", "splashRadius", "slowFraction", "slowDuration", "production",
  "stunDuration", "burnDamagePerSecond", "burnDuration", "pierceCount", "cost", "recharge",
] as const;
export type DefenderStat = (typeof DEFENDER_STATS)[number];

export const StatModifierSchema = z.strictObject({
  stat: z.enum(DEFENDER_STATS),
  op: z.enum(["add", "multiply"]),
  value: num,
});

/** What a card gains at a level of its collection (card abilities): applied from that level on. */
export const CardAbilitySchema = z.strictObject({
  level: int.min(2).max(100),
  name: z.string().min(1).max(64),
  description: z.string().max(200).default(""),
  modifiers: z.array(StatModifierSchema).max(8).default([]),
});

export const CollectionCardSchema = z.strictObject({
  card: id,
  rarity: z.string().max(32).default("common"),
  unlock: z.array(UnlockMethodSchema).min(1),
  curve: id,
  abilities: z.array(CardAbilitySchema).max(20).default([]),
});

export const CollectionSchema = z.strictObject({
  /** Cards a team holds (the demo uses 5). */
  deckSize: int.min(1).max(12),
  /** Items every new collection starts with. */
  startingItems: z.record(z.string(), int.min(1)).default({}),
  cards: z.array(CollectionCardSchema).min(1),
  curves: z.array(CurveSchema).min(1),
});

export type ItemDefinition = z.infer<typeof ItemSchema>;
export type UnlockMethod = z.infer<typeof UnlockMethodSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type CurveLevel = z.infer<typeof CurveLevelSchema>;
export type CurveDefinition = z.infer<typeof CurveSchema>;
export type CollectionCard = z.infer<typeof CollectionCardSchema>;
export type CollectionContent = z.infer<typeof CollectionSchema>;
export type StatModifier = z.infer<typeof StatModifierSchema>;
export type CardAbility = z.infer<typeof CardAbilitySchema>;

/** Stat multipliers of a card level. */
export type LevelMultipliers = { health: number; damage: number };

/** Applies a collection level to a card: health of every in-battle level, damage and burn of its attacks. */
export function applyLevel(card: DefenderSpec, level: LevelMultipliers): DefenderSpec {
  if (level.health === 1 && level.damage === 1) return card;
  return {
    ...card,
    levels: card.levels.map((s) => ({ ...s, health: s.health * level.health, damage: s.damage * level.damage, burnDamagePerSecond: s.burnDamagePerSecond * level.damage })),
  };
}

/** Rounds half up (C# `Math.Floor(x + 0.5)`; `Math.Round` there would round half to even). */
const roundHalfUp = (value: number) => Math.floor(value + 0.5);

function modify(value: number, modifier: StatModifier): number {
  return modifier.op === "add" ? value + modifier.value : value * modifier.value;
}

/**
 * Applies ability modifiers in order (mirrored by the Unity `DefenderScaling.ApplyModifiers`): `cost` and `recharge`
 * change the card, any other stat every in-battle level. Results stay valid: integers rounded (half up), interval >= 0.05,
 * slow fraction <= 1, 1-20 piercing hits, nothing negative.
 */
export function applyModifiers(card: DefenderSpec, modifiers: readonly StatModifier[]): DefenderSpec {
  if (modifiers.length === 0) return card;
  let cost = card.cost;
  let recharge = card.recharge;
  const levels = card.levels.map((level) => ({ ...level }));
  for (const modifier of modifiers) {
    if (modifier.stat === "cost") cost = Math.max(0, roundHalfUp(modify(cost, modifier)));
    else if (modifier.stat === "recharge") recharge = Math.max(0, modify(recharge, modifier));
    else {
      for (const level of levels) {
        let value = modify(level[modifier.stat], modifier);
        switch (modifier.stat) {
          case "production": value = Math.max(0, roundHalfUp(value)); break;
          case "pierceCount": value = Math.min(20, Math.max(1, roundHalfUp(value))); break;
          case "interval": value = Math.max(0.05, value); break;
          case "slowFraction": value = Math.min(1, Math.max(0, value)); break;
          case "health": value = Math.max(0.001, value); break;
          default: value = Math.max(0, value); break;
        }
        level[modifier.stat] = value;
      }
    }
  }
  return { ...card, cost, recharge, levels };
}

/** Validated, cross-referenced collection rules. */
export class CollectionCatalog {
  readonly deckSize: number;
  readonly startingItems: Readonly<Record<string, number>>;
  readonly cards: readonly CollectionCard[];
  private readonly byCard = new Map<string, CollectionCard>();
  private readonly curves = new Map<string, CurveDefinition>();

  constructor(content: CollectionContent, refs: {
    cards: ReadonlyMap<string, DefenderSpec>; stages: ReadonlySet<string>; items: ReadonlyMap<string, ItemDefinition>;
  }) {
    this.deckSize = content.deckSize;
    this.startingItems = Object.freeze({ ...content.startingItems });
    this.cards = Object.freeze([...content.cards]);
    const isCostId = (costId: string) => isCurrencyId(costId) || refs.items.has(costId);

    for (const itemId of Object.keys(content.startingItems)) {
      if (!refs.items.has(itemId)) throw new BattleContentError(`Collection: unknown starting item ${itemId}.`);
    }
    for (const curve of content.curves) {
      if (this.curves.has(curve.id)) throw new BattleContentError(`Duplicate upgrade curve id: ${curve.id}.`);
      curve.levels.forEach((level, index) => {
        if (level.level !== index + 2) throw new BattleContentError(`Curve ${curve.id}: levels must run 2, 3, 4... (found ${level.level} at position ${index + 1}).`);
        for (const cost of level.cost) if (!isCostId(cost.id)) throw new BattleContentError(`Curve ${curve.id} level ${level.level}: unknown cost ${cost.id}.`);
      });
      this.curves.set(curve.id, curve);
    }
    for (const card of content.cards) {
      if (!refs.cards.has(card.card)) throw new BattleContentError(`Collection: unknown card ${card.card}.`);
      if (this.byCard.has(card.card)) throw new BattleContentError(`Collection: card ${card.card} listed twice.`);
      if (!this.curves.has(card.curve)) throw new BattleContentError(`Collection card ${card.card}: unknown curve ${card.curve}.`);
      for (const method of card.unlock) {
        if (method.method === "seeds") {
          if (!refs.items.has(method.item)) throw new BattleContentError(`Collection card ${card.card}: unknown seed item ${method.item}.`);
          if (method.wildItem && !refs.items.has(method.wildItem)) throw new BattleContentError(`Collection card ${card.card}: unknown wild seed item ${method.wildItem}.`);
        }
        if (method.method === "stage" && !refs.stages.has(method.stage)) throw new BattleContentError(`Collection card ${card.card}: unknown stage ${method.stage}.`);
      }
      this.byCard.set(card.card, card);
      const top = this.maxLevel(card.card);
      for (const ability of card.abilities) {
        if (ability.level > top) throw new BattleContentError(`Collection card ${card.card}: ability ${ability.name} at level ${ability.level}, above the top level ${top}.`);
      }
      // Every level must still be a valid card (e.g. piercing can't be combined with splash).
      for (let level = 1; level <= top; level++) {
        try {
          buildDefender(this.apply(refs.cards.get(card.card), level));
        } catch (error) {
          throw new BattleContentError(`Collection card ${card.card} at level ${level}: ${(error as Error).message}`);
        }
      }
    }
    if (!content.cards.some((card) => card.unlock.some((m) => m.method === "starter"))) {
      throw new BattleContentError("Collection: at least one card must be a starter (players need a team).");
    }
  }

  card(cardId: string): CollectionCard | undefined {
    return this.byCard.get(cardId);
  }

  maxLevel(cardId: string): number {
    const card = this.byCard.get(cardId);
    return card ? this.curves.get(card.curve).levels.length + 1 : 1;
  }

  /** The next level of a card owned at `level`, or null at the top. */
  nextLevel(cardId: string, level: number): CurveLevel | null {
    const card = this.byCard.get(cardId);
    return card ? this.curves.get(card.curve).levels[level - 1] ?? null : null;
  }

  multipliers(cardId: string, level: number): LevelMultipliers {
    if (level <= 1) return { health: 1, damage: 1 };
    const entry = this.curves.get(this.byCard.get(cardId)?.curve)?.levels[level - 2];
    return entry ? { health: entry.health, damage: entry.damage } : { health: 1, damage: 1 };
  }

  /** Abilities of a card, by level. */
  abilities(cardId: string): readonly CardAbility[] {
    return [...(this.byCard.get(cardId)?.abilities ?? [])].sort((a, b) => a.level - b.level);
  }

  /** A card at a collection level: the curve's multipliers, then every ability reached, in level order. */
  apply(card: DefenderSpec, level: number): DefenderSpec {
    const reached = this.abilities(card.id).filter((ability) => ability.level <= level).flatMap((ability) => ability.modifiers);
    return applyModifiers(applyLevel(card, this.multipliers(card.id, level)), reached);
  }
}
