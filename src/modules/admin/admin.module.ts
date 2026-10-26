// Builds the admin panel from the composition root's parts: content editors, access gate, service and the Express
// router. `router` is null (the routes answer 404) when ADMIN_TOKEN is empty.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type express from "express";

import type { Env } from "../../config/env.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import type { AuthRepository } from "../auth/auth.ports.js";
import type { InventoryLedger } from "../collection/inventory-ledger.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { IapRefundService } from "../iap/iap-refund.service.js";
import type { IapRepository } from "../iap/iap.repository.js";
import { MailBroadcastSchema, MailContentSchema, type MailBroadcast, type MailContent } from "../mail/mail-content.js";
import type { MailService } from "../mail/mail.service.js";
import { NewsContentSchema, NewsItemSchema, type NewsContent, type NewsItemContent } from "../news/news-content.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import { unknownRewardItems } from "../economy/reward-granter.js";
import { AdminGate } from "./admin.gate.js";
import type { AdminRepository } from "./admin.repository.js";
import { createAdminRouter } from "./admin.routes.js";
import { AdminService } from "./admin.service.js";
import { ContentListEditor } from "./content-editor.js";
import type { MaintenanceFlag } from "./maintenance.js";

export type AdminModuleDeps = {
  config: Pick<Env, "nodeEnv" | "newsContentPath" | "mailContentPath"> & { admin: Env["admin"] };
  repo: AdminRepository;
  users: AuthRepository;
  profiles: ProfileRepository;
  wallets: WalletLedger;
  inventory: InventoryLedger;
  mail: MailService;
  purchases: IapRepository;
  refunds: IapRefundService;
  sessions: SessionStore;
  uow: UnitOfWork;
  clock: Clock;
  maintenance: MaintenanceFlag;
  knownItem: (itemId: string) => boolean;
  /** Every item id of the content, e.g. `() => [...catalog.items.keys()]`. */
  itemIds: () => string[];
  /** Folder of the static panel; default `<server folder>/admin`. */
  staticDir?: string;
  /** Test hook. */
  gateNow?: () => number;
};

export type AdminModule = {
  service: AdminService;
  gate: AdminGate;
  maintenance: MaintenanceFlag;
  /** Mount at `/admin`; null when the panel is off (no ADMIN_TOKEN). */
  router: express.Router | null;
};

/** `<server folder>/admin`, both from `src/modules/admin` (tsx) and from `build/modules/admin` (compiled). */
const DEFAULT_STATIC_DIR = join(__dirname, "..", "..", "..", "admin");

function serverVersion(): string {
  try {
    return String((JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")) as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export function createAdminModule(deps: AdminModuleDeps): AdminModule {
  const { config } = deps;
  const news = new ContentListEditor<NewsContent, NewsItemContent>({
    path: config.newsContentPath,
    listKey: "items",
    documentSchema: NewsContentSchema,
    itemSchema: NewsItemSchema,
  });
  const broadcasts = new ContentListEditor<MailContent, MailBroadcast>({
    path: config.mailContentPath,
    listKey: "broadcasts",
    documentSchema: MailContentSchema,
    itemSchema: MailBroadcastSchema,
    check: (broadcast) => {
      const unknown = unknownRewardItems(broadcast.attachments, deps.knownItem);
      if (unknown.length > 0) throw new Error(`Broadcast ${broadcast.id}: unknown item ${unknown.join(", ")}.`);
    },
  });

  const service = new AdminService({
    repo: deps.repo,
    users: deps.users,
    profiles: deps.profiles,
    wallets: deps.wallets,
    inventory: deps.inventory,
    mail: deps.mail,
    purchases: deps.purchases,
    refunds: deps.refunds,
    sessions: deps.sessions,
    uow: deps.uow,
    clock: deps.clock,
    maintenance: deps.maintenance,
    news,
    broadcasts,
    knownItem: deps.knownItem,
    itemIds: deps.itemIds,
    server: { version: serverVersion(), nodeEnv: config.nodeEnv, startedAtMs: Date.now() },
  });
  const gate = new AdminGate({ token: config.admin.token, allowedIps: config.admin.allowedIps, now: deps.gateNow });
  const router = gate.enabled ? createAdminRouter({ gate, service, staticDir: deps.staticDir ?? DEFAULT_STATIC_DIR }) : null;
  return { service, gate, maintenance: deps.maintenance, router };
}
