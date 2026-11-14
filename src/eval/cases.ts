// The questions the agent is measured on, and how its answers are graded.
//
// Every case names two exact teams and asks which one is stronger. That makes the right answer
// something the simulator can compute by itself, with no model involved, at the moment the eval
// runs. So the answers stay correct when the game is rebalanced, and no model's opinion is ever
// used as the "truth" another model is graded against.
//
// The agent must start its answer with one of four labels. A fixed label is what makes automatic
// grading possible; everything else about the run (instructions, tools, report format) is exactly
// what a normal run uses.

import type { GameData } from "../sim/data.js";
import type { GearSpec } from "../sim/gear.js";
import { runMatch } from "../sim/match.js";
import type { HeroSpec, TeamSpec } from "../sim/team.js";

export const LABELS = ["TYM_A", "TYM_B", "NEROZHODNUTO", "NEPLATNY_TYM"] as const;
export type Label = (typeof LABELS)[number];

/** A team counts as stronger when it wins at least this share of the fights. */
export const WIN_THRESHOLD = 0.7;
/** A win rate this close to the threshold could flip with the dice; such a case is reported as unstable. */
const UNSTABLE_MARGIN = 0.1;

const GROUND_TRUTH_FIGHTS = 400;
const LEVEL = 10;

export interface EvalCase {
  id: string;
  /** What the case checks, for the summary. */
  checks: string;
  teamA: TeamSpec;
  teamB: TeamSpec;
}

const COMMON: GearSpec = { rarity: "COMMON", tier: 0 };
const EPIC: GearSpec = { rarity: "EPIC", tier: 0 };
const LEGENDARY: GearSpec = { rarity: "LEGENDARY", tier: 50 };

const team = (name: string, gear: GearSpec, heroes: Omit<HeroSpec, "gear">[]): TeamSpec => ({ name, skillTier: 0, heroes: heroes.map((hero) => ({ ...hero, gear })) });

export const CASES: EvalCase[] = [
  {
    id: "gear-gap",
    checks: "a clear difference caused by gear; the stronger team is B",
    teamA: team("A", COMMON, [{ class: "WARRIOR" }, { class: "SHAMAN" }, { class: "WARLOCK" }]),
    teamB: team("B", EPIC, [{ class: "WARRIOR" }, { class: "SHAMAN" }, { class: "WARLOCK" }]),
  },
  {
    id: "class-gap",
    checks: "a clear difference caused by class; the stronger team is A",
    teamA: team("A", LEGENDARY, Array(5).fill({ class: "WARLOCK" })),
    teamB: team("B", LEGENDARY, Array(5).fill({ class: "WARRIOR" })),
  },
  {
    id: "mirror",
    checks: "no difference: two identical teams; the agent must not invent a winner",
    teamA: team("A", COMMON, [{ class: "WARRIOR" }, { class: "WARRIOR" }]),
    teamB: team("B", COMMON, [{ class: "WARRIOR" }, { class: "WARRIOR" }]),
  },
  {
    id: "illegal-build",
    checks: "a team the game's rules do not allow; the agent must say so instead of simulating something else",
    teamA: team("A", COMMON, [{ class: "WARRIOR", talents: { WR_PROT_INTIMIDATION: 1 } }]),
    teamB: team("B", COMMON, [{ class: "WARRIOR" }]),
  },
];

/** The question as the agent receives it (in Czech, like the designer's real questions). */
export function questionFor(evalCase: EvalCase): string {
  return [
    `Tým A: ${describe(evalCase.teamA)}`,
    `Tým B: ${describe(evalCase.teamB)}`,
    `Všichni hrdinové mají level ${LEVEL}, tier skillů 0.`,
    "",
    "Který tým je v aréně silnější?",
    "",
    `Pole "answer" začni přesně jedním z těchto slov: ${LABELS.join(", ")}.`,
    `- TYM_A nebo TYM_B: ten tým vyhraje aspoň ${WIN_THRESHOLD * 100} % soubojů.`,
    `- NEROZHODNUTO: žádný tým nevyhraje aspoň ${WIN_THRESHOLD * 100} % soubojů, ať proto, že jsou vyrovnané, nebo proto, že rozhoduje strana arény či časový limit.`,
    "- NEPLATNY_TYM: některý z týmů nejde podle pravidel hry postavit přesně tak, jak je zadaný.",
  ].join("\n");
}

function describe(spec: TeamSpec): string {
  const heroes = spec.heroes.map((hero) => {
    const skills = hero.skills?.length ? `skilly ${hero.skills.join(", ")}` : "bez skillů";
    const talents = Object.entries(hero.talents ?? {});
    const talentText = talents.length ? `talenty ${talents.map(([id, rank]) => `${id} rank ${rank}`).join(", ")}` : "bez talentů";
    return `${hero.class} (výbava ${hero.gear!.rarity} tier ${hero.gear!.tier}, ${skills}, ${talentText})`;
  });
  return `${heroes.length} ${heroes.length === 1 ? "hrdina" : "hrdinové"}: ${heroes.join("; ")}.`;
}

export interface GroundTruth {
  label: Label;
  /** The numbers behind the label. */
  detail: string;
  /** False when the win rate is close enough to the threshold that the label could flip with the dice. */
  stable: boolean;
}

/** The right answer for a case, computed by the simulator alone. */
export async function groundTruth(data: GameData, evalCase: EvalCase): Promise<GroundTruth> {
  let match;
  try {
    match = await runMatch(data, evalCase.teamA, evalCase.teamB, { runs: GROUND_TRUTH_FIGHTS, seed: 1, level: LEVEL });
  } catch (error) {
    return { label: "NEPLATNY_TYM", detail: error instanceof Error ? error.message : String(error), stable: true };
  }
  const { a, b } = match;
  const label: Label = a.winRate >= WIN_THRESHOLD ? "TYM_A" : b.winRate >= WIN_THRESHOLD ? "TYM_B" : "NEROZHODNUTO";
  const closest = Math.min(Math.abs(a.winRate - WIN_THRESHOLD), Math.abs(b.winRate - WIN_THRESHOLD));
  const percent = (share: number) => `${Math.round(share * 100)} %`;
  return {
    label,
    detail: `${GROUND_TRUTH_FIGHTS} fights: A ${percent(a.winRate)}, B ${percent(b.winRate)}; A on left ${a.winsOnLeft} / on right ${a.winsOnRight}, B on left ${b.winsOnLeft} / on right ${b.winsOnRight}; time limit ${match.timeouts}`,
    stable: closest >= UNSTABLE_MARGIN,
  };
}

/** The label the answer starts with, or null if it starts with none of them. */
export function labelIn(answer: string): Label | null {
  const start = answer.replace(/^[\s"'*_`„“(]+/, "").toUpperCase();
  return LABELS.find((label) => start.startsWith(label) && !/[A-Z0-9_]/.test(start[label.length] ?? "")) ?? null;
}
