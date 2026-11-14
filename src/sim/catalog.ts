// What can go into a team: the skills and talents of each class, with the rules for combining them.
// Used by the command line (`list`) and by the MCP server (`list_team_options`).

import type { GameData } from "./data.js";
import { GEAR_RARITIES, GEAR_SLOTS, MAX_GEAR_TIER } from "./gear.js";
import { buildTeam, DEFAULT_BUILD_OPTIONS, HERO_CLASSES, MAX_SKILLS_PER_HERO, skillsOf, type HeroClass } from "./team.js";

export interface SkillOption {
  id: string;
  rarity: string;
  /** Highest upgrade tier this skill has (tiers start at 0). */
  maxTier: number;
  tags: string[];
  /** Marked as locked in the game data. */
  locked: boolean;
}

export interface TalentOption {
  id: string;
  maxRank: number;
  costPerRank: number;
  /** Points that must already be spent on other talents of the same tree. */
  pointsNeededInTree: number;
  /** Talents that unlock this one; at least one of them must be learned first. Empty = no prerequisite. */
  after: string[];
  /** Set for capstone talents: the skill that replaces the hero's core skill. */
  capstoneCoreSkill?: string;
}

export interface ClassOptions {
  class: HeroClass;
  /** The skill every hero of this class has without spending a skill slot. */
  coreSkill: string;
  skills: SkillOption[];
  talentTrees: { name: string; talents: TalentOption[] }[];
}

export async function teamOptions(data: GameData, onlyClass?: HeroClass): Promise<ClassOptions[]> {
  const definitions = { skillDefinitions: await data.skillDefinitions(), otherMetadata: await data.otherMetadata() };
  const { talents } = data.game;

  const options: ClassOptions[] = [];
  for (const heroClass of HERO_CLASSES) {
    if (onlyClass && onlyClass !== heroClass) continue;

    // a bare hero tells us the class's core skill
    const bare = await buildTeam(data, definitions, { name: "catalog", heroes: [{ class: heroClass, gear: null }] }, DEFAULT_BUILD_OPTIONS);

    options.push({
      class: heroClass,
      coreSkill: bare.heroes[0].coreSkill.skillId,
      skills: skillsOf(definitions, heroClass).map((skill) => ({
        id: skill._skillId,
        rarity: skill._rarity,
        maxTier: skill.qualities.length - 1,
        tags: skill.tags ?? [],
        locked: skill.isLocked === true,
      })),
      talentTrees: talents.getClassTalentTrees(definitions.otherMetadata.characterSpecializations, heroClass).map((tree: any) => {
        const nodes: any[] = tree.characterSpecialization ?? [];
        return {
          name: tree.displayName ?? tree.specializationType,
          talents: nodes.map((node) => ({
            id: node._id,
            maxRank: talents.getMaxTalentLevels(node),
            costPerRank: node.cost,
            pointsNeededInTree: node.totalTalentsNeeded ?? 0,
            after: nodes.filter((other) => (other.connectedIds ?? []).includes(node._id)).map((other) => other._id),
            capstoneCoreSkill: node.equipEffects?.skillUnlocks?.[0],
          })),
        };
      }),
    });
  }
  return options;
}

/** Compact text listing: easier to read, and far fewer tokens for an LLM, than the same data as JSON. */
export function formatTeamOptions(options: ClassOptions[]): string {
  const lines = [
    `TEAM: 1-5 heroes. Classes: ${HERO_CLASSES.join(", ")}.`,
    `GEAR: one rarity and one tier for all ${GEAR_SLOTS.length} items of a hero. Rarity: ${GEAR_RARITIES.join(" < ")}. Tier 0-${MAX_GEAR_TIER}; each tier adds 1 % to an item's main stat.`,
    `SKILLS: up to ${MAX_SKILLS_PER_HERO} per hero, on top of the class's core skill. A team has one skill tier (0-5) for all its skills; a skill with fewer tiers stops at its own maximum.`,
    "TALENTS: a hero has 1 talent point per level. Rules: enough points, the required points already spent in the same tree, at least one of the talents listed under \"after\" learned first, and at most one capstone per hero.",
  ];

  for (const entry of options) {
    lines.push("", `${entry.class}  (core skill: ${entry.coreSkill})`);
    lines.push("  skills:");
    for (const skill of entry.skills) {
      if (skill.id === entry.coreSkill) continue;
      lines.push(`    ${skill.id.padEnd(26)} ${skill.rarity.padEnd(9)} tiers 0-${skill.maxTier}  ${skill.locked ? "locked " : ""}${skill.tags.join(" ")}`);
    }
    for (const tree of entry.talentTrees) {
      lines.push(`  talent tree "${tree.name}":`);
      for (const talent of tree.talents) {
        const rules = [`${talent.costPerRank} point${talent.costPerRank === 1 ? "" : "s"} per rank`];
        if (talent.pointsNeededInTree > 0) rules.push(`needs ${talent.pointsNeededInTree} points in this tree`);
        if (talent.after.length > 0) rules.push(`after ${talent.after.join(" or ")}`);
        if (talent.capstoneCoreSkill) rules.push(`capstone: core skill becomes ${talent.capstoneCoreSkill}`);
        lines.push(`    ${talent.id.padEnd(26)} ranks 1-${talent.maxRank}  ${rules.join("; ")}`);
      }
    }
  }
  return lines.join("\n");
}
