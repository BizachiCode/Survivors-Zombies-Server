// Admin use cases: dashboard, player lookup and support actions (grant / remove, mail, ban, refund), the runtime
// maintenance switch and the live content editors. Balances change only through the ledgers (reason ADMIN), bans use the
// auth repository and session store, and every mutating action leaves an `admin_audit` row (in the same transaction as
// the change when there is one).

import { CURRENCY_IDS } from "../../config/game-config.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import type { AuthRepository } from "../auth/auth.ports.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import { debitUpTo } from "../economy/debit-up-to.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { IapRefundService, RefundOutcome } from "../iap/iap-refund.service.js";
import type { IapRepository } from "../iap/iap.repository.js";
import type { MailBroadcast, MailContent } from "../mail/mail-content.js";
import type { MailService } from "../mail/mail.service.js";
import type { NewsContent, NewsItemContent } from "../news/news-content.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import { AdminError } from "./admin-error.js";
import type { AdminRepository, AuditEntry, BattleSummary, PlayerSummary } from "./admin.repository.js";
import type { AdjustInput, BanInput, RefundInput, SendMailInput } from "./admin.validation.js";
import type { ContentListEditor } from "./content-editor.js";
import type { MaintenanceFlag } from "./maintenance.js";

const DAY_MS = 86_400_000;
const SEARCH_LIMIT = 20;
const PLAYER_BATTLES = 10;
const PLAYER_PURCHASES = 30;
const PLAYER_AUDIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_CODE = /^[0-9a-f]{8}$/;

/** Who is acting (for the audit trail). */
export type AdminContext = { ip: string };

export type AdminServiceDeps = {
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
  news: ContentListEditor<NewsContent, NewsItemContent>;
  broadcasts: ContentListEditor<MailContent, MailBroadcast>;
  knownItem: (itemId: string) => boolean;
  /** Every item id of the content (for the panel's pickers). */
  itemIds: () => string[];
  server: { version: string; nodeEnv: string; startedAtMs: number };
};

export type DashboardDto = {
  players: { total: number; activeToday: number; activeWeek: number; newToday: number };
  purchasesToday: { total: number; refunded: number; byProduct: Array<{ productId: string; count: number; refunded: number }> };
  server: { version: string; nodeEnv: string; uptimeSec: number; maintenance: boolean; serverTimeUnix: number };
};

export type PlayerDto = ReturnType<typeof playerDto>;

export type PlayerDetailDto = {
  player: PlayerDto;
  profile: { nickname: string; avatarId: string; level: number; exp: number } | null;
  ban: { banned: boolean; reason: string | null; untilUnix: number | null };
  wallet: WalletDto;
  items: ItemAmounts;
  friends: number;
  battles: Array<Omit<BattleSummary, "createdAt"> & { createdAtUnix: number | null }>;
  purchases: Array<ReturnType<typeof purchaseDto>>;
  audit: Array<ReturnType<typeof auditDto>>;
};

const unix = (date: Date | null | undefined) => (date ? Math.floor(date.getTime() / 1000) : null);

function playerDto(summary: PlayerSummary) {
  return {
    userId: summary.userId,
    publicCode: summary.publicCode,
    nickname: summary.nickname,
    level: summary.level,
    email: summary.email,
    isGuest: summary.isGuest,
    isBanned: summary.isBanned,
    banUntilUnix: unix(summary.banExpiresAt),
    createdAtUnix: unix(summary.createdAt),
    lastLoginAtUnix: unix(summary.lastLoginAt),
  };
}

function purchaseDto(row: Awaited<ReturnType<IapRepository["listByUser"]>>[number]) {
  return {
    id: row.id,
    store: row.store,
    transactionId: row.transactionId,
    orderId: row.orderId,
    productId: row.productId,
    environment: row.environment,
    quantity: row.quantity,
    granted: row.granted,
    purchasedAtUnix: unix(row.purchasedAt),
    status: row.status,
    refundedAtUnix: unix(row.refundedAt),
    refundReason: row.refundReason,
    refundShortfall: row.refundShortfall,
  };
}

