// One arena fight between two teams, computed by the game's own combat function.
//
// This mirrors what the game server does for a real PvP match (specials.ts in the game):
// the challenger joins on the left, the opponent joins on the right as an AI-controlled team,
// and runTimedAutobattle plays the fight out tick by tick until one team is dead or time runs out.

import type { GameData } from "./data.js";
import type { Definitions } from "./team.js";

/** The game's arena time limit. When it runs out, the team with more total health wins. */
export const ARENA_MAX_SECONDS = 120;

export interface HeroResult {
  name: string;
  class: string;
  damageDealt: number;
  survived: boolean;
}

export interface SideResult {
  damageDealt: number;
  /** Team health on the last tick of the fight, as a share of maximum (0..1). Measured before the timeout rule zeroes the loser. */
  healthLeft: number;
  heroes: HeroResult[];
}

export interface FightResult {
  winner: "left" | "right" | "draw";
  /** "kill": one team was wiped out. "timeout": time ran out and remaining health decided. */
  decidedBy: "kill" | "timeout";
  seconds: number;
  left: SideResult;
  right: SideResult;
}

/** Runs one fight. `left` and `right` are characters built by buildTeam; they are used up by the fight. */
export async function runFight(data: GameData, definitions: Definitions, left: any, right: any): Promise<FightResult> {
  const { enc, wm } = data.game;
  const transaction = data.offlineTransaction;
  const context = enc.ENCOUNTER_CONTEXT.ARENA_PVP;

  // Same constructor call the game uses for an arena fight; most arguments are empty lists that the fight fills in.
  const encounter = new enc.EncounterDocument(
    "SIM", [], [], [], Math.random(), "", left.uid, 2, [left.uid], false, left.characterName,
    context, 1, "", "0", [], [], [], 0, [], context, [], left.lastClaimedGameDay, -1, [],
    undefined, undefined, left.seasonNumber, undefined, 0, 0, [],
  );

  await enc.joinCharacterToEncounter(encounter, left, definitions.skillDefinitions, false, transaction);
  await enc.joinCharacterToEncounter(encounter, right, definitions.skillDefinitions, true, transaction, "SIM_RIGHT");

  // When time runs out, the game sets the losing team's health to zero, which hides how close the fight was.
  // Right before applying that rule the game asks the encounter "are all enemies dead?". We listen in on
  // that question to note everyone's true final health.
  const fighters: any[] = [...encounter.teamLeft, ...encounter.teamRight];
  const lastHealth = new Map<string, number>();
  const recordHealth = () => fighters.forEach((entity) => lastHealth.set(entity.uid, Math.max(0, entity.stats.health)));
  recordHealth();
  const checkIfAllEnemiesAreDead = encounter.checkIfAllEnemiesAreDead;
  encounter.checkIfAllEnemiesAreDead = function (...args: unknown[]) {
    recordHealth();
    return checkIfAllEnemiesAreDead.apply(this, args);
  };

  await wm.runTimedAutobattle(encounter, left.uid, transaction, definitions.skillDefinitions, ARENA_MAX_SECONDS);

  const leftAlive = encounter.teamLeft.some((entity: any) => entity.stats.health > 0);
  const rightAlive = encounter.teamRight.some((entity: any) => entity.stats.health > 0);
  const leftResult = sideResult(encounter, encounter.teamLeft, encounter.teamRight, lastHealth);
  const rightResult = sideResult(encounter, encounter.teamRight, encounter.teamLeft, lastHealth);
  const ranOutOfTime = encounter.timeMs >= ARENA_MAX_SECONDS * 1000 && leftResult.healthLeft > 0 && rightResult.healthLeft > 0;

  return {
    winner: leftAlive && !rightAlive ? "left" : rightAlive && !leftAlive ? "right" : "draw",
    decidedBy: ranOutOfTime ? "timeout" : "kill",
    seconds: encounter.timeMs / 1000,
    left: leftResult,
    right: rightResult,
  };
}

function sideResult(encounter: any, team: any[], enemies: any[], lastHealth: Map<string, number>): SideResult {
  const enemyUids = new Set(enemies.map((entity) => entity.uid));
  const damageByHero = new Map<string, number>(team.map((entity) => [entity.uid, 0]));

  // combatFlow is the game's record of everything that happened; the client replays the fight from it.
  for (const entry of encounter.combatFlow) {
    if (entry.isPositive || !(entry.amount > 0)) continue;
    if (damageByHero.has(entry.caster) && enemyUids.has(entry.target)) damageByHero.set(entry.caster, damageByHero.get(entry.caster)! + entry.amount);
  }

  const heroes = team.map((entity) => ({
    name: entity.displayName as string,
    class: entity.characterClass as string,
    damageDealt: damageByHero.get(entity.uid)!,
    survived: lastHealth.get(entity.uid)! > 0,
  }));
  const maxHealth = team.reduce((sum, entity) => sum + entity.stats.healthMax, 0);
  const health = team.reduce((sum, entity) => sum + lastHealth.get(entity.uid)!, 0);
  return { damageDealt: heroes.reduce((sum, hero) => sum + hero.damageDealt, 0), healthLeft: health / maxHealth, heroes };
}
