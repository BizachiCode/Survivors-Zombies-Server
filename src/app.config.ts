// Colyseus server definition: rooms, HTTP routes and boot hooks (wired from the composition root).

import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { createContainer } from "./app/container.js";
import { configureHttp, configureMatchmakingCors, guardMatchmakeErrorCodes, installRequestGuard } from "./app/http.js";
import { env } from "./config/env.js";
import { createRedis } from "./infrastructure/cache/redis.js";
import { db } from "./infrastructure/database/drizzle.js";
import { createLogger } from "./shared/logger.js";
import { configureRoomAuthentication } from "./shared/rooms/authenticated-room.js";

const logger = createLogger("Bootstrap");

export const redis = env.sessionStore === "redis" || env.chatHistoryStore === "redis" ? createRedis() : undefined;
export const container = createContainer({ config: env, database: db, redis });

configureRoomAuthentication(container.authenticator, { ipLimiter: container.limiters.ip, joinLimiter: container.limiters.join });
configureMatchmakingCors(env.corsOrigins);
guardMatchmakeErrorCodes();

const transport = new WebSocketTransport({ maxPayload: env.wsMaxPayloadBytes });
if (transport.server) installRequestGuard(transport.server, env.httpMaxBodyBytes);

export const server = defineServer({
  transport,
  greet: false,

  rooms: {
    auth: defineRoom(container.rooms.auth),
    account: defineRoom(container.rooms.account),
    profile: defineRoom(container.rooms.profile),
    campaign: defineRoom(container.rooms.campaign),
    battle: defineRoom(container.rooms.battle),
    collection: defineRoom(container.rooms.collection),
    shop: defineRoom(container.rooms.shop),
    objectives: defineRoom(container.rooms.objectives),
    daily: defineRoom(container.rooms.daily),
    news: defineRoom(container.rooms.news),
    mail: defineRoom(container.rooms.mail),
    ranking: defineRoom(container.rooms.ranking),
    chat: defineRoom(container.rooms.chat).filterBy(["channel"]),
    iap: defineRoom(container.rooms.iap),
    wheel: defineRoom(container.rooms.wheel),
    friends: defineRoom(container.rooms.friends),
    arena: defineRoom(container.rooms.arena),
    clan: defineRoom(container.rooms.clan),
    tower: defineRoom(container.rooms.tower),
  },

  express: (app) => configureHttp(app, container),

  beforeListen: async () => {
    logger.info(`Battle content: ${container.catalog.stages.length} stages (${env.battleContentPath}, sha256 ${container.catalog.fingerprint.slice(0, 12)})`);
    if (redis) {
      try {
        await redis.connect();
        logger.info(`Redis ready (${env.redis.host}:${env.redis.port}, db ${env.redis.db})`);
      } catch (error) {
        throw new Error(`Cannot reach Redis at ${env.redis.host}:${env.redis.port}: ${(error as Error).message}. Start Redis, or set SESSION_STORE=memory and CHAT_HISTORY_STORE=db (or memory) in .env.`);
      }
    }
    if (env.sessionStore === "memory") logger.warn("SESSION_STORE=memory: sessions live in this process only (development / single process).");
    if (env.chatHistoryStore === "memory") logger.warn("CHAT_HISTORY_STORE=memory: the chat history is lost when the server restarts.");
    else logger.info(`Chat history stored in ${env.chatHistoryStore === "db" ? "the database (chat_messages)" : "Redis"}`);
    // Google refunds: polls the voided purchases API when a service account is configured.
    container.iapRefunds.googlePoller?.start();
  },
});

export default server;
