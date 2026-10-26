// Mail use cases: delivering broadcasts into inboxes (once per player), listing, reading, claiming attachments (all or
// nothing through RewardGranter, in the same transaction that marks the mail claimed) and deleting. Attachments come only
// from the content file or from server code (`send`), never from the client.

import { randomUUID } from "node:crypto";

import { HotJsonFile } from "../../shared/content/hot-json-file.js";
import { normalizeLanguage, resolveText, type Language, type LocalizedText } from "../../shared/content/localized-text.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import { isEmptyReward, unknownRewardItems, type RewardBundle, type RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileDto } from "../profile/profile.dto.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import { MailContentSchema, type MailBroadcast, type MailContent } from "./mail-content.js";
import type { MailRepository, MailRow } from "./mail.repository.js";

/** Deleting a mail whose attachments were not claimed yet is refused with this code (add it to ErrorCode when convenient). */
export const MAIL_UNCLAIMED = ErrorCode.MAIL_UNCLAIMED;

const DAY_MS = 86_400_000;

export type MailDto = {
  id: string;
  title: string;
  body: string;
  sender: string;
  attachments: RewardBundle;
  sentAtUnix: number;
  /** 0 = never. */
  expiresAtUnix: number;
  read: boolean;
  claimed: boolean;
};

export type MailboxDto = { mails: MailDto[]; unread: number; claimable: number };

/** `claim` / `claim_all`: the inbox plus what was granted and the new HUD state. */
export type ClaimDto = MailboxDto & {
  granted: RewardBundle;
  levelsGained: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ProfileDto;
};

/** A message sent by server code to one player. */
export type MailDraft = {
  sender: string;
  title: LocalizedText;
  body: LocalizedText;
  attachments?: RewardBundle;
  /** Absent = never expires. */
  expiresAt?: Date;
};

const hasAttachments = (row: MailRow) => !isEmptyReward(row.attachments);

export class MailService {
  private readonly broadcasts: HotJsonFile<MailContent>;

  constructor(
    contentPath: string,
    private readonly mails: MailRepository,
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly knownItem: (itemId: string) => boolean,
  ) {
    this.broadcasts = new HotJsonFile(contentPath, MailContentSchema, { broadcasts: [] }, createLogger("Mail"), (content) => {
      for (const broadcast of content.broadcasts) {
        const unknown = unknownRewardItems(broadcast.attachments, knownItem);
        if (unknown.length > 0) throw new Error(`Broadcast ${broadcast.id}: unknown item ${unknown.join(", ")}.`);
      }
    });
  }

  /** Delivers the broadcasts the player has not received yet, then lists the inbox. */
  async info(userId: string, lang?: string): Promise<MailboxDto> {
    await this.deliverBroadcasts(userId);
    return this.mailbox(userId, normalizeLanguage(lang));
  }

  async read(userId: string, mailId: string, lang?: string): Promise<MailboxDto> {
    const now = this.clock.now();
    const row = await this.mails.get(userId, mailId);
    this.requireActive(row, now);
    if (!row!.readAt) await this.mails.markRead(userId, mailId, now);
    return this.mailbox(userId, normalizeLanguage(lang));
  }

  /** Grants one mail's attachments (all or nothing) and marks it claimed and read. */
  async claim(userId: string, mailId: string, lang?: string): Promise<ClaimDto> {
    const now = this.clock.now();
    const { granted, levelsGained } = await this.uow.transaction(async (session) => {
      const row = await this.mails.get(userId, mailId, session, true);
      this.requireActive(row, now);
      if (!hasAttachments(row!)) throw new AppError(ErrorCode.MAIL_NO_ATTACHMENTS);
      if (row!.claimedAt) throw new AppError(ErrorCode.MAIL_ALREADY_CLAIMED);
      const result = await this.rewards.grant(session, userId, row!.attachments, "MAIL_ATTACHMENT");
      await this.mails.markClaimed(userId, [mailId], now, session);
      return { granted: row!.attachments, levelsGained: result.levelsGained };
    });
    return this.claimAnswer(userId, normalizeLanguage(lang), granted, levelsGained);
  }

  /** Grants every claimable mail in one transaction (one combined grant). MAIL_NO_ATTACHMENTS when there is nothing to claim. */
  async claimAll(userId: string, lang?: string): Promise<ClaimDto> {
    const now = this.clock.now();
    const { granted, levelsGained } = await this.uow.transaction(async (session) => {
      const rows = (await this.mails.lockClaimable(userId, now, session))
        .filter((row) => hasAttachments(row) && unknownRewardItems(row.attachments, this.knownItem).length === 0);
      if (rows.length === 0) throw new AppError(ErrorCode.MAIL_NO_ATTACHMENTS);
      const total = mergeRewards(rows.map((row) => row.attachments));
      const result = await this.rewards.grant(session, userId, total, "MAIL_ATTACHMENT");
      await this.mails.markClaimed(userId, rows.map((row) => row.id), now, session);
      return { granted: total, levelsGained: result.levelsGained };
    });
    return this.claimAnswer(userId, normalizeLanguage(lang), granted, levelsGained);
  }

