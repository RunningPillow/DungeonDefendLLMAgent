// Gear for a simulated hero, described by two numbers: rarity and tier.
//
// All eight items a hero wears get the same rarity and tier. The items are produced by the game's
// own generator (the one behind the anvil), so the stats are what a player would really get.

import type { GameData } from "./data.js";
import { seedFromText, withSeed } from "./random.js";

/** Rarities the game's generator can produce directly. (MYTHICAL only exists as an evolved LEGENDARY item.) */
export const GEAR_RARITIES = ["POOR", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"] as const;
export type GearRarity = (typeof GEAR_RARITIES)[number];

export const GEAR_SLOTS = ["HEAD", "BODY", "LEGS", "HANDS", "MAIN_HAND", "FINGER_1", "AMULET", "TRINKET"] as const;

/** The anvil produces tiers up to 99. Each tier adds 1 % to the item's main stat, compounding. */
export const MAX_GEAR_TIER = 99;

export interface GearSpec {
  rarity: GearRarity;
  /** 0..99 */
  tier: number;
}

export function checkGear(gear: GearSpec, label: string): void {
  if (!GEAR_RARITIES.includes(gear.rarity)) throw new Error(`${label}: unknown gear rarity "${gear.rarity}". Valid: ${GEAR_RARITIES.join(", ")}.`);
  if (!Number.isInteger(gear.tier) || gear.tier < 0 || gear.tier > MAX_GEAR_TIER) throw new Error(`${label}: gear tier must be a whole number 0 to ${MAX_GEAR_TIER}, got ${gear.tier}.`);
}

/** The eight items for one hero. */
export function generateGear(data: GameData, skillDefinitions: any, heroClass: string, level: number, gear: GearSpec): any[] {
  const { equip } = data.game;

  // For a few slots the game picks one of two stats at random (e.g. health or resistance). A fixed
  // seed per class and rarity makes that pick always the same, so two matches stay comparable.
  return withSeed(seedFromText(`gear|${heroClass}|${gear.rarity}`), () =>
    GEAR_SLOTS.map((slot) => {
      const item = equip.generateEquip(level, gear.rarity, slot, heroClass, skillDefinitions);

      // Same arithmetic the anvil uses when it rolls a tier (applyAnvilGeneratedTier in the game),
      // with the tier given instead of rolled.
      for (const effect of item.effects ?? []) {
        if (!effect.isInherent) continue;
        for (const rareEffect of effect.rareEffects ?? []) {
          rareEffect.amount = equip.applyEquipQualityUpgradeToAmountForTiers(rareEffect.amount, gear.tier);
          rareEffect.amountMax = equip.applyEquipQualityUpgradeToAmountForTiers(rareEffect.amountMax, gear.tier);
        }
      }
      item.tier = gear.tier;
      return item;
    }),
  );
}
