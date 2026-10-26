// Process entry point (`npm start` / `npm run start:prod`).
import "./bootstrap/first-run.js";
import { listen } from "@colyseus/tools";

import server, { redis } from "./app.config.js";
import { env } from "./config/env.js";
import { db, pool } from "./infrastructure/database/drizzle.js";
import { prepareDatabase } from "./infrastructure/database/migrate.js";
import { createLogger } from "./shared/logger.js";

const logger = createLogger("Server");

// Colyseus handles SIGTERM/SIGINT (graceful shutdown); release our own resources afterwards.
server.onShutdown(async () => {
  await redis?.quit().catch((): void => undefined);
  await pool.end().catch((): void => undefined);
});

async function main(): Promise<void> {
  if (env.dbAutoMigrate) await prepareDatabase(db, env.mysql, (message) => logger.info(message));
  await listen(server, env.port);
  logger.info(`Card Tower Defense server listening on ws://localhost:${env.port} (${env.nodeEnv})${env.devTools ? " - monitor: /monitor, playground: /playground" : ""}`);
}

main().catch(async (error: Error) => {
  console.error(`\n[startup] ${error.message}\n`);
  await pool.end().catch((): void => undefined);
  process.exit(1);
});
