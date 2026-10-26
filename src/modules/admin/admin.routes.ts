// HTTP surface of the admin panel, mounted at `/admin`:
//   /admin                 static single-page panel (folder `admin/`), no token needed to load it
//   /admin/api/*           JSON API, `Authorization: Bearer <ADMIN_TOKEN>` (see admin.gate.ts, docs/PROTOCOL.md)
// Answers are `{ ok: true, ...data }` or `{ ok: false, error: "CODE", ... }`.

import express from "express";
import { ZodError, type ZodType } from "zod";

import { isAppError } from "../../shared/errors/app-error.js";
import { createLogger } from "../../shared/logger.js";
import { AdminError } from "./admin-error.js";
import type { AdminGate } from "./admin.gate.js";
import type { AdminContext, AdminService } from "./admin.service.js";
import {
  AdjustSchema, AuditQuerySchema, BanSchema, contentIdParam, MaintenanceSchema, RefundSchema, SearchQuerySchema, SendMailSchema, userIdParam,
} from "./admin.validation.js";
import { zodIssues } from "./content-editor.js";

const log = createLogger("admin");

/** Largest JSON body the admin API accepts (a news entry with three languages fits well below). */
const MAX_BODY = "256kb";

type Handler = (req: express.Request, ctx: AdminContext) => Promise<object>;

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, "invalid payload", { issues: zodIssues(result.error) });
  return result.data;
}

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ ok: false, error: "ADMIN_INVALID_PAYLOAD", issues: zodIssues(error) });
  } else if (error instanceof AdminError) {
    res.status(error.status).json({ ok: false, error: error.errorCode, message: error.message, ...(error.fields ?? {}) });
  } else if (isAppError(error)) {
    res.status(409).json({ ok: false, error: error.errorCode, ...(error.extra ? { extra: error.extra } : {}) });
  } else {
    log.error("admin request failed:", error);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
}

export type AdminRouterOptions = {
  gate: AdminGate;
  service: AdminService;
  /** Folder with the static panel (index.html, app.js, style.css). */
  staticDir: string;
};

export function createAdminRouter({ gate, service, staticDir }: AdminRouterOptions): express.Router {
  const router = express.Router();

  // --- static panel
  router.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // --- JSON API
  const api = express.Router();
  api.use(gate.guardApi);
  api.use(express.json({ limit: MAX_BODY }));

  const route = (method: "get" | "post" | "put" | "delete", path: string, handler: Handler) => {
    api[method](path, (req, res) => {
      handler(req, { ip: String(res.locals.adminIp ?? "unknown") }).then((data) => res.json({ ok: true, ...data }), (error) => sendError(res, error));
    });
  };
  const player = (req: express.Request) => parse(userIdParam, req.params.id);
  const contentId = (req: express.Request) => parse(contentIdParam, req.params.id);

  route("get", "/dashboard", () => service.dashboard());
  route("get", "/meta", async () => service.meta());
  route("get", "/players", (req) => service.search(parse(SearchQuerySchema, req.query).q));
  route("get", "/players/:id", (req) => service.player(player(req)));
  route("post", "/players/:id/adjust", (req, ctx) => service.adjust(ctx, player(req), parse(AdjustSchema, req.body)));
  route("post", "/players/:id/mail", (req, ctx) => service.sendMail(ctx, player(req), parse(SendMailSchema, req.body)));
  route("post", "/players/:id/ban", (req, ctx) => service.ban(ctx, player(req), parse(BanSchema, req.body)));
  route("post", "/players/:id/unban", (req, ctx) => service.unban(ctx, player(req)));
  route("post", "/refunds", async (req, ctx) => ({ refund: await service.refund(ctx, parse(RefundSchema, req.body)) }));
  route("get", "/maintenance", async () => service.maintenanceState());
  route("post", "/maintenance", (req, ctx) => service.setMaintenance(ctx, parse(MaintenanceSchema, req.body).enabled));
  route("get", "/audit", (req) => service.audit(parse(AuditQuerySchema, req.query)));

  route("get", "/news", () => service.listNews());
  route("post", "/news", (req, ctx) => service.createNews(ctx, req.body));
  route("put", "/news/:id", (req, ctx) => service.replaceNews(ctx, contentId(req), req.body));
  route("delete", "/news/:id", (req, ctx) => service.removeNews(ctx, contentId(req)));

  route("get", "/mail-broadcasts", () => service.listBroadcasts());
  route("post", "/mail-broadcasts", (req, ctx) => service.createBroadcast(ctx, req.body));
  route("put", "/mail-broadcasts/:id", (req, ctx) => service.replaceBroadcast(ctx, contentId(req), req.body));
  route("delete", "/mail-broadcasts/:id", (req, ctx) => service.removeBroadcast(ctx, contentId(req)));

  api.use((_req, res) => {
    res.status(404).json({ ok: false, error: "NOT_FOUND" });
  });
  // Malformed or oversized JSON bodies.
  api.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number } | null)?.status;
    if (status === 413) res.status(413).json({ ok: false, error: "PAYLOAD_TOO_LARGE" });
    else if (status === 400) res.status(400).json({ ok: false, error: "ADMIN_INVALID_PAYLOAD" });
    else sendError(res, error);
  });

  router.use("/api", api);
  router.use(gate.guardPage, express.static(staticDir, { index: "index.html", fallthrough: false, maxAge: 0, dotfiles: "ignore" }));
  // express.static with fallthrough=false answers missing files through this handler.
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number } | null)?.status;
    res.status(status === 404 || status === 403 ? 404 : 500).json({ ok: false, error: status === 404 || status === 403 ? "NOT_FOUND" : "SERVER_ERROR" });
  });
  return router;
}
