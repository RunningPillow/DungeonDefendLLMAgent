// Checks that the simulator does what it claims. These tests run the game's real code against
// real game data, so they need the same access as the simulator itself (see .env.example).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { GameData } from "../src/sim/data.js";
import { notesFor, runMatch, type MatchResult, type TeamSummary } from "../src/sim/match.js";
import { buildTeam, DEFAULT_BUILD_OPTIONS, type HeroSpec, type TeamSpec } from "../src/sim/team.js";

let data: GameData;
before(async () => {
  data = await GameData.load();
});

const team = (name: string, ...heroes: HeroSpec[]): TeamSpec => ({ name, heroes });
const warrior = (extra: Partial<HeroSpec> = {}): HeroSpec => ({ class: "WARRIOR", ...extra });

/** Builds a single hero and returns the game's hero object. */
async function buildHero(hero: HeroSpec, teamExtra: Partial<TeamSpec> = {}, options = DEFAULT_BUILD_OPTIONS) {
  const definitions = { skillDefinitions: await data.skillDefinitions(), otherMetadata: await data.otherMetadata() };
  const character = await buildTeam(data, definitions, { name: "T", heroes: [hero], ...teamExtra }, options);
  return character.heroes[0];
}

test("the same seed replays exactly the same match", async () => {
  const a = team("A", warrior(), { class: "SHAMAN" });
  const b = team("B", { class: "WARLOCK" }, { class: "WARLOCK" });
  const first = await runMatch(data, a, b, { runs: 10, seed: 42 });
  const second = await runMatch(data, a, b, { runs: 10, seed: 42 });
  const other = await runMatch(data, a, b, { runs: 10, seed: 43 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
});

test("each team fights half of the fights on each side, and every fight has a result", async () => {
  const result = await runMatch(data, team("A", warrior()), team("B", warrior()), { runs: 9, seed: 1 });
  assert.equal(result.runs, 10, "an odd number of runs is rounded up");
  assert.equal(result.a.wins + result.b.wins + result.draws, result.runs);
  assert.ok(result.a.winsOnLeft <= 5 && result.a.winsOnRight <= 5);
});

test("a bare hero is the same for every class: 20 health, 5 damage power", async () => {
  for (const heroClass of ["WARRIOR", "SHAMAN", "WARLOCK"] as const) {
    const hero = await buildHero({ class: heroClass, gear: null });
    assert.equal(hero.stats.totalMaxHealth, 20);
    assert.equal(hero.stats.totalDamagePower, 5);
  }
});

test("gear: all eight items have the requested rarity and tier", async () => {
  const hero = await buildHero(warrior({ gear: { rarity: "RARE", tier: 7 } }));
  assert.equal(hero.equipment.length, 8);
  for (const item of hero.equipment) {
    assert.equal(item.rarity, "RARE");
    assert.equal(item.tier, 7);
  }
});

test("gear: higher rarity and higher tier both make the hero stronger", async () => {
  const health = async (rarity: "COMMON" | "EPIC", tier: number) => (await buildHero(warrior({ gear: { rarity, tier } }))).stats.totalMaxHealth;
  const common = await health("COMMON", 0);
  assert.ok((await health("EPIC", 0)) > common);
  assert.ok((await health("COMMON", 50)) > common);
});

test("gear: the same description always gives the same items", async () => {
  const describe = async () => JSON.stringify((await buildHero(warrior({ gear: { rarity: "EPIC", tier: 3 } }))).equipment.map((item: any) => item.effects));
  assert.equal(await describe(), await describe());
});

test("gear: the better equipped team wins", async () => {
  const result = await runMatch(data, team("Epic", warrior({ gear: { rarity: "EPIC", tier: 0 } })), team("Common", warrior()), { runs: 10, seed: 1 });
  assert.equal(result.a.wins, 10);
});

test("skill tier: skills are built at the requested tier, capped at each skill's own maximum", async () => {
  const tierOf = async (skillTier: number) => {
    const hero = await buildHero({ class: "WARLOCK", skills: ["WARLOCK_TOUCH_1"] }, { skillTier });
    return { core: hero.coreSkill.qualityReached, touch: hero.skillbook[0].skill.qualityReached };
  };
  assert.deepEqual(await tierOf(0), { core: 0, touch: 0 });
  assert.deepEqual(await tierOf(5), { core: 5, touch: 3 }, "SHADOWBOLT_1 has tiers 0-5, WARLOCK_TOUCH_1 only 0-3");
});

test("skill tier: one skill can be set apart from the rest of the team's skills", async () => {
  const hero = await buildHero({ class: "WARLOCK", skills: ["CORRUPTION_1"] }, { skillTier: 1, skillTiers: { CORRUPTION_1: 4 } });
  assert.equal(hero.coreSkill.qualityReached, 1);
  assert.equal(hero.skillbook[0].skill.qualityReached, 4);
});

test("skill tier: a tier above the skill's maximum is rejected", async () => {
  await assert.rejects(buildHero(warrior(), { skillTiers: { PUNCH_1: 9 } }), /tiers 0 to 5/);
});

test("skills: unknown skills and skills of another class are rejected", async () => {
  await assert.rejects(buildHero(warrior({ skills: ["NO_SUCH_SKILL"] })), /unknown skill/);
  await assert.rejects(buildHero(warrior({ skills: ["LIGHTNING_1"] })), /belongs to SHAMAN/);
  await assert.rejects(buildHero(warrior({ skills: ["TAUNT_1", "REND_1", "SAVAGE_1", "WHIRLWIND_1"] })), /maximum is 3/);
});

test("talents: a legal build is accepted, in whatever order it is written", async () => {
  const hero = await buildHero(warrior({ talents: { WR_PROT_SHIELD_SLAM: 1, WR_PROT_SAFEGUARD: 1, WR_PROT_INTIMIDATION: 1, WR_PROT_TOUGHNESS: 2, WR_PROT_DEFIANCE: 3 } }));
  assert.equal(hero.passiveEquipEffects.filter((effect: any) => effect.typeId === "TALENT").length, 8, "one stored effect per learned rank");
  assert.equal(hero.coreSkill.skillId, "SHIELD_SLAM_1", "the capstone replaces the core skill");
});

test("talents: builds a player could not learn are rejected with the reason", async () => {
  // second-row talent without enough points in the tree
  await assert.rejects(buildHero(warrior({ talents: { WR_PROT_DEFIANCE: 2, WR_PROT_INTIMIDATION: 1 } })), /needs 3 points spent in the Protection tree/);
  // enough points in the tree, but the talent leading to it is missing
  await assert.rejects(buildHero(warrior({ talents: { WR_PROT_TOUGHNESS: 3, WR_PROT_INTIMIDATION: 1 } })), /requires WR_PROT_DEFIANCE first/);
  // two capstones
  await assert.rejects(
    buildHero(warrior({ talents: { WR_PROT_DEFIANCE: 3, WR_PROT_TOUGHNESS: 3, WR_PROT_INTIMIDATION: 1, WR_PROT_SHIELD_SLAM: 1, WR_FURY_CRUELTY: 3, WR_FURY_THICK_BLOOD: 3, WR_FURY_DEEP_WOUNDS: 1, WR_FURY_RAGING_BLOW: 1 } }), {}, { ...DEFAULT_BUILD_OPTIONS, level: 30 }),
    /only one capstone/,
  );
  // more points than the hero's level gives
  await assert.rejects(buildHero(warrior({ talents: { WR_PROT_DEFIANCE: 3, WR_PROT_TOUGHNESS: 3 } }), {}, { ...DEFAULT_BUILD_OPTIONS, level: 5 }), /cost 6 points, but the hero has 5/);
  // rank above the talent's maximum, talent of another class
  await assert.rejects(buildHero(warrior({ talents: { WR_PROT_DEFIANCE: 4 } })), /ranks 1 to 3/);
  await assert.rejects(buildHero(warrior({ talents: { SH_RESTO_RIPTIDE: 1 } })), /unknown talent/);
});

// The notes are checked on made-up results, not on real fights: what the game's combat produces
// changes whenever the game is rebalanced, and these tests must not break when it does.
test("notes flag results where the win rate does not show which team is stronger", () => {
  const side = (wins: number, onLeft: number, byTimeout = 0): TeamSummary => ({
    name: "T", wins, winRate: 0, winsByKill: wins - byTimeout, winsByTimeout: byTimeout, winsOnLeft: onLeft, winsOnRight: wins - onLeft, avgDamageDealt: 0, avgHealthLeft: 0, heroes: [],
  });
  const result = (a: TeamSummary, b: TeamSummary, timeouts = 0): MatchResult => ({ notes: [], runs: 40, seed: 1, defaultGear: null, level: 10, draws: 0, timeouts, avgSeconds: 0, a, b });

  assert.deepEqual(notesFor(result(side(22, 11), side(18, 9))), [], "an ordinary result needs no note");
  assert.match(notesFor(result(side(20, 20), side(20, 20))).join(" "), /arena side decided every fight: the team standing on the left always won/);
  assert.match(notesFor(result(side(20, 0), side(20, 0))).join(" "), /standing on the right always won/);
  assert.match(notesFor(result(side(10, 10), side(30, 20))).join(" "), /arena side mattered a lot: the team standing on the left won 30 of 40/);
  assert.match(notesFor(result(side(20, 10, 20), side(20, 10, 20), 40)).join(" "), /Every fight hit the 120 s time limit/);
  assert.match(notesFor(result(side(25, 12, 15), side(15, 8, 10), 25)).join(" "), /25 of 40 fights hit the 120 s time limit/);
});

test("the simulator never writes to the database", async () => {
  assert.throws(() => data.offlineTransaction.set(), /read-only/);
  await assert.rejects(data.offlineTransaction.get({ path: "characters/someone-else" }), /offline/);
});
