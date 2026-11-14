// Talents for a simulated hero, with the game's rules enforced.
//
// In the game a player cannot pick talents freely: every rank costs a point, deeper talents need
// a number of points already spent in the same tree, talents unlock each other along the tree's
// connections, and only one "capstone" (a talent that replaces the core skill) is allowed.
// The checks below mirror the game's chooseCharacterSpecialization, so the simulator only accepts
// builds a player could really have.

import type { GameData } from "./data.js";

interface WantedTalent {
  node: any;
  tree: any;
  rank: number;
  learned: number;
}

const isCapstone = (node: any) => (node.equipEffects?.skillUnlocks?.length ?? 0) > 0;
const treeName = (tree: any) => tree.displayName ?? tree.specializationType;

/** Learns the given talents on the hero rank by rank, or throws an error explaining which rule the build breaks. */
export function applyTalents(data: GameData, otherMetadata: any, hero: any, heroClass: string, talents: Record<string, number>, talentPoints: number, label: string): void {
  const helpers = data.game.talents;
  const trees: any[] = helpers.getClassTalentTrees(otherMetadata.characterSpecializations, heroClass);
  const nodesOf = (tree: any): any[] => tree.characterSpecialization ?? [];

  const wanted: WantedTalent[] = Object.entries(talents).map(([nodeId, rank]) => {
    const tree = trees.find((candidate) => nodesOf(candidate).some((node) => node._id === nodeId));
    if (!tree) throw new Error(`${label}: unknown talent "${nodeId}". Talents of ${heroClass}: ${trees.flatMap(nodesOf).map((node) => node._id).join(", ")}.`);
    const node = nodesOf(tree).find((candidate) => candidate._id === nodeId);
    const maxRank: number = helpers.getMaxTalentLevels(node);
    if (!Number.isInteger(rank) || rank < 1 || rank > maxRank) throw new Error(`${label}: talent "${nodeId}" has ranks 1 to ${maxRank}, got ${rank}.`);
    return { node, tree, rank, learned: 0 };
  });

  const capstones = wanted.filter((talent) => isCapstone(talent.node));
  if (capstones.length > 1) throw new Error(`${label}: only one capstone talent is allowed, got ${capstones.map((talent) => talent.node._id).join(" and ")}.`);

  const cost = wanted.reduce((sum, talent) => sum + talent.node.cost * talent.rank, 0);
  if (cost > talentPoints) throw new Error(`${label}: these talents cost ${cost} points, but the hero has ${talentPoints} (one per level).`);

  // Points this build has spent so far in a tree, not counting one talent (the game's rule excludes the talent being learned).
  const spentInTree = (tree: any, except: any, onlyLearned: boolean) =>
    wanted.filter((talent) => talent.tree === tree && talent.node !== except).reduce((sum, talent) => sum + talent.node.cost * (onlyLearned ? talent.learned : talent.rank), 0);

  /** Why the next rank of this talent cannot be learned right now; undefined if it can. */
  const blockedBecause = (talent: WantedTalent): string | undefined => {
    const needed: number = talent.node.totalTalentsNeeded ?? 0;
    if (spentInTree(talent.tree, talent.node, true) < needed)
      return `needs ${needed} points spent in the ${treeName(talent.tree)} tree first (this build spends ${spentInTree(talent.tree, talent.node, false)} there)`;

    const parents = nodesOf(talent.tree).filter((node) => (node.connectedIds ?? []).includes(talent.node._id));
    const reachable =
      talent.learned > 0 ||
      otherMetadata.isOprphanSpecialization(talent.node._id, talent.tree.specializationType) ||
      wanted.some((other) => other.learned > 0 && parents.includes(other.node));
    return reachable ? undefined : `requires ${parents.map((node) => node._id).join(" or ")} first`;
  };

  // Learn in any order the game would accept: keep taking whatever is learnable until nothing more is.
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const talent of wanted) {
      while (talent.learned < talent.rank && blockedBecause(talent) === undefined) {
        talent.learned++;
        hero.addPassiveEquipEffect(talent.node.equipEffects, helpers.makeTalentOriginId(talent.node._id, talent.learned), "TALENT");
        progressed = true;
      }
    }
  }

  const blocked = wanted.filter((talent) => talent.learned < talent.rank);
  if (blocked.length > 0)
    throw new Error(`${label}: a player could not learn this talent build. ${blocked.map((talent) => `${talent.node._id} ${blockedBecause(talent)}`).join("; ")}.`);
}
