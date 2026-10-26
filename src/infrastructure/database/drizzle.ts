// Shared mysql2 pool + Drizzle ORM instance (MySQL 8 / MariaDB 10.5+).

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { env } from "../../config/env.js";
import * as schema from "./schema/index.js";

export const pool = mysql.createPool({
  host: env.mysql.host,
  port: env.mysql.port,
  user: env.mysql.user,
  password: env.mysql.password,
  database: env.mysql.database,
  connectionLimit: env.mysql.connectionLimit,
  charset: "utf8mb4",
  // DATETIME columns are written/read as UTC so "now" comparisons don't depend on the host timezone.
  timezone: "Z",
  dateStrings: false,
});

// Keep NOW()/CURRENT_TIMESTAMP in UTC as well, matching the "Z" driver timezone above.
pool.on("connection", (connection: { query: (sql: string) => unknown }) => {
  connection.query("SET time_zone = '+00:00'");
});

export const db = drizzle(pool, { schema, mode: "default" });

export type Database = typeof db;
