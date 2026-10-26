// Wire protocol of the `auth`, `account` and `profile` rooms through a real Colyseus server and SDK client (no database:
// in-memory repositories). This is the contract the Unity client's WebSocket backend relies on.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";

import { AccountRoom } from "../src/modules/account/account.room.js";
import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { ProfileRoom } from "../src/modules/profile/profile.room.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { createTestServices } from "./support/test-services.js";

const PORT = 2591;

describe("rooms: auth + account + profile protocol", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const { auth, accounts, profiles, authenticator } = createTestServices({ startingBalances: { coins: 500, gems: 50 } });
    configureRoomAuthentication(authenticator);

    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        account: defineRoom(bindRoom(AccountRoom, { accounts, queryLimiter: unlimited, accountLimiter: unlimited })),
        profile: defineRoom(bindRoom(ProfileRoom, { profiles, queryLimiter: unlimited, changeLimiter: unlimited })),
      },
    });
    colyseus = await boot(server, PORT);
  });

  after(async () => colyseus.shutdown());

  it("signs a device in, manages the account and switches to email login", async () => {
    const authRoom = await colyseus.sdk.joinOrCreate("auth");

    const guest: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0001", platform: "WindowsEditor" });
    assert.equal(guest.ok, true);
    assert.equal(guest.action, "device");
    assert.equal(guest.created, true);
    assert.equal(guest.account.isGuest, true);
    assert.ok(guest.accessToken && guest.refreshToken && guest.userId);
    assert.ok(guest.accessExpiresAtUnix > guest.serverTimeUnix);
    assert.deepEqual(guest.wallet, { coins: 500, gems: 50 });
    assert.deepEqual(guest.profile, { nickname: guest.profile.nickname, avatarId: "avatar_zombie", level: 1, exp: 0, expToNext: 100 });

    const again: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0001" });
    assert.equal(again.userId, guest.userId);
    assert.equal(again.created, false);

    const accountRoom = await colyseus.sdk.joinOrCreate("account", { accessToken: again.accessToken });
    const info: any = await accountRoom.request("account", { type: "info" });
    assert.deepEqual({ ok: info.ok, isGuest: info.account.isGuest }, { ok: true, isGuest: true });

    const linked: any = await accountRoom.request("account", { type: "link_email", email: "Player@Example.com", password: "correct horse" });
    assert.equal(linked.ok, true);
    assert.equal(linked.account.email, "player@example.com");

    const relogin: any = await authRoom.request("auth", { type: "login", email: "player@example.com", password: "correct horse", deviceId: "unity-device-0002" });
    assert.equal(relogin.ok, true);
    assert.equal(relogin.userId, guest.userId);

    const refreshed: any = await authRoom.request("auth", { type: "refresh", userId: relogin.userId, refreshToken: relogin.refreshToken, deviceId: "unity-device-0002" });
    assert.equal(refreshed.ok, true);
    assert.notEqual(refreshed.refreshToken, relogin.refreshToken);
  });

  it("answers validation errors with stable codes", async () => {
    const authRoom = await colyseus.sdk.joinOrCreate("auth");
    const unknown: any = await authRoom.request("auth", { type: "hack" });
    assert.deepEqual(unknown, { action: "unknown", ok: false, error: "AUTH_UNKNOWN_ACTION" });
    const invalid: any = await authRoom.request("auth", { type: "device", deviceId: "x" });
    assert.deepEqual(invalid, { action: "device", ok: false, error: "AUTH_INVALID_PAYLOAD" });
    const extra: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0003", userId: "someone-else" });
    assert.equal(extra.error, "AUTH_INVALID_PAYLOAD");
    const wrong: any = await authRoom.request("auth", { type: "login", email: "nobody@example.com", password: "x", deviceId: "unity-device-0003" });
    assert.deepEqual(wrong, { action: "login", ok: false, error: "AUTH_INVALID_CREDENTIALS" });
  });

  it("reads the HUD snapshot and changes nickname and avatar", async () => {
    const authRoom = await colyseus.sdk.joinOrCreate("auth");
    const guest: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0100" });
    const profileRoom = await colyseus.sdk.joinOrCreate("profile", { accessToken: guest.accessToken });

    const info: any = await profileRoom.request("profile", { type: "info" });
    assert.deepEqual({ ok: info.ok, action: info.action, wallet: info.wallet }, { ok: true, action: "info", wallet: { coins: 500, gems: 50 } });
    assert.equal(info.profile.nickname, guest.profile.nickname);

    const renamed: any = await profileRoom.request("profile", { type: "set_nickname", nickname: "  Sunny Day " });
    assert.deepEqual({ ok: renamed.ok, nickname: renamed.profile.nickname }, { ok: true, nickname: "Sunny Day" });
    const avatar: any = await profileRoom.request("profile", { type: "set_avatar", avatarId: "avatar_ghost" });
    assert.equal(avatar.profile.avatarId, "avatar_ghost");

    const again: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0100" });
    assert.deepEqual({ nickname: again.profile.nickname, avatarId: again.profile.avatarId }, { nickname: "Sunny Day", avatarId: "avatar_ghost" });
  });

  it("answers profile rule violations with stable codes", async () => {
    const authRoom = await colyseus.sdk.joinOrCreate("auth");
    const guest: any = await authRoom.request("auth", { type: "device", deviceId: "unity-device-0101" });
    const profileRoom = await colyseus.sdk.joinOrCreate("profile", { accessToken: guest.accessToken });

    const short: any = await profileRoom.request("profile", { type: "set_nickname", nickname: "ab" });
    assert.deepEqual(short, { action: "set_nickname", ok: false, error: "PROFILE_NICKNAME_TOO_SHORT" });
    const avatar: any = await profileRoom.request("profile", { type: "set_avatar", avatarId: "avatar_dragon" });
    assert.deepEqual(avatar, { action: "set_avatar", ok: false, error: "PROFILE_INVALID_AVATAR" });
    const unknown: any = await profileRoom.request("profile", { type: "add_gems", amount: 9999 });
    assert.deepEqual(unknown, { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    const extra: any = await profileRoom.request("profile", { type: "info", userId: "someone-else" });
    assert.equal(extra.error, "INVALID_PAYLOAD");
  });

  it("refuses authenticated rooms without a valid access token", async () => {
    await assert.rejects(colyseus.sdk.joinOrCreate("account", { accessToken: "not-a-token" }));
    await assert.rejects(colyseus.sdk.joinOrCreate("account"));
    await assert.rejects(colyseus.sdk.joinOrCreate("profile", { accessToken: "not-a-token" }));
  });
});
