// Typed error carrying a stable error code (the client localizes it) plus optional payload.

export type AppErrorOptions = {
  /** Nested details, serialized as `extra` (e.g. ban reason/until). */
  extra?: Record<string, unknown>;
  /** Fields merged at the top level of the error response. */
  fields?: Record<string, unknown>;
  /** Human readable message (logs only). */
  message?: string;
};

export class AppError extends Error {
  public readonly errorCode: string;
  public readonly extra?: Record<string, unknown>;
  public readonly fields?: Record<string, unknown>;

  constructor(errorCode: string, options: AppErrorOptions = {}) {
    super(options.message ?? errorCode);
    this.name = "AppError";
    this.errorCode = errorCode;
    this.extra = options.extra;
    this.fields = options.fields;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
