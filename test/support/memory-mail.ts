// In-memory adapter of the mail port (kept apart from MemoryStore: mail writes happen after the ledger writes of a
// transaction, so a failed grant never leaves a half-claimed mail behind).

import type { DbSession } from "../../src/shared/kernel/unit-of-work.js";
import type { MailRepository, MailRow } from "../../src/modules/mail/mail.repository.js";

const clone = (row: MailRow): MailRow => structuredClone(row);
const active = (row: MailRow, now: Date) => !row.deletedAt && (!row.expiresAt || row.expiresAt.getTime() > now.getTime());

export class MemoryMailRepository implements MailRepository {
  readonly rows = new Map<string, MailRow>();

  async listActive(userId: string, now: Date): Promise<MailRow[]> {
    return [...this.rows.values()].filter((row) => row.userId === userId && active(row, now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }

  async lockClaimable(userId: string, now: Date, _session: DbSession): Promise<MailRow[]> {
    return [...this.rows.values()].filter((row) => row.userId === userId && active(row, now) && !row.claimedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }

  async get(userId: string, mailId: string): Promise<MailRow | null> {
    const row = this.rows.get(mailId);
    return row && row.userId === userId ? clone(row) : null;
  }

  async deliveredBroadcasts(userId: string, broadcastIds: readonly string[]): Promise<Set<string>> {
    return new Set([...this.rows.values()].filter((row) => row.userId === userId && row.broadcastId && broadcastIds.includes(row.broadcastId)).map((row) => row.broadcastId!));
  }

  async insert(row: MailRow): Promise<boolean> {
    if (row.broadcastId && [...this.rows.values()].some((r) => r.userId === row.userId && r.broadcastId === row.broadcastId)) return false;
    this.rows.set(row.id, clone(row));
    return true;
  }

  async markRead(userId: string, mailId: string, at: Date): Promise<void> {
    const row = this.rows.get(mailId);
    if (row && row.userId === userId && !row.readAt) row.readAt = at;
  }

  async markClaimed(userId: string, mailIds: readonly string[], at: Date): Promise<void> {
    for (const id of mailIds) {
      const row = this.rows.get(id);
      if (!row || row.userId !== userId) continue;
      row.readAt ??= at;
      row.claimedAt = at;
    }
  }

  async markDeleted(userId: string, mailId: string, at: Date): Promise<void> {
    const row = this.rows.get(mailId);
    if (row && row.userId === userId) row.deletedAt = at;
  }
}
