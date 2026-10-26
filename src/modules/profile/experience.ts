import { expToNextLevel } from "../../config/game-config.js";

/** Level and progress inside it after gaining `amount` experience (any number of level ups). */
export function applyExperience(level: number, exp: number, amount: number): { level: number; exp: number; levelsGained: number } {
  let currentLevel = Math.max(1, level);
  let current = Math.max(0, exp) + Math.max(0, amount);
  let levelsGained = 0;
  while (current >= expToNextLevel(currentLevel)) {
    current -= expToNextLevel(currentLevel);
    currentLevel++;
    levelsGained++;
  }
  return { level: currentLevel, exp: current, levelsGained };
}
