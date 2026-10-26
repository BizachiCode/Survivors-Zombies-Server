// Shop content (exported from Unity with the battle content): offers sold for a wallet currency that grant currencies
// and/or collection items, optionally limited per UTC day (daily deals) or gated by player level;
// and the products sold for real money through the platform stores (gem packs, starter pack), verified by `iap`.

import { z } from "zod";

import { CURRENCY_IDS, type CurrencyId } from "../../config/game-config.js";
import { BattleContentError } from "../battle/sim/definitions.js";
import { isEmptyReward, RewardBundleSchema, unknownRewardItems, type RewardBundle } from "../economy/reward-granter.js";

const int = z.number().int();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const amount = int.min(1).max(1_000_000_000);
/** Store product ids (Google Play / App Store Connect): lower-case letters, digits, `_` and `.`. */
const storeProductId = z.string().regex(/^[A-Za-z0-9_.]{1,150}$/);

export const ShopOfferSchema = z.strictObject({
  id,
  name: z.string().min(1).max(64),
  price: z.strictObject({ currency: z.enum(CURRENCY_IDS), amount: int.min(0).max(1_000_000_000) }),
  grants: z.strictObject({
    currencies: z.partialRecord(z.enum(CURRENCY_IDS), amount).default({}),
    items: z.record(z.string(), amount).default({}),
  }),
  /** Purchases per UTC day; 0 = unlimited. */
  dailyLimit: int.min(0).max(1000).default(0),
  /** Player level needed to buy it. */
  requiredLevel: int.min(0).max(1000).default(0),
  /** Free text for the client (e.g. "BEST VALUE"). */
  tag: z.string().max(32).default(""),
});

export const IAP_PRODUCT_KINDS = ["consumable", "non_consumable"] as const;
export type IapProductKind = (typeof IAP_PRODUCT_KINDS)[number];

/** A real-money product. The price lives in the stores; the server only decides what a verified purchase grants. */
export const IapProductSchema = z.strictObject({
  /** Catalog id (the client's product id; also the store id when `storeIds` leaves it out). */
  id,
  name: z.string().min(1).max(64),
  kind: z.enum(IAP_PRODUCT_KINDS).default("consumable"),
  storeIds: z.strictObject({ google: storeProductId.optional(), apple: storeProductId.optional() }).default({}),
  grants: RewardBundleSchema,
  /** Added to the first purchase of this product by an account (e.g. "double gems"). */
  firstPurchaseBonus: RewardBundleSchema.default({ currencies: {}, items: {}, exp: 0 }),
  /** Purchases per account; 0 = unlimited (a non-consumable is always 1). The client hides a product at its limit. */
  limit: int.min(0).max(1000).default(0),
  /** Shown from this player level. */
  requiredLevel: int.min(0).max(1000).default(0),
  tag: z.string().max(32).default(""),
  /** Price label for the client while the store has no localized price (Editor, store offline), e.g. "$0.99". */
  referencePrice: z.string().max(16).default(""),
});

export const ShopSchema = z.strictObject({
  offers: z.array(ShopOfferSchema).max(200),
  products: z.array(IapProductSchema).max(100).default([]),
});

export type ShopOffer = z.infer<typeof ShopOfferSchema>;
export type IapProduct = z.infer<typeof IapProductSchema> & { grants: RewardBundle; firstPurchaseBonus: RewardBundle };
export type ShopContent = z.infer<typeof ShopSchema>;
export type OfferGrants = { currencies: Partial<Record<CurrencyId, number>>; items: Record<string, number> };
export type IapStoreName = "google" | "apple";

/** Validated shop offers and real-money products. */
export class ShopCatalog {
  readonly offers: readonly ShopOffer[];
  readonly products: readonly IapProduct[];
  private readonly byId = new Map<string, ShopOffer>();
  private readonly productById = new Map<string, IapProduct>();
  private readonly productByStoreId = new Map<string, IapProduct>();

  constructor(content: ShopContent, refs: { items: ReadonlySet<string> }) {
    this.offers = Object.freeze([...content.offers]);
    for (const offer of content.offers) {
      if (this.byId.has(offer.id)) throw new BattleContentError(`Duplicate shop offer id: ${offer.id}.`);
      for (const itemId of Object.keys(offer.grants.items)) {
        if (!refs.items.has(itemId)) throw new BattleContentError(`Shop offer ${offer.id}: unknown item ${itemId}.`);
      }
      if (Object.keys(offer.grants.currencies).length === 0 && Object.keys(offer.grants.items).length === 0) {
        throw new BattleContentError(`Shop offer ${offer.id} grants nothing.`);
      }
      this.byId.set(offer.id, offer);
    }

    const products = (content.products ?? []) as IapProduct[];
    this.products = Object.freeze([...products]);
    for (const product of products) {
      if (this.productById.has(product.id)) throw new BattleContentError(`Duplicate product id: ${product.id}.`);
      if (isEmptyReward(product.grants)) throw new BattleContentError(`Product ${product.id} grants nothing.`);
      const unknown = [...unknownRewardItems(product.grants, (item) => refs.items.has(item)),
        ...unknownRewardItems(product.firstPurchaseBonus, (item) => refs.items.has(item))];
      if (unknown.length > 0) throw new BattleContentError(`Product ${product.id}: unknown item ${unknown[0]}.`);
      this.productById.set(product.id, product);
      for (const store of ["google", "apple"] as const) {
        const key = `${store}:${ShopCatalog.storeId(product, store)}`;
        if (this.productByStoreId.has(key)) throw new BattleContentError(`Product ${product.id}: ${store} id already used by another product.`);
        this.productByStoreId.set(key, product);
      }
    }
  }

  offer(offerId: string): ShopOffer | undefined {
    return this.byId.get(offerId);
  }

  product(productId: string): IapProduct | undefined {
    return this.productById.get(productId);
  }

  /** The product a store receipt is for. */
  productForStore(store: IapStoreName, storeProductId: string): IapProduct | undefined {
    return this.productByStoreId.get(`${store}:${storeProductId}`);
  }

  /** Purchases an account may make of the product (0 = unlimited). */
  static limit(product: IapProduct): number {
    return product.kind === "non_consumable" ? 1 : product.limit;
  }

  static storeId(product: IapProduct, store: IapStoreName): string {
    return product.storeIds[store] ?? product.id;
  }
}
