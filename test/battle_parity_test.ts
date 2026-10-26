// The TypeScript simulation must replay the C# one bit for bit: the client's replica of an authoritative battle runs the
// C# code. Fixtures come from the Unity template's core tests:
//   cd Assets/CardTowerDefenseTemplate/Core/Tests~ && dotnet run -c Release -- --golden <server>/test/fixtures/battle-golden
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { applyCommand, type BattleCommandKind } from "../src/modules/battle/sim/battle-command.js";
import { BattleSpecSchema, buildBattle, toBattleSpec } from "../src/modules/battle/sim/battle-spec.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { Fnv1a } from "../src/modules/battle/sim/hashing.js";

const FIXTURES = join(__dirname, "fixtures", "battle-golden");
const HASH_EVERY = 20;

type Fixture = {
  name: string;
  spec: unknown;
  maxTicks: number;
  commands: { tick: number; kind: BattleCommandKind; id: string | null; lane: number; column: number; ok: boolean }[];
  hashes: { tick: number; hash: number }[];
  eventCount: number;
  eventHash: number;
  final: Record<string, unknown>;
};

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES).filter((file) => file.endsWith(".json")).sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Fixture);
}

describe("battle simulation: parity with the C# client", () => {
  const fixtures = loadFixtures();

  it("has fixtures to compare with", () => {
    assert.ok(fixtures.length >= 20, `expected the golden fixtures in ${FIXTURES}`);
  });

  for (const fixture of fixtures) {
    it(`replays ${fixture.name} exactly`, () => {
      const spec = BattleSpecSchema.parse(fixture.spec);
      const battle = buildBattle(spec);
      const events = new Fnv1a();
      let eventCount = 0;
      let nextCommand = 0;
      let nextHash = 0;
      for (;;) {
        const tick = battle.ticks;
        while (nextCommand < fixture.commands.length && fixture.commands[nextCommand].tick === tick) {
          const command = fixture.commands[nextCommand++];
          const outcome = applyCommand(battle, command);
          assert.equal(outcome.ok, command.ok, `${fixture.name}: command ${nextCommand - 1} (${command.kind} ${command.id ?? ""}) at tick ${tick}`);
        }
        if (tick % HASH_EVERY === 0) {
          const expected = fixture.hashes[nextHash++];
          assert.equal(expected.tick, tick, `${fixture.name}: hash schedule`);
          assert.equal(battle.stateHash(), expected.hash, `${fixture.name}: state hash at tick ${tick}`);
        }
        if (tick >= fixture.maxTicks || battle.isOver) break;
        battle.step();
        for (const e of battle.drainEvents()) {
          eventCount++;
          events.int(e.kind).int(e.entityId).int(e.lane).double(e.amount).double(e.time);
        }
      }
      assert.equal(nextCommand, fixture.commands.length, `${fixture.name}: every command replayed`);
      const final = fixture.hashes[fixture.hashes.length - 1];
      assert.equal(final.tick, battle.ticks);
      assert.equal(battle.stateHash(), final.hash, `${fixture.name}: final state hash`);
      assert.equal(eventCount, fixture.eventCount, `${fixture.name}: event count`);
      assert.equal(events.value, fixture.eventHash, `${fixture.name}: event fingerprint`);
      assert.deepEqual(battle.capture(), fixture.final, `${fixture.name}: final checkpoint`);
    });
  }

  it("describes its own definitions as an equivalent spec", () => {
    const spec = BattleSpecSchema.parse(fixtures[0].spec);
    const battle = buildBattle(spec);
    const again = buildBattle(BattleSpecSchema.parse(JSON.parse(JSON.stringify(
      toBattleSpec(battle.settings, battle.cardDefinitions, spec.waves.map((_, i) => (battle as any).waves[i]), spec.seed, battle.abilityList)))));
    assert.equal(again.contentHash, battle.contentHash);
    assert.equal(again.stateHash(), battle.stateHash());
  });

  it("rejects inconsistent specs", () => {
    const spec = BattleSpecSchema.parse(fixtures[0].spec);
    assert.throws(() => buildBattle({ ...spec, waves: [{ startTime: 1, groups: [{ enemy: "nobody", count: 1, lane: -1, delay: 0, interval: 1, column: -1 }] }] }), BattleContentError);
    assert.throws(() => buildBattle({ ...spec, cards: [...spec.cards, spec.cards[0]] }), BattleContentError);
    assert.throws(() => BattleSpecSchema.parse({ ...spec, extra: 1 }));
    assert.throws(() => BattleSpecSchema.parse({ ...spec, cards: [{ ...spec.cards[0], role: "Wizard" }] }));
  });
});
