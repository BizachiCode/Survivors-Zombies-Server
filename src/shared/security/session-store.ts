/** Cached server-side session (one per user + device). Deleting it kicks the device. */
export type SessionData = {
  accessJti: string;
};

/** Port for the active-session store (Redis in production, in-memory for tests or a single dev process). */
export interface SessionStore {
  setSession(userId: string, deviceKey: string, data: SessionData): Promise<void>;
  getSession(userId: string, deviceKey: string): Promise<SessionData | null>;
  deleteSession(userId: string, deviceKey: string): Promise<void>;
  deleteAllSessions(userId: string): Promise<void>;
  /** Deletes every session of the user except `keepDeviceKey`; returns the device keys that were removed. */
  deleteSessionsExcept(userId: string, keepDeviceKey: string): Promise<string[]>;
  touchSession(userId: string, deviceKey: string): Promise<void>;
}

/** Process-local session store with the same expiry rule as Redis (sliding TTL). */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Map<string, { data: SessionData; expiresAt: number }>>();
  private readonly ttlMs: number;

  constructor(ttlMinutes: number, private readonly now: () => number = Date.now) {
    this.ttlMs = Math.max(60, ttlMinutes * 60) * 1000;
  }

  async setSession(userId: string, deviceKey: string, data: SessionData): Promise<void> {
    let devices = this.sessions.get(userId);
    if (!devices) this.sessions.set(userId, (devices = new Map()));
    devices.set(deviceKey, { data: { ...data }, expiresAt: this.now() + this.ttlMs });
  }

  async getSession(userId: string, deviceKey: string): Promise<SessionData | null> {
    const entry = this.sessions.get(userId)?.get(deviceKey);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.sessions.get(userId)?.delete(deviceKey);
      return null;
    }
    return { ...entry.data };
  }

  async deleteSession(userId: string, deviceKey: string): Promise<void> {
    this.sessions.get(userId)?.delete(deviceKey);
  }

  async deleteAllSessions(userId: string): Promise<void> {
    this.sessions.delete(userId);
  }

  async deleteSessionsExcept(userId: string, keepDeviceKey: string): Promise<string[]> {
    const devices = this.sessions.get(userId);
    if (!devices) return [];
    const removed = [...devices.keys()].filter((key) => key !== keepDeviceKey);
    for (const key of removed) devices.delete(key);
    return removed;
  }

  async touchSession(userId: string, deviceKey: string): Promise<void> {
    const entry = this.sessions.get(userId)?.get(deviceKey);
    if (entry) entry.expiresAt = this.now() + this.ttlMs;
  }
}
