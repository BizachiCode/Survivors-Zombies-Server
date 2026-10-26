// Express routes mounted next to the Colyseus transport (health, dev tools) and the HTTP hardening shared with the
// matchmaking endpoints: security headers, CORS, request size guard, JSON errors.

import type http from "node:http";
import { matchMaker, ServerError } from "@colyseus/core";
import { monitor } from "@colyseus/monitor";
import { playground } from "@colyseus/playground";
import type express from "express";

import { createLogger } from "../shared/logger.js";
import { expressTrustProxySetting } from "../shared/rooms/client-address.js";
import type { AdminModule } from "../modules/admin/admin.module.js";
import type { IapRefunds } from "../modules/iap/iap-refunds.js";
import type { AppContainer } from "./container.js";

const logger = createLogger("Http");

/** Headers every response carries (API answers and matchmaking replies). */
const BASELINE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function applyBaselineHeaders(res: http.ServerResponse): void {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) res.setHeader(name, value);
}

type CorsController = {
  DEFAULT_CORS_HEADERS: Record<string, string>;
  getCorsHeaders: (headers: Headers) => Record<string, string>;
};

/**
 * CORS of the matchmaking endpoints (`/matchmake/*`). Colyseus' defaults answer the caller's own Origin together with
 * `Allow-Credentials: true`, which opens the API to every web page. Only `CORS_ORIGINS` get an
 * `Access-Control-Allow-Origin`; native clients send no Origin and need none.
 */
export function configureMatchmakingCors(allowedOrigins: readonly string[], controller: CorsController = matchMaker.controller as unknown as CorsController): void {
  controller.DEFAULT_CORS_HEADERS = {
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
  controller.getCorsHeaders = (headers: Headers) => {
    const origin = headers.get("origin");
    return origin && allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  };
}

type InvokeController = { invokeMethod: (...args: any[]) => Promise<unknown> };

/**
 * Colyseus answers matchmaking failures with its own 52x codes (525 = onAuth failed), which proxies such as Cloudflare
 * replace with their own error page. They are sent as regular statuses (525 -> 401, the status the client treats as
 * "renew the token and join again"); any code outside 100-599 (a close code thrown by a room) becomes 400.
 */
const PROXY_SAFE_MATCHMAKE_STATUS: Readonly<Record<number, number>> = { 520: 404, 521: 400, 522: 404, 523: 400, 524: 410, 525: 401 };

export function guardMatchmakeErrorCodes(controller: InvokeController = matchMaker.controller as unknown as InvokeController): void {
  const original = controller.invokeMethod.bind(controller);
  controller.invokeMethod = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (error) {
      const code = Number((error as { code?: unknown })?.code);
      const message = error instanceof Error ? error.message : "matchmaking failed";
      const proxied = PROXY_SAFE_MATCHMAKE_STATUS[code];
      if (proxied) throw new ServerError(proxied, `${message} (code ${code})`);
      if (Number.isInteger(code) && code >= 100 && code <= 599) throw error;
      throw new ServerError(400, `${message} (code ${String((error as { code?: unknown })?.code ?? "unknown")})`);
    }
  };
}

/**
 * Wraps the HTTP server's `request` event so it runs before Colyseus' own listener (the matchmaking endpoints read the
 * whole body into memory): oversized bodies are answered 413 here and never reach Colyseus or Express.
 */
export function installRequestGuard(server: http.Server, maxBodyBytes: number): void {
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  const originalEmit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
  (server as unknown as { emit: typeof originalEmit }).emit = (event, ...args) => {
    if (event !== "request") return originalEmit(event, ...args);
    const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
    applyBaselineHeaders(res);
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > maxBodyBytes) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Connection", "close");
      res.end(JSON.stringify({ ok: false, error: "PAYLOAD_TOO_LARGE" }));
      return true;
    }
    return originalEmit(event, ...args);
  };
}

/** Last error handler: JSON only, never a stack trace or driver message. */
const jsonErrorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  logger.error("unhandled http error:", error);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
};

/** Parts the composition root adds for the HTTP surface (admin panel, store notifications); absent = not mounted. */
export type HttpExtras = {
  admin?: AdminModule;
  iapRefunds?: IapRefunds;
};

export function configureHttp(app: express.Application, container: AppContainer & HttpExtras): void {
  const { config } = container;
  app.disable("x-powered-by");
  app.set("trust proxy", expressTrustProxySetting({ trustProxy: config.trustProxy, trustedProxies: config.trustedProxies }));

  // Developer tools: room inspector and a test client. Never mounted in production (env.ts refuses DEV_TOOLS there).
  if (config.devTools) {
    app.use("/monitor", monitor());
    app.use("/playground", playground());
  }

  app.get("/health", (_req, res) => {
    const maintenance = container.admin ? container.admin.maintenance.isEnabled() : config.maintenanceMode;
    res.json({ ok: true, status: maintenance ? "maintenance" : "ok", serverTimeUnix: Math.floor(Date.now() / 1000) });
  });

  // App Store Server Notifications V2 (refunds): only with APPLE_BUNDLE_ID. Configure the URL in App Store Connect.
  if (container.iapRefunds?.appleRouter) app.use("/iap/apple/notifications", container.iapRefunds.appleRouter);

  // Admin panel (/admin) and API (/admin/api): only with ADMIN_TOKEN, otherwise these paths answer 404 like any unknown route.
  if (container.admin?.router) app.use("/admin", container.admin.router);

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: "NOT_FOUND" });
  });
  app.use(jsonErrorHandler);
}
