// Glue between clans and the chat: the clan channel is `clan:<clanId>`; only members may join it, and the clans service
// pushes system lines (joins / leaves) and removes kicked or departed members from it.

import type { ChatChannelAccess } from "../chat/chat.room.js";
import type { ChatService } from "../chat/chat.service.js";
import { clanChannel, clanIdOfChannel } from "./clans-config.js";
import type { ClanChatPort } from "./clans.service.js";
import type { ClansRepository } from "./clans.repository.js";

/** `ClanChatPort` on top of the chat service. */
export function createClanChatPort(chat: ChatService): ClanChatPort {
  return {
    announce: (clanId, text, key, args) => { chat.postSystem(clanChannel(clanId), text, key, args); },
    evict: (clanId, userId) => chat.evict(clanChannel(clanId), userId),
    close: (clanId) => chat.closeChannel(clanChannel(clanId)),
  };
}

/** A player may join `clan:<id>` only while they are a member of that clan (checked at matchmaking and on every `say`). */
export function createClanChatAccess(clans: ClansRepository): ChatChannelAccess {
  return {
    async canJoin(userId, channel) {
      const clanId = clanIdOfChannel(channel);
      if (!clanId) return false;
      const member = await clans.getMember(userId);
      return member?.clanId === clanId;
    },
  };
}
