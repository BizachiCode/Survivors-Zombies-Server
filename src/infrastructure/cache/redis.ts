// Redis client (sessions) and the Redis-backed active session store (one session per user + device).

import Redis from "ioredis";

import { env } from "../../config/env.js";
import { createLogger } from "../../shared/logger.js";
import type { SessionData, SessionStore } from "../../shared/security/session-store.js";

const logger = createLogger("Redis");

export function createRedis(): Redis {
  const redis = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    db: env.redis.db,
    keyPrefix: env.redis.keyPrefix,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 5000)),
    lazyConnect: true,
  });
  redis.on("error", (error) => logger.error("connection error:", error.message));
  return redis;
}

export class RedisSessionStore implements SessionStore {
  private readonly ttlSeconds: number;

  constructor(private readonly redis: Redis, accessTtlMinutes: number) {
    this.ttlSeconds = Math.max(60, accessTtlMinutes * 60);
  }

  private sessionKey(userId: string, deviceKey: string): string {
    return `session:${userId}:${deviceKey}`;
  }

  private indexKey(userId: string): string {
    return `session_index:${userId}`;
  }

  async setSession(userId: string, deviceKey: string, data: SessionData): Promise<void> {
    await this.redis.multi()
      .setex(this.sessionKey(userId, deviceKey), this.ttlSeconds, JSON.stringify(data))
      .sadd(this.indexKey(userId), deviceKey)
      .expire(this.indexKey(userId), this.ttlSeconds)
      .exec();
  }

  async getSession(userId: string, deviceKey: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.sessionKey(userId, deviceKey));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  async deleteSession(userId: string, deviceKey: string): Promise<void> {
    await this.redis.multi().del(this.sessionKey(userId, deviceKey)).srem(this.indexKey(userId), deviceKey).exec();
  }

  async deleteAllSessions(userId: string): Promise<void> {
    const deviceKeys = await this.redis.smembers(this.indexKey(userId));
    const tx = this.redis.multi();
    for (const deviceKey of deviceKeys) tx.del(this.sessionKey(userId, deviceKey));
    tx.del(this.indexKey(userId));
    await tx.exec();
  }

  async deleteSessionsExcept(userId: string, keepDeviceKey: string): Promise<string[]> {
    const deviceKeys = (await this.redis.smembers(this.indexKey(userId))).filter((key) => key !== keepDeviceKey);
    if (deviceKeys.length === 0) return [];
    const tx = this.redis.multi();
    for (const deviceKey of deviceKeys) tx.del(this.sessionKey(userId, deviceKey)).srem(this.indexKey(userId), deviceKey);
    await tx.exec();
    return deviceKeys;
  }

  async touchSession(userId: string, deviceKey: string): Promise<void> {
    await this.redis.multi()
      .expire(this.sessionKey(userId, deviceKey), this.ttlSeconds)
      .expire(this.indexKey(userId), this.ttlSeconds)
      .exec();
  }
}
