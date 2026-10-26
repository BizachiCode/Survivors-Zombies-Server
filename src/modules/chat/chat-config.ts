// Chat rules: message size, history, spam limits and the word filter.

export const CHAT_CHANNELS: readonly string[] = ["global"];
export const DEFAULT_CHAT_CHANNEL = "global";

export type ChatConfig = {
  /** Longest message, in characters (after normalization). */
  maxLength: number;
  /** Messages kept (and sent) as the history of a channel. */
  historySize: number;
  /** Token bucket per user: one message every `intervalMs`, up to `burst` at once. */
  rate: { intervalMs: number; burst: number };
  /** The same message `repeatLimit` times in a row mutes the user. */
  repeatLimit: number;
  muteSeconds: number;
  /** Words replaced by `*` (case-insensitive, whole words only). Starter list: extend it for your audience and languages. */
  profanity: readonly string[];
  /** First line of every history (a system message). */
  welcome: string;
  /** First line of the history of a clan channel (`clan:<id>`); defaults to `welcome`. */
  clanWelcome?: string;
};

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  maxLength: 140,
  historySize: 50,
  rate: { intervalMs: 1500, burst: 3 },
  repeatLimit: 3,
  muteSeconds: 60,
  profanity: [
    "fuck", "fucking", "shit", "bitch", "asshole", "bastard", "dick", "cunt",
    "porra", "merda", "caralho", "puta", "foda",
    "mierda", "joder", "puto", "cabron", "coño",
  ],
  welcome: "Welcome to the global chat. Be kind and have fun!",
  clanWelcome: "Welcome to the clan chat. Be kind and have fun!",
};
