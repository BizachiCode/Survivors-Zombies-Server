import { expToNextLevel } from "../../config/game-config.js";
import type { ProfileDto } from "./profile.dto.js";
import type { ProfileRow } from "./profile.repository.js";

export function toProfileDto(row: ProfileRow): ProfileDto {
  return { nickname: row.nickname, avatarId: row.avatarId, level: row.level, exp: row.exp, expToNext: expToNextLevel(row.level) };
}
