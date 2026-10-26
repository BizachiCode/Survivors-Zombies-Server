/** Public id of a player shown in rankings and chat: the first 8 hex digits of the user uuid, upper case (never the full id). */
export function publicUserId(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8).toUpperCase();
}
