// Zod schemas for incoming auth messages (`auth` request, multiplexed by `type`).

import { z } from "zod";

import { deviceId, email, id, strictPayload } from "../../shared/validation.js";

const platform = z.string().trim().max(32).optional();
const userAgent = z.string().max(255).optional();

/** Guest sign-in: the device's own account (created on the first call). */
export const DeviceSchema = strictPayload({ type: z.literal("device"), deviceId, platform, userAgent });

/** Email sign-in (accounts that linked an email). */
export const LoginSchema = strictPayload({
  type: z.literal("login"),
  email,
  password: z.string().min(1).max(256),
  deviceId,
  platform,
  userAgent,
});

export const RefreshSchema = strictPayload({
  type: z.literal("refresh"),
  userId: id(64),
  refreshToken: z.string().min(1).max(512),
  deviceId,
  userAgent,
});

export const LogoutSchema = strictPayload({
  type: z.literal("logout"),
  userId: id(64),
  refreshToken: z.string().min(1).max(512),
  deviceId,
});

export const AuthMessageSchema = z.discriminatedUnion("type", [DeviceSchema, LoginSchema, RefreshSchema, LogoutSchema]);

export type AuthMessage = z.infer<typeof AuthMessageSchema>;

export const AUTH_ACTIONS = new Set(["device", "login", "refresh", "logout"]);
