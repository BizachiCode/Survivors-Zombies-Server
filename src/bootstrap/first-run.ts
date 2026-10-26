// Development convenience: on the very first `npm start`, create `.env` from `.env.example` with
// freshly generated secrets. When another tool wrote `.env` first (`npm run devdb:init` only writes the database lines),
// the missing settings are added from `.env.example` and the missing or empty secrets are generated; values that are
// already set are never changed. Never runs in production (production must be configured explicitly).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GENERATED_SECRETS = ["JWT_ACCESS_SECRET", "PASSWORD_PEPPER", "REFRESH_PEPPER", "DEVICE_PEPPER"];

const keyOf = (line: string): string | null => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1] ?? null;
const newSecret = () => crypto.randomBytes(32).toString("base64url");

export function ensureDevEnvFile(cwd = process.cwd()): string | null {
  if ((process.env.NODE_ENV || "development") === "production") return null;

  const envPath = path.join(cwd, ".env");
  const examplePath = path.join(cwd, ".env.example");
  if (!fs.existsSync(examplePath)) return null;
  const example = fs.readFileSync(examplePath, "utf8").split(/\r?\n/);

  if (!fs.existsSync(envPath)) {
    const content = example.map((line) => {
      const key = keyOf(line);
      return key && GENERATED_SECRETS.includes(key) ? `${key}=${newSecret()}` : line;
    }).join("\n");
    fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
    console.log(`[setup] Created ${envPath} from .env.example with random secrets.`);
    console.log("[setup] Edit MYSQL_* / REDIS_* in .env if your database or Redis differ from the defaults.");
    return envPath;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const present = new Set(lines.map(keyOf).filter((key): key is string => key !== null));
  let changed = 0;
  // A secret line that exists but is empty gets a value.
  const completed = lines.map((line) => {
    const key = keyOf(line);
    if (!key || !GENERATED_SECRETS.includes(key) || line.slice(line.indexOf("=") + 1).trim() !== "") return line;
    changed++;
    return `${key}=${newSecret()}`;
  });
  // A setting of .env.example that .env does not have is added (secrets with a new value).
  const missing = example.filter((line) => {
    const key = keyOf(line);
    return key !== null && !present.has(key);
  }).map((line) => {
    const key = keyOf(line)!;
    return GENERATED_SECRETS.includes(key) ? `${key}=${newSecret()}` : line;
  });
  if (changed === 0 && missing.length === 0) return null;

  while (completed.length > 0 && completed[completed.length - 1].trim() === "") completed.pop();
  const content = [...completed, ...(missing.length ? ["", "# Added from .env.example on first start", ...missing] : [])].join("\n") + "\n";
  fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  console.log(`[setup] Completed ${envPath}: ${missing.length} setting(s) added from .env.example, ${changed} empty secret(s) generated.`);
  return envPath;
}

ensureDevEnvFile();
