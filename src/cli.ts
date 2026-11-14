// Command line for the simulator.
//
//   npm run sim -- list [CLASS]                              what can go into a team: skills and talents
//   npm run sim -- fight --a WARRIOR,SHAMAN --b WARLOCK,WARLOCK    quick match, heroes with core skills only
//   npm run sim -- fight --file examples/berserker-vs-guardian.json    full teams with skills, talents and gear
//
// Options for fight: --runs 40   --seed 123   --gear EPIC:10 (rarity:tier, or "none")   --level 10   --skill-tier 3   --json

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatTeamOptions, teamOptions } from "./sim/catalog.js";
import { GameData } from "./sim/data.js";
import { GEAR_RARITIES, type GearRarity, type GearSpec } from "./sim/gear.js";
import { DEFAULT_MATCH_OPTIONS, runMatch, type MatchResult, type TeamSummary } from "./sim/match.js";
import { HERO_CLASSES, type HeroClass, type TeamSpec } from "./sim/team.js";

const print = (line = "") => process.stdout.write(line + "\n");

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      a: { type: "string" },
      b: { type: "string" },
      file: { type: "string" },
      runs: { type: "string" },
      seed: { type: "string" },
      gear: { type: "string" },
      level: { type: "string" },
      "skill-tier": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const command = positionals[0];

  if (command === "list") {
    const data = await GameData.load();
    const onlyClass = positionals[1]?.toUpperCase() as HeroClass | undefined;
    if (onlyClass && !HERO_CLASSES.includes(onlyClass)) throw new Error(`Unknown class "${onlyClass}". Valid classes: ${HERO_CLASSES.join(", ")}.`);
    print(formatTeamOptions(await teamOptions(data, onlyClass)));
  } else if (command === "fight") {
    const [teamA, teamB] = values.file ? teamsFromFile(values.file) : [teamFromClasses("A", values.a), teamFromClasses("B", values.b)];
    if (values["skill-tier"]) teamA.skillTier = teamB.skillTier = Number(values["skill-tier"]);

    const data = await GameData.load();
    const started = Date.now();
    const result = await runMatch(data, teamA, teamB, {
      runs: values.runs ? Number(values.runs) : DEFAULT_MATCH_OPTIONS.runs,
      seed: values.seed ? Number(values.seed) : undefined,
      gear: values.gear ? parseGear(values.gear) : DEFAULT_MATCH_OPTIONS.gear,
      level: values.level ? Number(values.level) : DEFAULT_MATCH_OPTIONS.level,
    });
    if (values.json) print(JSON.stringify(result, null, 2));
    else report(data, result, Date.now() - started);
  } else {
    print("Usage:");
    print("  npm run sim -- list [CLASS]");
    print("  npm run sim -- fight --a WARRIOR,SHAMAN,WARLOCK --b WARLOCK,WARLOCK,SHAMAN [--runs 40] [--seed 1] [--gear EPIC:10|none] [--level 10] [--skill-tier 3] [--json]");
    print("  npm run sim -- fight --file examples/berserker-vs-guardian.json");
  }
}

function teamFromClasses(name: string, classes: string | undefined): TeamSpec {
  if (!classes) throw new Error(`Team ${name} is missing. Give both --a and --b (comma-separated classes), or --file.`);
  return { name, heroes: classes.split(",").map((heroClass) => ({ class: heroClass.trim().toUpperCase() as HeroClass })) };
}

/** "EPIC:10" -> epic gear of tier 10; "EPIC" -> tier 0; "none" -> no gear. */
function parseGear(text: string): GearSpec | null {
  if (text.toLowerCase() === "none") return null;
  const [rarity, tier] = text.split(":");
  if (!GEAR_RARITIES.includes(rarity!.toUpperCase() as GearRarity)) throw new Error(`--gear: unknown rarity "${rarity}". Valid: ${GEAR_RARITIES.join(", ")}, or "none".`);
  return { rarity: rarity!.toUpperCase() as GearRarity, tier: tier ? Number(tier) : 0 };
}

function teamsFromFile(file: string): [TeamSpec, TeamSpec] {
  const content = JSON.parse(readFileSync(file, "utf8"));
  if (!content.a || !content.b) throw new Error(`${file} must contain two teams: "a" and "b".`);
  return [content.a, content.b];
}

function report(data: GameData, result: MatchResult, elapsedMs: number) {
  const { a, b } = result;
  const percent = (share: number) => `${Math.round(share * 100)} %`;
  const columnWidth = Math.max(a.name.length, describeTeam(a).length, 12) + 3;
  const row = (label: string, left: string | number, right: string | number) => print(`  ${label.padEnd(24)}${String(left).padEnd(columnWidth)}${right}`);

  print(`\n${a.name}  vs  ${b.name}`);
  const gear = result.defaultGear ? `${result.defaultGear.rarity} tier ${result.defaultGear.tier}` : "none";
  print(`${result.runs} fights (each team ${result.runs / 2}x on each side), seed ${result.seed}, data: ${data.environment}`);
  print(`default gear: ${gear}, level ${result.level} (${result.level} talent points per hero)`);
  print();
  row("", a.name, b.name);
  row("heroes", describeTeam(a), describeTeam(b));
  row("wins", a.wins, b.wins);
  row("win rate", percent(a.winRate), percent(b.winRate));
  row("  by wiping the enemy", a.winsByKill, b.winsByKill);
  row("  on time (more health)", a.winsByTimeout, b.winsByTimeout);
  row("  standing on the left", a.winsOnLeft, b.winsOnLeft);
  row("  standing on the right", a.winsOnRight, b.winsOnRight);
  row("avg damage dealt", Math.round(a.avgDamageDealt), Math.round(b.avgDamageDealt));
  row("avg team health left", percent(a.avgHealthLeft), percent(b.avgHealthLeft));
  print();
  print(`  draws: ${result.draws}   fights that hit the 120 s limit: ${result.timeouts}   avg fight: ${result.avgSeconds.toFixed(1)} s`);

  for (const team of [a, b]) {
    print(`\n  ${team.name}: per hero (avg damage per fight, how often the hero survived)`);
    for (const hero of team.heroes) print(`    ${hero.name.padEnd(16)} ${hero.class.padEnd(9)} ${String(Math.round(hero.avgDamageDealt)).padStart(7)}   ${percent(hero.survivalRate).padStart(5)}`);
  }
  for (const note of result.notes) print(`\n  NOTE: ${note}`);
  print(`\n(computed in ${(elapsedMs / 1000).toFixed(1)} s)`);
}

function describeTeam(team: TeamSummary): string {
  const counts = new Map<string, number>();
  for (const hero of team.heroes) counts.set(hero.class, (counts.get(hero.class) ?? 0) + 1);
  return [...counts].map(([heroClass, count]) => `${count}x${heroClass.slice(0, 4)}`).join(" ");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
