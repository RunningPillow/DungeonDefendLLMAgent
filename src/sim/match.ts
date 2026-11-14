// A match = the same two teams fighting many times, with the results added up.
//
// One fight says little: hits, crits and dodges are random. And the left side of the arena has a
// small built-in advantage. So a match repeats the fight many times and makes each team spend
// half of the fights on each side. The outcome is a win rate, not a single win or loss.

import type { GameData } from "./data.js";
import { ARENA_MAX_SECONDS, runFight, type FightResult, type SideResult } from "./fight.js";
import type { GearSpec } from "./gear.js";
import { withSeedAsync } from "./random.js";
import { buildTeam, DEFAULT_BUILD_OPTIONS, type BuildOptions, type TeamSpec } from "./team.js";

export interface MatchOptions extends BuildOptions {
  /** Number of fights. Rounded up to an even number so both teams get the same number of fights on each side. */
  runs: number;
  /** Same seed = exactly the same fights and the same result. Omit for a random one (reported back in the result). */
  seed?: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { ...DEFAULT_BUILD_OPTIONS, runs: 40 };

export interface TeamSummary {
  name: string;
  wins: number;
  /** Share of all fights won (0..1). Draws count for nobody. */
  winRate: number;
  winsByKill: number;
  winsByTimeout: number;
  /** Wins while standing on the left / on the right; a big gap means the arena side decided, not the team. */
  winsOnLeft: number;
  winsOnRight: number;
  avgDamageDealt: number;
  /** Average share of team health left at the end of a fight (0..1). */
  avgHealthLeft: number;
  heroes: { name: string; class: string; avgDamageDealt: number; survivalRate: number }[];
}

export interface MatchResult {
  /** Plain-language warnings about how to read the numbers, e.g. when the arena side decided every fight. Read these first. */
  notes: string[];
  runs: number;
  seed: number;
  /** Gear of heroes that do not specify their own. */
  defaultGear: GearSpec | null;
  level: number;
  draws: number;
  /** Fights that hit the time limit instead of ending with a team wiped out. */
  timeouts: number;
  avgSeconds: number;
  a: TeamSummary;
  b: TeamSummary;
}

/**
 * Runs a match. Matches run one at a time: while a match runs, the game's dice are replaced by the
 * match's seeded dice, and two matches running at once would draw from each other's dice.
 */
export function runMatch(data: GameData, teamA: TeamSpec, teamB: TeamSpec, options: Partial<MatchOptions> = {}): Promise<MatchResult> {
  const result = queue.then(() => runMatchNow(data, teamA, teamB, options));
  queue = result.catch(() => undefined);
  return result;
}
let queue: Promise<unknown> = Promise.resolve();

async function runMatchNow(data: GameData, teamA: TeamSpec, teamB: TeamSpec, options: Partial<MatchOptions>): Promise<MatchResult> {
  const settings = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const runs = Math.max(2, Math.ceil(settings.runs / 2) * 2);
  const seed = settings.seed ?? Math.floor(Math.random() * 2 ** 31);

  const fights: { aOnLeft: boolean; result: FightResult }[] = [];
  await withSeedAsync(seed, async () => {
    for (let run = 0; run < runs; run++) {
      // fresh definitions and fresh teams for every fight: nothing carries over from one fight to the next
      const definitions = { skillDefinitions: await data.skillDefinitions(), otherMetadata: await data.otherMetadata() };
      const a = await buildTeam(data, definitions, teamA, settings);
      const b = await buildTeam(data, definitions, teamB, settings);
      const aOnLeft = run % 2 === 0;
      fights.push({ aOnLeft, result: aOnLeft ? await runFight(data, definitions, a, b) : await runFight(data, definitions, b, a) });
    }
  });

  const result: MatchResult = {
    notes: [],
    runs,
    seed,
    defaultGear: settings.gear,
    level: settings.level,
    draws: fights.filter((fight) => fight.result.winner === "draw").length,
    timeouts: fights.filter((fight) => fight.result.decidedBy === "timeout").length,
    avgSeconds: average(fights.map((fight) => fight.result.seconds)),
    a: summarize(teamA.name, fights, true),
    b: summarize(teamB.name, fights, false),
  };
  result.notes = notesFor(result);
  return result;
}

/** Spots results that do not mean what the win rate suggests. */
export function notesFor(result: MatchResult): string[] {
  const notes: string[] = [];
  const { a, b, runs, timeouts } = result;

  if (timeouts === runs) notes.push(`Every fight hit the ${ARENA_MAX_SECONDS} s time limit: neither team could kill the other, so the winner was decided by remaining health.`);
  else if (timeouts > runs / 2) notes.push(`${timeouts} of ${runs} fights hit the ${ARENA_MAX_SECONDS} s time limit and were decided by remaining health.`);

  const leftWins = a.winsOnLeft + b.winsOnLeft;
  const rightWins = a.winsOnRight + b.winsOnRight;
  const decided = leftWins + rightWins;
  const side = leftWins >= rightWins ? "left" : "right";
  const sideWins = Math.max(leftWins, rightWins);
  if (decided >= 10 && sideWins === decided)
    notes.push(`The arena side decided every fight: the team standing on the ${side} always won, whichever team it was. The win rates therefore say nothing about which team is stronger. In the game the attacker stands on the left.`);
  else if (decided >= 20 && sideWins / decided >= 0.75)
    notes.push(`The arena side mattered a lot: the team standing on the ${side} won ${sideWins} of ${decided} decided fights. In the game the attacker stands on the left.`);

  return notes;
}

function summarize(name: string, fights: { aOnLeft: boolean; result: FightResult }[], isTeamA: boolean): TeamSummary {
  // for every fight: which side this team stood on, whether it won, and its side of the result
  const rows = fights.map(({ aOnLeft, result }) => {
    const onLeft = aOnLeft === isTeamA;
    const side: SideResult = onLeft ? result.left : result.right;
    return { onLeft, won: result.winner === (onLeft ? "left" : "right"), decidedBy: result.decidedBy, side };
  });
  const wins = rows.filter((row) => row.won);

  return {
    name,
    wins: wins.length,
    winRate: wins.length / rows.length,
    winsByKill: wins.filter((row) => row.decidedBy === "kill").length,
    winsByTimeout: wins.filter((row) => row.decidedBy === "timeout").length,
    winsOnLeft: wins.filter((row) => row.onLeft).length,
    winsOnRight: wins.filter((row) => !row.onLeft).length,
    avgDamageDealt: average(rows.map((row) => row.side.damageDealt)),
    avgHealthLeft: average(rows.map((row) => row.side.healthLeft)),
    heroes: rows[0]!.side.heroes.map((hero, index) => ({
      name: hero.name,
      class: hero.class,
      avgDamageDealt: average(rows.map((row) => row.side.heroes[index]!.damageDealt)),
      survivalRate: average(rows.map((row) => (row.side.heroes[index]!.survived ? 1 : 0))),
    })),
  };
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
