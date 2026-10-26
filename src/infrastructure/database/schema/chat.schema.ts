// Chat history (CHAT_HISTORY_STORE=db): the last messages of every channel, so the history survives restarts and deploys.
// Written only by the chat service; each channel keeps at most the history size of the chat config (older rows are deleted).
import { bigint, boolean, int, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const chatMessages = mysqlTable("chat_messages", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  /** `global` or `clan:<clanId>`. */
  channel: varchar("channel", { length: 80 }).notNull(),
  /** Message id inside the channel (grows; `0` is the welcome line, never stored). */
  messageId: int("message_id", { unsigned: true }).notNull(),
  /** Public id of the sender (first 8 hex digits of the user id); empty for system lines. */
  userId: varchar("user_id", { length: 16 }).notNull(),
  nickname: varchar("nickname", { length: 64 }).notNull(),
  avatarId: varchar("avatar_id", { length: 64 }).notNull(),
  level: int("level", { unsigned: true }).notNull(),
  text: varchar("text", { length: 1024 }).notNull(),
  system: boolean("system").notNull(),
  /** System lines: translation key and arguments for the client. */
  textKey: varchar("text_key", { length: 128 }),
  args: json("args").$type<string[]>(),
  atUnix: int("at_unix", { unsigned: true }).notNull(),
}, (t) => [
  uniqueIndex("uq_chat_messages_channel_message").on(t.channel, t.messageId),
]);