  /** Removes a mail from the inbox. Refused (MAIL_UNCLAIMED) while it still has unclaimed attachments. */
  async delete(userId: string, mailId: string, lang?: string): Promise<MailboxDto> {
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      const row = await this.mails.get(userId, mailId, session, true);
      if (!row || row.deletedAt) throw new AppError(ErrorCode.MAIL_UNKNOWN);
      const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
      if (hasAttachments(row) && !row.claimedAt && !expired) throw new AppError(ErrorCode.MAIL_UNCLAIMED);
      await this.mails.markDeleted(userId, mailId, now, session);
    });
    return this.mailbox(userId, normalizeLanguage(lang));
  }

  /** Sends a message to one player from server code (compensation, rewards of other features); runs in the caller's transaction. */
  async send(session: DbSession, userId: string, draft: MailDraft): Promise<string> {
    const attachments = draft.attachments ?? { currencies: {}, items: {}, exp: 0 };
    const unknown = unknownRewardItems(attachments, this.knownItem);
    if (unknown.length > 0) throw new Error(`Mail attachments: unknown item ${unknown.join(", ")}.`);
    const id = randomUUID();
    await this.mails.insert({
      id, userId, broadcastId: null, sender: draft.sender, title: draft.title, body: draft.body, attachments,
      createdAt: this.clock.now(), expiresAt: draft.expiresAt ?? null, readAt: null, claimedAt: null, deletedAt: null,
    }, session);
    return id;
  }

  // ------------------------------------------------------------------ internals

  private async deliverBroadcasts(userId: string): Promise<void> {
    const nowMs = this.clock.nowMs();
    const active = this.broadcasts.get().broadcasts.filter((b) => isActive(b, nowMs));
    if (active.length === 0) return;
    const delivered = await this.mails.deliveredBroadcasts(userId, active.map((b) => b.id));
    for (const broadcast of active) {
      if (delivered.has(broadcast.id)) continue;
      await this.mails.insert({
        id: randomUUID(),
        userId,
        broadcastId: broadcast.id,
        sender: broadcast.sender,
        title: broadcast.title,
        body: broadcast.body,
        attachments: broadcast.attachments,
        createdAt: new Date(nowMs),
        expiresAt: broadcast.expiresAfterDays > 0 ? new Date(nowMs + broadcast.expiresAfterDays * DAY_MS) : null,
        readAt: null,
        claimedAt: null,
        deletedAt: null,
      });
    }
  }

  /** Throws unless `row` exists, is not deleted and has not expired. */
  private requireActive(row: MailRow | null, now: Date): void {
    if (!row || row.deletedAt) throw new AppError(ErrorCode.MAIL_UNKNOWN);
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) throw new AppError(ErrorCode.MAIL_EXPIRED);
  }

  private async mailbox(userId: string, lang: Language): Promise<MailboxDto> {
    const rows = await this.mails.listActive(userId, this.clock.now());
    const mails = rows.map((row): MailDto => ({
      id: row.id,
      title: resolveText(row.title, lang),
      body: resolveText(row.body, lang),
      sender: row.sender,
      attachments: { currencies: row.attachments.currencies ?? {}, items: row.attachments.items ?? {}, exp: row.attachments.exp ?? 0 },
      sentAtUnix: Math.floor(row.createdAt.getTime() / 1000),
      expiresAtUnix: row.expiresAt ? Math.floor(row.expiresAt.getTime() / 1000) : 0,
      read: row.readAt !== null,
      claimed: row.claimedAt !== null,
    }));
    return {
      mails,
      unread: rows.filter((row) => row.readAt === null).length,
      claimable: rows.filter((row) => hasAttachments(row) && row.claimedAt === null).length,
    };
  }

  private async claimAnswer(userId: string, lang: Language, granted: RewardBundle, levelsGained: number): Promise<ClaimDto> {
    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    return {
      ...(await this.mailbox(userId, lang)),
      granted,
      levelsGained,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }
}

function isActive(broadcast: MailBroadcast, nowMs: number): boolean {
  if (broadcast.startsAt && Date.parse(broadcast.startsAt) > nowMs) return false;
  if (broadcast.endsAt && Date.parse(broadcast.endsAt) <= nowMs) return false;
  return true;
}

/** Sums reward bundles (the combined grant of claim-all). */
export function mergeRewards(rewards: readonly RewardBundle[]): RewardBundle {
  const total: RewardBundle = { currencies: {}, items: {}, exp: 0 };
  for (const reward of rewards) {
    for (const [id, amount] of Object.entries(reward.currencies ?? {})) {
      total.currencies[id as keyof RewardBundle["currencies"]] = (total.currencies[id as keyof RewardBundle["currencies"]] ?? 0) + (amount ?? 0);
    }
    for (const [id, amount] of Object.entries(reward.items ?? {})) total.items[id] = (total.items[id] ?? 0) + amount;
    total.exp += reward.exp ?? 0;
  }
  return total;
}
