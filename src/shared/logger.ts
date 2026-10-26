// Scoped console logger. Kept behind an interface so a log sink (files, database, GM panel) can replace it later.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minimum: LogLevel = (["debug", "info", "warn", "error"] as LogLevel[]).find((l) => l === process.env.LOG_LEVEL) ?? "info";
const silent = process.env.NODE_ENV === "test";

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const write = (level: LogLevel, message: string, details: unknown[]) => {
    if (silent || ORDER[level] < ORDER[minimum]) return;
    const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), prefix, message];
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(...line, ...details);
  };
  return {
    debug: (message, ...details) => write("debug", message, details),
    info: (message, ...details) => write("info", message, details),
    warn: (message, ...details) => write("warn", message, details),
    error: (message, ...details) => write("error", message, details),
  };
}
