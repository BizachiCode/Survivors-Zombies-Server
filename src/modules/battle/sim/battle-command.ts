// Player intents applied to a battle at a tick (C#: Core/Gameplay/BattleCommand.cs). The room applies them to the
// authoritative simulation and relays the accepted ones with their tick to the client's replica.

import type { BattleSimulation } from "./battle-simulation.js";
import { AbilityResult, PlacementResult } from "./definitions.js";

export const BATTLE_COMMAND_KINDS = ["place", "upgrade", "remove", "cast", "pause", "resume"] as const;
export type BattleCommandKind = (typeof BATTLE_COMMAND_KINDS)[number];

export type BattleCommand = {
  kind: BattleCommandKind;
  /** Card id (place) or ability id (cast). */
  id?: string | null;
  lane?: number;
  column?: number;
};

/** Outcome of a command: `ok` when it changed the battle, otherwise the simulation's reason. */
export type CommandOutcome = { ok: boolean; placement?: PlacementResult; ability?: AbilityResult };

export function applyCommand(battle: BattleSimulation, command: BattleCommand): CommandOutcome {
  const lane = command.lane ?? -1;
  const column = command.column ?? -1;
  switch (command.kind) {
    case "place": {
      const placement = battle.tryPlace(command.id ?? null, lane, column);
      return { ok: placement === PlacementResult.Success, placement };
    }
    case "upgrade":
      return { ok: battle.tryUpgrade(lane, column) };
    case "remove":
      return { ok: battle.tryRemove(lane, column) };
    case "cast": {
      const ability = battle.tryCast(command.id ?? null, lane);
      return { ok: ability === AbilityResult.Success, ability };
    }
    case "pause":
    case "resume": {
      const before = battle.phase;
      battle.setPaused(command.kind === "pause");
      return { ok: battle.phase !== before };
    }
  }
}
