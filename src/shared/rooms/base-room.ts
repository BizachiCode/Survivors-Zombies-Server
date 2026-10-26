import { Room, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { createLogger, type Logger } from "../logger.js";
import { clientAddress } from "./client-address.js";
import { executeRequest, type RequestSpec } from "./request-handler.js";

/** Context passed to request handlers of rooms that don't require authentication. */
export type AnonymousRequestContext = {
  client: Client;
  /** Best-effort remote address, used as rate-limit key. */
  address: string;
};

/**
 * Base class for every game room.
 * - Dependencies are injected by the composition root through {@link bindRoom} (Colyseus creates room instances
 *   itself, so constructor arguments aren't available).
 * - Request handlers are registered with {@link handleRequest}: they validate with zod, return the response
 *   (Colyseus 0.18 request/response) and map errors to `{ ok: false, error }` uniformly.
 */
export abstract class BaseRoom<TState extends Schema = Schema, TDeps = unknown> extends Room<{ state: TState }> {
  /** Injected by {@link bindRoom}. */
  protected deps!: TDeps;

  protected readonly logger: Logger = createLogger(this.constructor.name);

  /** Registers a request handler for anonymous rooms (auth). */
  protected handleRequest<TPayload>(type: string, spec: RequestSpec<TPayload, AnonymousRequestContext>): void {
    this.onMessage(type, (client, rawPayload, messageContext) =>
      executeRequest<TPayload, AnonymousRequestContext>({
        type,
        rawPayload,
        messageContext,
        spec,
        logger: this.logger,
        rateLimitKey: addressOf(client),
        resolveContext: async () => ({ client, address: addressOf(client) }),
      }),
    );
  }
}

/** Rate-limit key of a client: its network address, falling back to the sessionId when the transport hides it. */
export function addressOf(client: Client): string {
  return String(clientAddress(client) || client.sessionId || "unknown");
}

/** Dependency bag declared by a room class (`BaseRoom<State, Deps>`). */
export type RoomDependencies<TRoom> = TRoom extends BaseRoom<any, infer TDeps> ? TDeps : never;

/**
 * Creates a concrete room class with its dependencies bound. The returned class keeps the original name and static
 * members (e.g. `onAuth`), so it can be passed straight to `defineRoom()`.
 */
export function bindRoom<TRoom extends BaseRoom<any, any>>(
  RoomClass: new () => TRoom,
  deps: RoomDependencies<TRoom>,
): new () => TRoom {
  const Base = RoomClass as unknown as new () => BaseRoom<any, RoomDependencies<TRoom>>;
  class BoundRoom extends Base {
    constructor() {
      super();
      this.deps = deps;
    }
  }
  Object.defineProperty(BoundRoom, "name", { value: RoomClass.name });
  return BoundRoom as unknown as new () => TRoom;
}
