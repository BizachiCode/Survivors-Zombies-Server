// `npm run db:migrate`: create the database if needed, apply the migrations and exit.
import { env } from "../../config/env.js";
import { db, pool } from "./drizzle.js";
import { prepareDatabase } from "./migrate.js";

prepareDatabase(db, env.mysql)
  .then(() => pool.end())
  .catch(async (error: Error) => {
    console.error(error.message);
    await pool.end().catch((): void => undefined);
    process.exit(1);
  });
