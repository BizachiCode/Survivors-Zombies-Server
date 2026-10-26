import type { AccountDto } from "./auth.dto.js";
import type { AccountRow } from "./auth.ports.js";

const toUnix = (date: Date): number => Math.floor(date.getTime() / 1000);

export function toAccountDto(row: AccountRow): AccountDto {
  return {
    userId: row.id,
    isGuest: row.isGuest,
    email: row.isGuest ? null : row.email,
    createdAtUnix: toUnix(row.createdAt),
  };
}
