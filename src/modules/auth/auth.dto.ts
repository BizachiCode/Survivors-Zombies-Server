import type { WalletDto } from "../economy/wallet-ledger.js";
import type { ProfileDto } from "../profile/profile.dto.js";

/** Account summary (`account` object of auth successes and of the `account` room). */
export interface AccountDto {
  userId: string;
  isGuest: boolean;
  /** null for guests. */
  email: string | null;
  createdAtUnix: number;
}

/** Credentials returned by every session-creating auth action (device, login, refresh). */
export interface AuthResultDto {
  userId: string;
  accessToken: string;
  /** Expiry of the access token (unix seconds); renew with `refresh` before or after it. */
  accessExpiresAtUnix: number;
  refreshToken: string;
}

export type AuthOutcome = AuthResultDto & {
  account: AccountDto;
  profile: ProfileDto;
  wallet: WalletDto;
  /** True when this request created the guest account (first launch on the device). */
  created: boolean;
  serverTimeUnix: number;
};
