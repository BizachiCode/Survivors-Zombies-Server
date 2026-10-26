import { eq } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { serverSettings } from "../../infrastructure/database/schema/admin.schema.js";

/** Persistence port of small server-side bookkeeping values (poll cursors). */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class DrizzleSettingsRepository extends DrizzleRepository implements SettingsRepository {
  async get(key: string): Promise<string | null> {
    const rows = await this.database.select({ value: serverSettings.value }).from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.database.insert(serverSettings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
  }
}
