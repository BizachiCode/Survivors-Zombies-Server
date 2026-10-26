// Profile and wallet rules without a database: starting balances, ledger, all-or-nothing debits, nickname and avatar.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { MAX_BALANCE } from "../src/config/game-config.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { ErrorCode } from "../src/shared/errors/error-codes.js";
import { createTestServices, testClock } from "./support/test-services.js";

const DEVICE = { deviceId: "device-profile-0001", platform: "Android" };

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("WalletLedger", () => {
  it("opens every new account with the configured starting balances", async () => {
    const { auth, store } = createTestServices({ clock: testClock(), startingBalances: { coins: 500, gems: 50 } });
    const guest = await auth.deviceLogin(DEVICE);
    assert.deepEqual(guest.wallet, { coins: 500, gems: 50 });
    assert.deepEqual(store.ledger.map((entry) => [entry.currencyId, entry.delta, entry.reason]), [
      ["coins", 500, "STARTING_BALANCE"],
      ["gems", 50, "STARTING_BALANCE"],
    ]);

    // Signing in again never grants the starting balance twice.
    const again = await auth.deviceLogin(DEVICE);
    assert.deepEqual(again.wallet, { coins: 500, gems: 50 });
    assert.equal(store.ledger.length, 2);
  });

  it("starts at zero by default", async () => {
    const { auth, store } = createTestServices({ clock: testClock() });
    const guest = await auth.deviceLogin(DEVICE);
    assert.deepEqual(guest.wallet, { coins: 0, gems: 0 });
    assert.equal(store.ledger.length, 0);
  });

  it("credits and debits with a ledger entry per currency", async () => {
    const { auth, wallets, uow, store } = createTestServices({ clock: testClock() });
    const { userId } = await auth.deviceLogin(DEVICE);

    const credited = await uow.transaction((session) => wallets.credit(session, userId, { coins: 1200, gems: 30 }, "STAGE_REWARD"));
    assert.deepEqual(credited, { coins: 1200, gems: 30 });
    const debited = await uow.transaction((session) => wallets.debit(session, userId, { coins: 200 }, "SHOP_PURCHASE"));
    assert.deepEqual(debited, { coins: 1000, gems: 30 });
    assert.deepEqual(store.ledger.map((entry) => [entry.currencyId, entry.delta, entry.balanceAfter, entry.reason]), [
      ["coins", 1200, 1200, "STAGE_REWARD"],
      ["gems", 30, 30, "STAGE_REWARD"],
      ["coins", -200, 1000, "SHOP_PURCHASE"],
    ]);
  });

  it("debits all or nothing", async () => {
    const { auth, wallets, uow, store } = createTestServices({ clock: testClock(), startingBalances: { coins: 100, gems: 5 } });
    const { userId } = await auth.deviceLogin(DEVICE);

    await assert.rejects(
      uow.transaction((session) => wallets.debit(session, userId, { coins: 50, gems: 10 }, "SHOP_PURCHASE")),
      (error: unknown) => error instanceof AppError && error.errorCode === ErrorCode.WALLET_INSUFFICIENT_FUNDS
        && JSON.stringify(error.extra) === JSON.stringify({ currencyId: "gems", need: 10, have: 5 }),
    );
    assert.deepEqual(await wallets.snapshot(userId), { coins: 100, gems: 5 });
    assert.equal(store.ledger.filter((entry) => entry.reason === "SHOP_PURCHASE").length, 0);
  });

  it("clamps credits to the balance ceiling and refuses invalid amounts", async () => {
    const { auth, wallets, uow } = createTestServices({ clock: testClock() });
    const { userId } = await auth.deviceLogin(DEVICE);

    await uow.transaction((session) => wallets.credit(session, userId, { gems: MAX_BALANCE - 1 }, "ADMIN"));
    const capped = await uow.transaction((session) => wallets.credit(session, userId, { gems: 10 }, "ADMIN"));
    assert.equal(capped.gems, MAX_BALANCE);

    await assert.rejects(uow.transaction((session) => wallets.credit(session, userId, { coins: -5 }, "ADMIN")));
    await assert.rejects(uow.transaction((session) => wallets.credit(session, userId, { coins: 1.5 }, "ADMIN")));
    await assert.rejects(uow.transaction((session) => wallets.credit(session, userId, { tickets: 1 } as never, "ADMIN")));
  });
});

describe("ProfileService", () => {
  it("answers the HUD snapshot", async () => {
    const { auth, profiles } = createTestServices({ clock: testClock(), startingBalances: { coins: 10 } });
    const guest = await auth.deviceLogin(DEVICE);
    const info = await profiles.info(guest.userId);
    assert.deepEqual(info.wallet, { coins: 10, gems: 0 });
    assert.deepEqual(info.profile, { nickname: guest.profile.nickname, avatarId: "avatar_zombie", level: 1, exp: 0, expToNext: 100 });
  });

  it("renames with the trimmed nickname and audits the change", async () => {
    const { auth, profiles, store } = createTestServices({ clock: testClock() });
    const guest = await auth.deviceLogin(DEVICE);

    const renamed = await profiles.setNickname(guest.userId, "  Zombie_Hunter ");
    assert.equal(renamed.nickname, "Zombie_Hunter");
    const audit = store.audit.filter((entry) => entry.kind === "NICKNAME_CHANGE");
    assert.deepEqual(audit.map((entry) => entry.meta), [{ from: guest.profile.nickname, to: "Zombie_Hunter" }]);

    // Same name again: nothing to record.
    await profiles.setNickname(guest.userId, "Zombie_Hunter");
    assert.equal(store.audit.filter((entry) => entry.kind === "NICKNAME_CHANGE").length, 1);
  });

  it("refuses nicknames that break the rules", async () => {
    const { auth, profiles, store } = createTestServices({ clock: testClock() });
    const { userId, profile } = await auth.deviceLogin(DEVICE);

    await rejectsWith(profiles.setNickname(userId, " ab "), ErrorCode.PROFILE_NICKNAME_TOO_SHORT);
    await rejectsWith(profiles.setNickname(userId, "x".repeat(17)), ErrorCode.PROFILE_NICKNAME_TOO_LONG);
    await rejectsWith(profiles.setNickname(userId, "Bad<script>"), ErrorCode.PROFILE_NICKNAME_INVALID_CHARS);
    await rejectsWith(profiles.setNickname(userId, "Two  Spaces"), ErrorCode.PROFILE_NICKNAME_INVALID_CHARS);
    await rejectsWith(profiles.setNickname(userId, `Zero${String.fromCharCode(0x200b)}Width`), ErrorCode.PROFILE_NICKNAME_INVALID_CHARS);
    await rejectsWith(profiles.setNickname(userId, "The Admin"), ErrorCode.PROFILE_NICKNAME_RESERVED);
    assert.equal(store.profiles.get(userId)?.nickname, profile.nickname);
  });

  it("changes the avatar only to one of the catalog", async () => {
    const { auth, profiles } = createTestServices({ clock: testClock() });
    const { userId } = await auth.deviceLogin(DEVICE);

    const changed = await profiles.setAvatar(userId, "avatar_pumpkin");
    assert.equal(changed.avatarId, "avatar_pumpkin");
    await rejectsWith(profiles.setAvatar(userId, "avatar_dragon"), ErrorCode.PROFILE_INVALID_AVATAR);
    assert.equal((await profiles.info(userId)).profile.avatarId, "avatar_pumpkin");
  });
});
