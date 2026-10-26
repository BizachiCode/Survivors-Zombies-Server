import type { MessageContext } from "@colyseus/core";
import { ZodError, type ZodType } from "zod";

import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import type { Logger } from "../logger.js";
import type { RateLimiter } from "../security/rate-limiter.js";

/** Normalized failure handed to {@link RequestSpec.formatError}. */
export type RequestFailure = {
  error: string;
  extra?: Record<string, unknown>;
  fields?: Record<string, unknown>;
};

/** Response body returned to the client (`{ ok, error?, ...data }` by convention). */
export type ResponseBody = Record<string, unknown>;

export type RequestSpec<TPayload, TContext> = {
  /** Zod schema validating the payload at the edge. */
  schema?: ZodType<TPayload>;
  /** Error code answered when the payload fails validation (default `INVALID_PAYLOAD`). */
  invalidPayloadError?: string;
  /** Per-user (or per-IP) limiter; omitted disables rate limiting. */
  rateLimit?: RateLimiter | null;
  /** Error code answered when the limiter blocks (default `RATE_LIMIT`). */
  rateLimitError?: string;
  /** Shapes error responses (default `{ ok: false, error, extra?, ...fields }`). */
  formatError?: (failure: RequestFailure, rawPayload: unknown) => ResponseBody;
  /** The use case. Must return the full response body. */
  handle: (context: TContext, payload: TPayload, rawPayload: unknown) => Promise<ResponseBody> | ResponseBody;
};

export function defaultErrorBody(failure: RequestFailure): ResponseBody {
  return {
    ok: false,
    error: failure.error,
    ...(failure.extra ? { extra: failure.extra } : {}),
    ...(failure.fields ?? {}),
  };
}

/** Converts any thrown value into a {@link RequestFailure}; unknown errors become `SERVER_ERROR` (and are logged). */
export function toRequestFailure(error: unknown, invalidPayloadError: string, logger: Logger, label: string): RequestFailure {
  if (error instanceof AppError) return { error: error.errorCode, extra: error.extra, fields: error.fields };
  if (error instanceof ZodError) return { error: invalidPayloadError };
  logger.error(`${label} failed:`, error);
  return { error: ErrorCode.SERVER_ERROR };
}

/**
 * Executes one request: rate limiting, payload validation, use case and error mapping. Resolves with the response
 * body (domain errors never reject); Colyseus 0.18 sends it back as the answer of the client's `room.Request`.
 * A fire-and-forget `room.send()` of a request type (no request id) is ignored: nothing runs without an answer.
 */
export async function executeRequest<TPayload, TContext>(options: {
  type: string;
  rawPayload: unknown;
  messageContext: MessageContext | undefined;
  spec: RequestSpec<TPayload, TContext>;
  logger: Logger;
  rateLimitKey: string | null;
  resolveContext: () => Promise<TContext>;
}): Promise<ResponseBody | undefined> {
  const { type, rawPayload, spec, logger } = options;
  if (options.messageContext?.id === undefined) return undefined;

  const invalidPayloadError = spec.invalidPayloadError ?? ErrorCode.INVALID_PAYLOAD;
  const formatError = spec.formatError ?? ((failure: RequestFailure) => defaultErrorBody(failure));

  try {
    if (spec.rateLimit && options.rateLimitKey && !(await spec.rateLimit.allow(options.rateLimitKey))) {
      throw new AppError(spec.rateLimitError ?? ErrorCode.RATE_LIMIT);
    }
    const context = await options.resolveContext();
    const payload = spec.schema ? spec.schema.parse(rawPayload ?? {}) : (rawPayload as TPayload);
    return await spec.handle(context, payload, rawPayload);
  } catch (error) {
    return formatError(toRequestFailure(error, invalidPayloadError, logger, `"${type}"`), rawPayload);
  }
}