function auditDto(entry: AuditEntry) {
  return { id: entry.id, atUnix: unix(entry.createdAt), ip: entry.ip, action: entry.action, target: entry.target, payload: entry.payload };
}

type Amounts = { currencies: Record<string, number>; items: Record<string, number> };

export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  // ------------------------------------------------------------------ reads

  async dashboard(): Promise<DashboardDto> {
    const now = this.deps.clock.now();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const counters = await this.deps.repo.counters(todayStart, new Date(now.getTime() - 7 * DAY_MS));
    return {
      players: { total: counters.totalPlayers, activeToday: counters.activeSinceToday, activeWeek: counters.activeSinceWeek, newToday: counters.newSinceToday },
      purchasesToday: {
        total: counters.purchases.reduce((sum, row) => sum + row.count, 0),
        refunded: counters.purchases.reduce((sum, row) => sum + row.refunded, 0),
        byProduct: [...counters.purchases].sort((a, b) => b.count - a.count || a.productId.localeCompare(b.productId)),
      },
      server: {
        version: this.deps.server.version,
        nodeEnv: this.deps.server.nodeEnv,
        uptimeSec: Math.floor((now.getTime() - this.deps.server.startedAtMs) / 1000),
        maintenance: this.deps.maintenance.isEnabled(),
        serverTimeUnix: Math.floor(now.getTime() / 1000),
      },
    };
  }

  /** What the panel's forms can offer: currency ids and item ids of the content. */
  meta(): { currencies: readonly string[]; items: string[] } {
    return { currencies: CURRENCY_IDS, items: this.deps.itemIds().sort() };
  }

  /** Finds players by public code (8 hex), user id, email or nickname prefix. */
  async search(term: string): Promise<{ players: PlayerDto[] }> {
    const value = term.trim();
    const lower = value.toLowerCase();
    const found = await this.deps.repo.search({
      publicCode: PUBLIC_CODE.test(lower) ? lower : undefined,
      userId: UUID.test(lower) ? lower : undefined,
      email: value.includes("@") ? lower : undefined,
      nicknamePrefix: value.includes("@") ? undefined : value,
    }, SEARCH_LIMIT);
    return { players: found.map(playerDto) };
  }

  async player(userId: string): Promise<PlayerDetailDto> {
    const summary = await this.requirePlayer(userId);
    const [account, profile, wallet, items, friends, battles, purchases, audit] = await Promise.all([
      this.deps.users.getAccountById(userId),
      this.deps.profiles.getProfile(userId),
      this.deps.wallets.snapshot(userId),
      this.deps.inventory.snapshot(userId),
      this.deps.repo.friendsCount(userId),
      this.deps.repo.recentBattles(userId, PLAYER_BATTLES),
      this.deps.purchases.listByUser(userId, PLAYER_PURCHASES),
      this.deps.repo.listAudit({ target: userId, limit: PLAYER_AUDIT }),
    ]);
    const banActive = !!account?.isBanned && (!account.banExpiresAt || account.banExpiresAt.getTime() > this.deps.clock.nowMs());
    return {
      player: playerDto(summary),
      profile: profile ? { nickname: profile.nickname, avatarId: profile.avatarId, level: profile.level, exp: profile.exp } : null,
      ban: { banned: banActive, reason: banActive ? account!.banReason : null, untilUnix: banActive ? unix(account!.banExpiresAt) : null },
      wallet,
      items,
      friends,
      battles: battles.map(({ createdAt, ...rest }) => ({ ...rest, createdAtUnix: unix(createdAt) })),
      purchases: purchases.map(purchaseDto),
      audit: audit.map(auditDto),
    };
  }

  async audit(filter: { target?: string; limit: number }): Promise<{ entries: Array<ReturnType<typeof auditDto>> }> {
    return { entries: (await this.deps.repo.listAudit(filter)).map(auditDto) };
  }

  // ------------------------------------------------------------------ player actions

  /** Grants, or removes (never below zero: only what the player still has), currencies and items. */
  async adjust(ctx: AdminContext, userId: string, input: AdjustInput) {
    await this.requirePlayer(userId);
    const unknown = Object.keys(input.items).filter((itemId) => !this.deps.knownItem(itemId));
    if (unknown.length > 0) throw new AdminError("ADMIN_UNKNOWN_ITEM", 400, `unknown item ${unknown.join(", ")}`);
    const currencies = input.currencies as Record<string, number>;

    const outcome = await this.deps.uow.transaction(async (session) => {
      let applied: Amounts;
      let shortfall: Amounts | null = null;
      if (input.mode === "grant") {
        if (Object.keys(currencies).length > 0) await this.deps.wallets.credit(session, userId, input.currencies, "ADMIN");
        if (Object.keys(input.items).length > 0) await this.deps.inventory.credit(session, userId, { ...input.items }, "ADMIN");
        applied = { currencies: { ...currencies }, items: { ...input.items } };
      } else {
        const result = await debitUpTo({ wallets: this.deps.wallets, inventory: this.deps.inventory, knownItem: this.deps.knownItem },
          session, userId, { currencies, items: input.items }, "ADMIN");
        applied = result.taken;
        shortfall = result.shortfall;
      }
      await this.record(session, ctx, `player.${input.mode}`, userId, { currencies, items: input.items, note: input.note, applied, shortfall });
      return { applied, shortfall };
    });
    return {
      mode: input.mode,
      applied: outcome.applied,
      shortfall: outcome.shortfall,
      wallet: await this.deps.wallets.snapshot(userId),
      items: await this.deps.inventory.snapshot(userId),
    };
  }

  /** Puts a message (optionally with attachments) in one player's inbox. */
  async sendMail(ctx: AdminContext, userId: string, input: SendMailInput): Promise<{ mailId: string }> {
    await this.requirePlayer(userId);
    const unknown = Object.keys(input.attachments.items).filter((itemId) => !this.deps.knownItem(itemId));
    if (unknown.length > 0) throw new AdminError("ADMIN_UNKNOWN_ITEM", 400, `unknown item ${unknown.join(", ")}`);
    const mailId = await this.deps.uow.transaction(async (session) => {
      const id = await this.deps.mail.send(session, userId, {
        sender: input.sender,
        title: input.title,
        body: input.body,
        attachments: input.attachments,
        expiresAt: input.expiresInDays > 0 ? new Date(this.deps.clock.nowMs() + input.expiresInDays * DAY_MS) : undefined,
      });
      await this.record(session, ctx, "player.mail", userId, { mailId: id, sender: input.sender, title: input.title, attachments: input.attachments, expiresInDays: input.expiresInDays });
      return id;
    });
    return { mailId };
  }

  /** Bans the account (login and refresh answer AUTH_BANNED) and ends its sessions, so connected devices are kicked. */
  async ban(ctx: AdminContext, userId: string, input: BanInput) {
    await this.requirePlayer(userId);
    const until = input.until ? new Date(input.until) : input.durationHours ? new Date(this.deps.clock.nowMs() + input.durationHours * 3_600_000) : null;
    if (until && until.getTime() <= this.deps.clock.nowMs()) throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, "the ban must end in the future");
    await this.deps.uow.transaction(async (session) => {
      await this.deps.users.setBan(userId, true, input.reason, until, session);
      await this.deps.users.audit(userId, "BAN", { reason: input.reason, until: until?.toISOString() ?? null, by: "admin" }, session);
      await this.record(session, ctx, "player.ban", userId, { reason: input.reason, until: until?.toISOString() ?? null });
    });
    await this.deps.sessions.deleteAllSessions(userId);
    return { banned: true, reason: input.reason, untilUnix: unix(until) };
  }

  async unban(ctx: AdminContext, userId: string) {
    await this.requirePlayer(userId);
    await this.deps.uow.transaction(async (session) => {
      await this.deps.users.setBan(userId, false, null, null, session);
      await this.deps.users.audit(userId, "UNBAN", { by: "admin" }, session);
      await this.record(session, ctx, "player.unban", userId, {});
    });
    return { banned: false, reason: null as string | null, untilUnix: null as number | null };
  }

  /** Manual refund of a recorded purchase (what it granted is taken back as far as the player still has it). */
  async refund(ctx: AdminContext, input: RefundInput): Promise<Exclude<RefundOutcome, { status: "unknown" }>> {
    const outcome = await this.deps.refunds.refund(input.store, input.transactionId, `admin:${input.reason}`);
    if (outcome.status === "unknown") throw new AdminError("ADMIN_PURCHASE_NOT_FOUND", 404, "no purchase with that transaction id");
    await this.deps.repo.insertAudit({
      ip: ctx.ip,
      action: "iap.refund",
      target: outcome.userId,
      payload: { store: input.store, transactionId: input.transactionId, reason: input.reason, result: outcome.status, productId: outcome.productId },
    });
    return outcome;
  }

  // ------------------------------------------------------------------ server

  maintenanceState(): { enabled: boolean } {
    return { enabled: this.deps.maintenance.isEnabled() };
  }

  async setMaintenance(ctx: AdminContext, enabled: boolean): Promise<{ enabled: boolean }> {
    const before = this.deps.maintenance.isEnabled();
    this.deps.maintenance.set(enabled);
    await this.deps.repo.insertAudit({ ip: ctx.ip, action: "maintenance", target: "", payload: { before, enabled } });
    return { enabled };
  }

  // ------------------------------------------------------------------ live content

  async listNews(): Promise<{ items: NewsItemContent[] }> {
    return { items: await this.deps.news.list() };
  }

  async createNews(ctx: AdminContext, raw: unknown) {
    const items = await this.deps.news.create(raw);
    await this.contentAudit(ctx, "news.create", `news:${(raw as { id?: string }).id ?? ""}`, raw);
    return { items };
  }

  async replaceNews(ctx: AdminContext, id: string, raw: unknown) {
    const items = await this.deps.news.replace(id, raw);
    await this.contentAudit(ctx, "news.update", `news:${id}`, raw);
    return { items };
  }

  async removeNews(ctx: AdminContext, id: string) {
    const items = await this.deps.news.remove(id);
    await this.contentAudit(ctx, "news.delete", `news:${id}`, {});
    return { items };
  }

  async listBroadcasts(): Promise<{ broadcasts: MailBroadcast[] }> {
    return { broadcasts: await this.deps.broadcasts.list() };
  }

  async createBroadcast(ctx: AdminContext, raw: unknown) {
    const broadcasts = await this.deps.broadcasts.create(raw);
    await this.contentAudit(ctx, "mail_broadcast.create", `mail:${(raw as { id?: string }).id ?? ""}`, raw);
    return { broadcasts };
  }

  async replaceBroadcast(ctx: AdminContext, id: string, raw: unknown) {
    const broadcasts = await this.deps.broadcasts.replace(id, raw);
    await this.contentAudit(ctx, "mail_broadcast.update", `mail:${id}`, raw);
    return { broadcasts };
  }

  async removeBroadcast(ctx: AdminContext, id: string) {
    const broadcasts = await this.deps.broadcasts.remove(id);
    await this.contentAudit(ctx, "mail_broadcast.delete", `mail:${id}`, {});
    return { broadcasts };
  }

  // ------------------------------------------------------------------ internals

  private async requirePlayer(userId: string): Promise<PlayerSummary> {
    const summary = await this.deps.repo.summary(userId);
    if (!summary) throw new AdminError("ADMIN_PLAYER_NOT_FOUND", 404, "no such player");
    return summary;
  }

  /** Audit row inside the transaction of the change it describes. */
  private record(session: DbSession, ctx: AdminContext, action: string, target: string, payload: unknown): Promise<void> {
    return this.deps.repo.insertAudit({ ip: ctx.ip, action, target, payload }, session);
  }

  private contentAudit(ctx: AdminContext, action: string, target: string, payload: unknown): Promise<void> {
    return this.deps.repo.insertAudit({ ip: ctx.ip, action, target, payload });
  }
}
