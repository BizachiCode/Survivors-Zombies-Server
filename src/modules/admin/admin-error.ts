import { AppError } from "../../shared/errors/app-error.js";

/** An admin API failure with the HTTP status it is answered with. `code` is a stable string (ADMIN_*). */
export class AdminError extends AppError {
  constructor(code: string, readonly status: number, message?: string, fields?: Record<string, unknown>) {
    super(code, { message, fields });
    this.name = "AdminError";
  }
}
