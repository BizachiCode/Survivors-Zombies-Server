// Account flows without a database: device guests, refresh rotation, email linking, email login, locks and bans.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { MAX_FAILED_LOGINS } from "../src/modules/auth/password-guard.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { ErrorCode } from "../src/shared/errors/error-codes.js";
import { createTestServices, testClock } from "./support/test-services.js";

function setup() {
  return createTestServices({ clock: testClock() });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

const DEVICE_A = { deviceId: "device-aaaaaaaaaaaaaaaa", platform: "Android" };
const DEVICE_B = { deviceId: "device-bbbbbbbbbbbbbbbb", platform: "IPhonePlayer" };

describe("AuthService: guest account per device", () => {
  it("creates the guest on the first launch and finds it again on the next ones", async () => {
    const { auth, store } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    assert.equal(first.created, true);
    assert.equal(first.account.isGuest, true);
    assert.equal(first.account.email, null);
    assert.match(first.profile.nickname, /^Player-\d{5}$/);
    assert.equal(first.profile.level, 1);

    const again = await auth.deviceLogin(DEVICE_A);
    assert.equal(again.created, false);
    assert.equal(again.userId, first.userId);
    assert.equal(store.users.size, 1);
  });

  it("gives every device its own guest", async () => {
    const { auth } = setup();
    const a = await auth.deviceLogin(DEVICE_A);
    const b = await auth.deviceLogin(DEVICE_B);
    assert.notEqual(a.userId, b.userId);
  });

  it("never stores the raw device id", async () => {
    const { auth, store } = setup();
    await auth.deviceLogin(DEVICE_A);
    assert.ok(![...store.devices.keys()].some((hash) => hash.includes(DEVICE_A.deviceId)));
    assert.match([...store.devices.keys()][0], /^[0-9a-f]{64}$/);
  });

  it("refuses a banned guest and lifts an expired ban", async () => {
    const { auth, users, clock } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    await users.setBan(first.userId, true, "cheating", new Date(clock.nowMs() + 60_000));
    await rejectsWith(auth.deviceLogin(DEVICE_A), ErrorCode.AUTH_BANNED);
    clock.set(clock.nowMs() + 120_000);
    const after = await auth.deviceLogin(DEVICE_A);
    assert.equal(after.userId, first.userId);
  });
});

describe("AuthService: sessions and refresh tokens", () => {
  it("issues access tokens that the room authenticator accepts", async () => {
    const { auth, authenticator } = setup();
    const signed = await auth.deviceLogin(DEVICE_A);
    const identity = await authenticator.authenticate(signed.accessToken);
    assert.equal(identity?.userId, signed.userId);
  });

  it("a newer sign-in on the same device invalidates the older access token", async () => {
    const { auth, authenticator } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    await auth.deviceLogin(DEVICE_A);
    assert.equal(await authenticator.authenticate(first.accessToken), null);
  });

  it("rotates the refresh token and keeps the session id", async () => {
    const { auth, authenticator } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    const refreshed = await auth.refresh(first.userId, first.refreshToken, DEVICE_A);
    assert.equal(refreshed.userId, first.userId);
    assert.notEqual(refreshed.refreshToken, first.refreshToken);
    // Silent refresh: the older access token of the same session keeps working until it expires.
    assert.ok(await authenticator.authenticate(first.accessToken));
    await rejectsWith(auth.refresh(first.userId, first.refreshToken, DEVICE_A), ErrorCode.AUTH_INVALID_REFRESH);
  });

  it("refuses a refresh token from another device", async () => {
    const { auth } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    await rejectsWith(auth.refresh(first.userId, first.refreshToken, DEVICE_B), ErrorCode.AUTH_INVALID_REFRESH);
  });

  it("logout revokes the refresh token and the session", async () => {
    const { auth, authenticator } = setup();
    const first = await auth.deviceLogin(DEVICE_A);
    await auth.logout(first.userId, first.refreshToken, DEVICE_A.deviceId);
    assert.equal(await authenticator.authenticate(first.accessToken), null);
    await rejectsWith(auth.refresh(first.userId, first.refreshToken, DEVICE_A), ErrorCode.AUTH_INVALID_REFRESH);
  });
});

describe("AccountService: linking an email", () => {
  it("upgrades the guest, unbinds the device and allows email login elsewhere", async () => {
    const { auth, accounts, authenticator } = setup();
    const guest = await auth.deviceLogin(DEVICE_A);
    const linked = await accounts.linkEmail(guest.userId, "player@example.com", "correct horse");
    assert.equal(linked.isGuest, false);
    assert.equal(linked.email, "player@example.com");
    // The current session stays valid after linking.
    assert.ok(await authenticator.authenticate(guest.accessToken));

    // A device id alone no longer opens the protected account: the device gets a fresh guest.
    const fresh = await auth.deviceLogin(DEVICE_A);
    assert.notEqual(fresh.userId, guest.userId);
    assert.equal(fresh.created, true);

    // Another device (or a reinstall) signs into the linked account with email + password.
    const onB = await auth.login("player@example.com", "correct horse", DEVICE_B);
    assert.equal(onB.userId, guest.userId);
    assert.equal(onB.account.isGuest, false);
  });

  it("refuses an email already used by another account", async () => {
    const { auth, accounts } = setup();
    const a = await auth.deviceLogin(DEVICE_A);
    const b = await auth.deviceLogin(DEVICE_B);
    await accounts.linkEmail(a.userId, "taken@example.com", "password-a");
    await rejectsWith(accounts.linkEmail(b.userId, "taken@example.com", "password-b"), ErrorCode.ACCOUNT_EMAIL_TAKEN);
  });

  it("refuses linking twice", async () => {
    const { auth, accounts } = setup();
    const a = await auth.deviceLogin(DEVICE_A);
    await accounts.linkEmail(a.userId, "once@example.com", "password-a");
    await rejectsWith(accounts.linkEmail(a.userId, "twice@example.com", "password-b"), ErrorCode.ACCOUNT_NOT_GUEST);
  });
});

describe("AuthService: email login guard", () => {
  it("answers the same error for unknown emails and wrong passwords, and locks after repeated failures", async () => {
    const { auth, accounts } = setup();
    const guest = await auth.deviceLogin(DEVICE_A);
    await accounts.linkEmail(guest.userId, "lock@example.com", "right-password");

    await rejectsWith(auth.login("nobody@example.com", "whatever", DEVICE_B), ErrorCode.AUTH_INVALID_CREDENTIALS);
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) {
      await rejectsWith(auth.login("lock@example.com", "wrong", DEVICE_B), ErrorCode.AUTH_INVALID_CREDENTIALS);
    }
    await rejectsWith(auth.login("lock@example.com", "wrong", DEVICE_B), ErrorCode.AUTH_INVALID_CREDENTIALS);
    await rejectsWith(auth.login("lock@example.com", "right-password", DEVICE_B), ErrorCode.AUTH_ACCOUNT_LOCKED);
  });

  it("guests cannot change a password they don't have", async () => {
    const { auth, accounts } = setup();
    const guest = await auth.deviceLogin(DEVICE_A);
    await rejectsWith(accounts.changePassword(guest.userId, auth.deviceKey(DEVICE_A.deviceId), "x", "new-password"), ErrorCode.ACCOUNT_IS_GUEST);
  });

  it("changing the password signs the other devices out", async () => {
    const { auth, accounts, authenticator } = setup();
    const guest = await auth.deviceLogin(DEVICE_A);
    await accounts.linkEmail(guest.userId, "change@example.com", "old-password");
    const onB = await auth.login("change@example.com", "old-password", DEVICE_B);

    const result = await accounts.changePassword(guest.userId, auth.deviceKey(DEVICE_A.deviceId), "old-password", "new-password");
    assert.equal(result.revokedDevices, 1);
    assert.equal(await authenticator.authenticate(onB.accessToken), null);
    assert.ok(await authenticator.authenticate(guest.accessToken));
    const relogged = await auth.login("change@example.com", "new-password", DEVICE_B);
    assert.equal(relogged.userId, guest.userId);
  });
});
