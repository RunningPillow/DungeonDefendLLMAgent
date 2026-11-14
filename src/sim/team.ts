// Turns a short description of a team ("two warriors with these talents, one shaman...")
// into the game's own character object, ready to be sent into a fight.
//
// In the game a hero without gear, talents and skills is identical for every class
// (20 health, 5 damage power). A hero's strength comes from four things, and those are
// exactly what a team description controls: class, gear, talents and skills.

import type { GameData } from "./data.js";
import { checkGear, generateGear, type GearSpec } from "./gear.js";
import { applyTalents } from "./talents.js";

export const HERO_CLASSES = ["WARRIOR", "SHAMAN", "WARLOCK"] as const;
export type HeroClass = (typeof HERO_CLASSES)[number];

/** The game lets a hero equip at most this many skills on top of the core skill. */
export const MAX_SKILLS_PER_HERO = 3;

export interface HeroSpec {
  class: HeroClass;
  /** Up to 3 skill ids, e.g. ["TAUNT_1", "WHIRLWIND_1"]. The class's core skill is always present. */
  skills?: string[];
  /** Talent id -> rank, e.g. { "WR_FURY_CRUELTY": 3 }. Must be a build a player could learn. */
  talents?: Record<string, number>;
  /** Rarity and tier of all eight items. Omit to use the match default; null = no gear. */
  gear?: GearSpec | null;
  name?: string;
}

export interface TeamSpec {
  name: string;
  heroes: HeroSpec[];
  /** Upgrade tier of all skills, 0 (base) to 5. Skills with fewer tiers stop at their own maximum. */
  skillTier?: number;
  /** Skill id -> tier, for skills that should differ from skillTier. Shared by the whole team, as in the game. */
  skillTiers?: Record<string, number>;
}

export interface BuildOptions {
  /** Gear for heroes that do not specify their own. null = no gear. */
  gear: GearSpec | null;
  /** Hero level, the same for everyone. As in the game, a hero has one talent point per level. */
  level: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = { gear: { rarity: "COMMON", tier: 0 }, level: 10 };

/** Definitions shared by both teams of one fight. */
export interface Definitions {
  skillDefinitions: any;
  otherMetadata: any;
}

/** Builds the game's CharacterDocument for a team. Throws a descriptive error if the description is invalid. */
export async function buildTeam(data: GameData, definitions: Definitions, spec: TeamSpec, options: BuildOptions): Promise<any> {
  const character = await data.templateCharacter();
  const bodies: any[] = character.heroes.filter((hero: any) => !hero.placeholder);

  if (spec.heroes.length === 0) throw new Error(`Team "${spec.name}" has no heroes.`);
  if (spec.heroes.length > bodies.length) throw new Error(`Team "${spec.name}" has ${spec.heroes.length} heroes, the maximum is ${bodies.length}.`);
  if (!Number.isInteger(options.level) || options.level < 1) throw new Error(`Level must be a whole number of at least 1, got ${options.level}.`);

  // Start from a clean slate so the template character's own progress does not leak into the result.
  character.characterName = spec.name;
  character.paragonLevel = 0;
  character.craftingRecipesUnlocked = [];
  character.skillUpgradeLog = skillUpgradeLog(data, definitions, spec);

  const heroes = spec.heroes.map((heroSpec, index) => {
    const hero = bodies[index];
    const label = `${spec.name} / hero ${index + 1} (${heroSpec.class})`;
    if (!HERO_CLASSES.includes(heroSpec.class)) throw new Error(`${label}: unknown class. Valid classes: ${HERO_CLASSES.join(", ")}.`);

    hero.characterClass = heroSpec.class;
    hero.name = heroSpec.name ?? `${capitalize(heroSpec.class)} ${index + 1}`;
    hero.stats.level = options.level;

    const gear = heroSpec.gear === undefined ? options.gear : heroSpec.gear;
    if (gear) checkGear(gear, label);
    hero.equipment = gear ? generateGear(data, definitions.skillDefinitions, heroSpec.class, options.level, gear) : [];

    hero.passiveEquipEffects = [];
    applyTalents(data, definitions.otherMetadata, hero, heroSpec.class, heroSpec.talents ?? {}, options.level, label);

    const skills = heroSpec.skills ?? [];
    if (skills.length > MAX_SKILLS_PER_HERO) throw new Error(`${label}: ${skills.length} skills given, the maximum is ${MAX_SKILLS_PER_HERO}.`);
    if (new Set(skills).size !== skills.length) throw new Error(`${label}: the same skill is listed twice.`);
    hero.skillbook = [];
    delete hero.equippedCombatSkillIds;
    hero.skillSlotsUnlocked = MAX_SKILLS_PER_HERO;
    for (const skillId of skills) {
      requireSkill(definitions, skillId, heroSpec.class, label);
      hero.addSkillToSkillbook(skillId, definitions.skillDefinitions);
    }

    hero.recalculateAllBlesses();
    hero.recalculateCharacterStats();
    hero.coreSkill = null; // a capstone talent can replace the core skill, so it is assigned last
    hero.assignCoreSkill(definitions.skillDefinitions);
    hero.stats.currentHealth = hero.stats.totalMaxHealth;
    return hero;
  });

  character.heroes = heroes;
  return character;
}

/** The team's record of how far each skill is upgraded. The game reads a skill's numbers through it. */
function skillUpgradeLog(data: GameData, definitions: Definitions, spec: TeamSpec): any[] {
  const teamTier = spec.skillTier ?? 0;
  if (!Number.isInteger(teamTier) || teamTier < 0) throw new Error(`Team "${spec.name}": skillTier must be a whole number of at least 0, got ${teamTier}.`);
  for (const skillId of Object.keys(spec.skillTiers ?? {})) requireSkill(definitions, skillId, undefined, `Team "${spec.name}"`);

  return definitions.skillDefinitions.skills.map((skill: any) => {
    const maxTier = skill.qualities.length - 1;
    const ownTier = spec.skillTiers?.[skill._skillId];
    if (ownTier !== undefined && (!Number.isInteger(ownTier) || ownTier < 0 || ownTier > maxTier))
      throw new Error(`Team "${spec.name}": skill "${skill._skillId}" has tiers 0 to ${maxTier}, got ${ownTier}.`);
    return new data.game.idx.SkillUpgradeLogEntry(skill._skillId, ownTier ?? Math.min(teamTier, maxTier), 0);
  });
}

function requireSkill(definitions: Definitions, skillId: string, heroClass: HeroClass | undefined, label: string): void {
  const skill = definitions.skillDefinitions.skills.find((candidate: any) => candidate._skillId === skillId);
  if (!skill) throw new Error(`${label}: unknown skill "${skillId}".${heroClass ? ` Skills of ${heroClass}: ${skillIdsOf(definitions, heroClass).join(", ")}.` : ""}`);
  if (heroClass && !skill._characterClass.includes(heroClass))
    throw new Error(`${label}: skill "${skillId}" belongs to ${skill._characterClass.join("/")}. Skills of ${heroClass}: ${skillIdsOf(definitions, heroClass).join(", ")}.`);
}

/** Skill definitions of one class. In the game data a skill lists the classes that may use it. */
export function skillsOf(definitions: Definitions, heroClass: HeroClass): any[] {
  return definitions.skillDefinitions.skills.filter((skill: any) => skill._characterClass.includes(heroClass));
}

function skillIdsOf(definitions: Definitions, heroClass: HeroClass): string[] {
  return skillsOf(definitions, heroClass).map((skill: any) => skill._skillId);
}

const capitalize = (text: string) => text[0] + text.slice(1).toLowerCase();
