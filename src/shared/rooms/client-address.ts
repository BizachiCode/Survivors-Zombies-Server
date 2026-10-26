import type { AuthContext, Client } from "@colyseus/core";

import { env } from "../../config/env.js";

/**
 * Where the address of a room client comes from. Colyseus resolves `AuthContext.ip` from `x-real-ip` /
 * `x-forwarded-for` before the socket address, so any client could pick its own address (and dodge the per-IP limits)
 * by sending one of those headers. Those headers are therefore only honoured behind a trusted proxy (`TRUST_PROXY`).
 */
export type ClientAddressOptions = {
  trustProxy: boolean;
  /** Peers allowed to set the forwarded headers; empty = every peer (only safe when the proxy is the only way in). */
  trustedProxies: readonly string[];
};

let options: ClientAddressOptions = { trustProxy: env.trustProxy, trustedProxies: env.trustedProxies };

/** Overrides the proxy trust settings (tests). */
export function configureClientAddress(value: Partial<ClientAddressOptions>): void {
  options = { ...options, ...value };
}

/** Strips the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`) so the same peer always yields the same key. */
export function normalizeAddress(address: string | null | undefined): string | null {
  const value = (address ?? "").trim();
  if (!value) return null;
  return value.toLowerCase().startsWith("::ffff:") && value.includes(".") ? value.slice(7) : value;
}

/** Remote address of the websocket connection (never a header), or null when the transport doesn't expose it. */
export function socketAddressOf(client: Client): string | null {
  const ref = client?.ref as unknown as { _socket?: { remoteAddress?: string }; socket?: { remoteAddress?: string } } | undefined;
  return normalizeAddress(ref?._socket?.remoteAddress ?? ref?.socket?.remoteAddress);
}

/** Address to remember in `client.auth.address` at matchmaking: the forwarded one only when proxies are trusted. */
export function forwardedAddressOf(context: AuthContext | undefined): string | null {
  return options.trustProxy ? normalizeAddress(context?.ip) : null;
}

/** Address of a connected client for rate limiting / audit (null when unknown). */
export function clientAddress(client: Client): string | null {
  const socket = socketAddressOf(client);
  if (!options.trustProxy) return socket;
  const forwarded = normalizeAddress(((client.auth ?? {}) as { address?: string | null }).address);
  if (!forwarded) return socket;
  if (options.trustedProxies.length === 0) return forwarded;
  return socket && options.trustedProxies.map(normalizeAddress).includes(socket) ? forwarded : socket;
}

/** Express `trust proxy` setting matching the rooms. */
export function expressTrustProxySetting(settings: ClientAddressOptions = options): boolean | string[] {
  if (!settings.trustProxy) return false;
  return settings.trustedProxies.length > 0 ? [...settings.trustedProxies] : true;
}
