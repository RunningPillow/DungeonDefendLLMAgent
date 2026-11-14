// MCP server: offers the simulator to LLM agents as tools.
//
// MCP (Model Context Protocol) is a standard way for an agent to discover and call tools. This
// process is started by the agent's host (for example Claude Code), talks to it over stdin/stdout,
// and stays running, so the game code and game data are loaded once and each match is fast.
//
// There is no LLM in here. The server only describes its tools and runs them when asked.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatTeamOptions, teamOptions } from "../sim/catalog.js";
import { GameData } from "../sim/data.js";
import { gameCodeChangedSinceLoad } from "../sim/game.js";
import { GEAR_RARITIES, MAX_GEAR_TIER } from "../sim/gear.js";
import { DEFAULT_MATCH_OPTIONS, runMatch, type MatchResult, type TeamSummary } from "../sim/match.js";
import { HERO_CLASSES, MAX_SKILLS_PER_HERO } from "../sim/team.js";

const MAX_RUNS = 2000;

// ---------------------------------------------------------------- game data

let loading: Promise<GameData> | undefined;

/** Game data, loaded on first use and then kept. Before every use it is brought up to date with the database. */
async function freshData(): Promise<{ data: GameData; notes: string[] }> {
  const firstLoad = loading === undefined;
  loading ??= GameData.load().catch((error) => {
    loading = undefined; // let the next call try again
    throw error;
  });
  const data = await loading;

  const notes: string[] = [];
  if (!firstLoad && (await data.refresh()).length > 0) notes.push("Game data changed in the database since the previous call and was reloaded.");
  if (gameCodeChangedSinceLoad()) notes.push("The game's code was recompiled after this server started. This result uses the OLD code. Restart the MCP server to use the new build.");
  return { data, notes };
}

// ---------------------------------------------------------------- tool inputs

const gearSchema = z.object({
  rarity: z.enum(GEAR_RARITIES),
  tier: z.number().int().min(0).max(MAX_GEAR_TIER).describe("0-99; each tier adds 1 % to an item's main stat"),
});

const heroSchema = z.object({
  class: z.enum(HERO_CLASSES),
  skills: z.array(z.string()).max(MAX_SKILLS_PER_HERO).optional().describe(`Up to ${MAX_SKILLS_PER_HERO} skill ids of this class. The core skill is always present and must not be listed.`),
  talents: z.record(z.string(), z.number().int().min(1)).optional().describe('Talent id -> rank, e.g. {"WR_FURY_CRUELTY": 3}. Must follow the talent rules from list_team_options.'),
  gear: gearSchema.optional().describe("Rarity and tier of all eight items of this hero. Omit to use defaultGear."),
  name: z.string().optional().describe("Label for this hero in the result."),
});

const teamSchema = z.object({
  name: z.string().describe("Label for this team in the result."),
  heroes: z.array(heroSchema).min(1).max(5),
  skillTier: z.number().int().min(0).max(5).optional().describe("Upgrade tier of all the team's skills, core skills included. Default 0."),
  skillTiers: z.record(z.string(), z.number().int().min(0)).optional().describe("Skill id -> tier, for skills that should differ from skillTier."),
});

// ---------------------------------------------------------------- tool outputs

const text = (content: string) => ({ content: [{ type: "text" as const, text: content }] });

/** Runs a tool and turns a thrown error into an error result the agent can read and act on. */
async function answer(run: () => Promise<string>) {
  try {
    return text(await run());
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** The match result with numbers rounded: shorter to read and cheaper in tokens. */
function compact(result: MatchResult, extraNotes: string[]) {
  const team = (summary: TeamSummary) => ({
    ...summary,
    winRate: round(summary.winRate, 3),
    avgDamageDealt: round(summary.avgDamageDealt, 0),
    avgHealthLeft: round(summary.avgHealthLeft, 3),
    heroes: summary.heroes.map((hero) => ({ ...hero, avgDamageDealt: round(hero.avgDamageDealt, 0), survivalRate: round(hero.survivalRate, 2) })),
  });
  return { ...result, notes: [...extraNotes, ...result.notes], avgSeconds: round(result.avgSeconds, 1), a: team(result.a), b: team(result.b) };
}

// ---------------------------------------------------------------- tools

const server = new McpServer({ name: "dungeon-defend-sim", version: "0.1.0" });

server.registerTool(
  "list_team_options",
  {
    title: "List team options",
    description:
      "Lists what a Dungeon Defend arena team can be built from, read from the game's current data: for each hero class its core skill, " +
      "the skills a hero can equip (id, rarity, number of upgrade tiers), and the talent trees with each talent's ranks, cost and prerequisites. " +
      "Also states the rules for gear, skill tiers and talent points. Call this before simulate_match to get valid ids; pass heroClass to get one class only.",
    inputSchema: { heroClass: z.enum(HERO_CLASSES).optional().describe("Only this class. Omit for all classes.") },
    annotations: { readOnlyHint: true },
  },
  ({ heroClass }) =>
    answer(async () => {
      const { data, notes } = await freshData();
      return [...notes, formatTeamOptions(await teamOptions(data, heroClass))].join("\n\n");
    }),
);

server.registerTool(
  "simulate_match",
  {
    title: "Simulate an arena match",
    description:
      "Runs an arena (PvP) match between two teams with Dungeon Defend's real server combat code and the game's current data, and returns statistics as JSON. " +
      "A match is `runs` fights. Each team stands on each side of the arena for half of the fights, because the side affects the outcome (in the game the attacker stands on the left). " +
      "The result gives, per team: wins and winRate, how the wins came about (winsByKill, or winsByTimeout when the 120 s limit ran out and remaining health decided), " +
      "winsOnLeft / winsOnRight, average damage and health left, and per-hero damage and survival. " +
      "Read `notes` first: they flag results that do not mean what the win rate suggests, such as every fight being decided by the arena side. " +
      "A team that breaks the game's rules (unknown id, illegal talent build) is rejected with an explanation; use list_team_options for valid ids and rules. " +
      "Fights involve dice, so judge on 40 or more runs. The same seed replays a match exactly; reuse a seed to compare before and after a change to the game data.",
    inputSchema: {
      teamA: teamSchema,
      teamB: teamSchema,
      runs: z.number().int().min(2).max(MAX_RUNS).optional().describe(`Number of fights, default ${DEFAULT_MATCH_OPTIONS.runs}. Rounded up to an even number.`),
      seed: z.number().int().min(0).optional().describe("Omit for a random seed; the seed used is returned."),
      level: z.number().int().min(1).optional().describe(`Level of every hero = talent points per hero. Default ${DEFAULT_MATCH_OPTIONS.level}.`),
      defaultGear: gearSchema.optional().describe("Gear for heroes that do not give their own. Default COMMON tier 0."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ teamA, teamB, runs, seed, level, defaultGear }) =>
    answer(async () => {
      const { data, notes } = await freshData();
      const result = await runMatch(data, teamA, teamB, {
        runs: runs ?? DEFAULT_MATCH_OPTIONS.runs,
        seed,
        level: level ?? DEFAULT_MATCH_OPTIONS.level,
        gear: defaultGear ?? DEFAULT_MATCH_OPTIONS.gear,
      });
      return JSON.stringify(compact(result, notes));
    }),
);

await server.connect(new StdioServerTransport());
freshData().catch(() => undefined); // start loading right away so the first tool call does not wait; errors surface on that call
