// First start in development: `.env` is created from `.env.example` with new secrets, and a `.env` written first by
// another tool (`npm run devdb:init` writes only the database lines) is completed without changing its values.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type FirstRun = typeof import("../src/bootstrap/first-run.js");

describe("first run .env setup", () => {
  let firstRun: FirstRun;
  let dir: string;
  const env = () => fs.readFileSync(path.join(dir, ".env"), "utf8");
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(env())?.[1];

  before(async () => {
    // Importing the module runs it on the current folder: keep that a no-op (production never writes .env).
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    firstRun = await import("../src/bootstrap/first-run.js");
    process.env.NODE_ENV = previous;
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctd-first-run-"));
    fs.writeFileSync(path.join(dir, ".env.example"), [
      "NODE_ENV=development",
      "JWT_ACCESS_SECRET=change-me-access",
      "PASSWORD_PEPPER=change-me-pepper",
      "REFRESH_PEPPER=change-me-refresh",
      "DEVICE_PEPPER=change-me-device",
      "MYSQL_HOST=127.0.0.1",
      "MYSQL_PORT=3306",
      "# MYSQL_SSL=false",
      "SESSION_STORE=redis",
      "",
    ].join("\n"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates .env with new secrets", () => {
    assert.ok(firstRun.ensureDevEnvFile(dir));
    for (const key of ["JWT_ACCESS_SECRET", "PASSWORD_PEPPER", "REFRESH_PEPPER", "DEVICE_PEPPER"]) {
      assert.match(value(key) ?? "", /^[A-Za-z0-9_-]{40,}$/);
    }
    assert.equal(value("MYSQL_PORT"), "3306");
  });

  it("completes a .env written by devdb:init and keeps its values", () => {
    fs.writeFileSync(path.join(dir, ".env"), "DEVDB_PORT=3307\nMYSQL_PORT=3307\nMYSQL_PASSWORD=devdb-pass\nPASSWORD_PEPPER=\n");
    assert.ok(firstRun.ensureDevEnvFile(dir));
    assert.equal(value("MYSQL_PORT"), "3307");
    assert.equal(value("MYSQL_PASSWORD"), "devdb-pass");
    assert.equal(value("DEVDB_PORT"), "3307");
    assert.equal(value("SESSION_STORE"), "redis");
    assert.equal(value("MYSQL_HOST"), "127.0.0.1");
    assert.match(value("JWT_ACCESS_SECRET") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    assert.match(value("PASSWORD_PEPPER") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(env().match(/^MYSQL_PORT=/gm)?.length, 1);
  });

  it("leaves a complete .env alone and never runs in production", () => {
    assert.ok(firstRun.ensureDevEnvFile(dir));
    const before = env();
    assert.equal(firstRun.ensureDevEnvFile(dir), null);
    assert.equal(env(), before);

    fs.rmSync(path.join(dir, ".env"));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(firstRun.ensureDevEnvFile(dir), null);
      assert.equal(fs.existsSync(path.join(dir, ".env")), false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
