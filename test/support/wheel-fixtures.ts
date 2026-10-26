// Wheel content used by the wheel tests, layered on the shared test campaign (the fixture file stays untouched).

import { readFileSync } from "node:fs";

import { BattleCatalog } from "../../src/modules/battle/content/battle-content.js";
import { TEST_CONTENT_PATH } from "./test-services.js";

export const WHEEL = {
  segments: [
    { id: "coins_100", weight: 5, reward: { currencies: { coins: 100 } } },
    { id: "gems_5", weight: 3, reward: { currencies: { gems: 5 } } },
    { id: "seeds", weight: 1, reward: { items: { "seeds.wild": 2 } } },
    { id: "exp", weight: 1, reward: { exp: 50 } },
  ],
  freeSpinsPerDay: 1,
  spinCost: { currency: "gems", amount: 30 },
  dailyLimit: 3,
};

/** The test campaign plus a wheel block (the fixture file stays untouched for the other suites). */
export function catalogWithWheel(...args: [] | [unknown]): BattleCatalog {
  const content = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  const wheel = args.length === 0 ? WHEEL : args[0];
  if (wheel !== undefined) content.wheel = wheel;
  return BattleCatalog.fromJson(content);
}
