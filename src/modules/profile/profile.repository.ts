import { eq } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type ProfileRow = {
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
  exp: number;
};

/** Persistence port for player profiles. */
export interface ProfileRepository {
  /** Creates the profile when missing (first sign-in); never overwrites an existing one. */
  ensureProfile(userId: string, nickname: string, session: DbSession): Promise<void>;
  /** `forUpdate` (inside a transaction) locks the row. */
  getProfile(userId: string, session?: DbSession, forUpdate?: boolean): Promise<ProfileRow | null>;
  updateNickname(userId: string, nickname: string, session: DbSession): Promise<void>;
  updateAvatar(userId: string, avatarId: string, session?: DbSession): Promise<void>;
  /** Level and the experience inside it (rewards; see profile/experience.ts). */
  updateLevel(userId: string, level: number, exp: number, session: DbSession): Promise<void>;
}

export class DrizzleProfileRepository extends DrizzleRepository implements ProfileRepository {
  async ensureProfile(userId: string, nickname: string, session: DbSession): Promise<void> {
    await this.db(session).insert(userProfile).values({ userId, nickname }).onDuplicateKeyUpdate({ set: { userId } });
  }

  async getProfile(userId: string, session?: DbSession, forUpdate = false): Promise<ProfileRow | null> {
    const query = this.db(session)
      .select({ userId: userProfile.userId, nickname: userProfile.nickname, avatarId: userProfile.avatarId, level: userProfile.level, exp: userProfile.exp })
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async updateNickname(userId: string, nickname: string, session: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ nickname }).where(eq(userProfile.userId, userId));
  }

  async updateAvatar(userId: string, avatarId: string, session?: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ avatarId }).where(eq(userProfile.userId, userId));
  }

  async updateLevel(userId: string, level: number, exp: number, session: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ level, exp }).where(eq(userProfile.userId, userId));
  }
}
