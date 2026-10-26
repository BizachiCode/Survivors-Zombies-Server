// Tower content used by the tower tests, layered on the shared test campaign (the fixture file stays untouched).

import { readFileSync } from "node:fs";

import { TEST_CONTENT_PATH } from "./test-services.js";

/** The test campaign plus two towers: one running (3 floors) and one that ended a day ago. */
export function towerContent(change?: (towers: any[]) => void) {
  const c = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  c.towers = [
    {
      id: "kraken",
      title: { en: "Kraken's Tower", pt: "Torre do Kraken" },
      description: { en: "Climb!", pt: "Suba!" },
      banner: "kraken",
      startsAt: "2026-10-20T00:00:00Z",
      endsAt: "2026-11-30T00:00:00Z",
      floors: [
        { encounter: "open_run", difficulty: "normal", reward: { currencies: { coins: 100 } } },
        { encounter: "guarded_run", difficulty: "hard", title: { en: "Guarded", pt: "Guardado" }, reward: { items: { plant_xp: 5 }, exp: 20 } },
        { encounter: "open_run", difficulty: "hard", reward: { currencies: { gems: 7 } } },
      ],
    },
    {
      id: "old",
      title: "Old Tower",
      description: "",
      banner: "",
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-10-20T12:00:00Z",
      floors: [{ encounter: "open_run", difficulty: "normal", reward: { currencies: { coins: 1 } } }],
    },
  ];
  change?.(c.towers);
  return c;
}
