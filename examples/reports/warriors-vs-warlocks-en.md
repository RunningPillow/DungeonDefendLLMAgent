# Which is stronger in the arena: five warriors or five warlocks? And does that change with better gear?

Five warlocks beat five warriors once the gear is good, and their lead grows with gear. At COMMON tier 0 and RARE tier 20 the side decides the fights, so neither team can be called stronger. With LEGENDARY gear the warlocks win 63–78% of fights, even though the left side still helps.

## Findings

1. **With low gear (COMMON tier 0) the left side decides everything, so there is no balance conclusion.** (confidence: high)
   Level 10, skill tier 2, 60 fights, seed 1. The left team won all 60 fights, 30 each for warriors and warlocks. Warlocks still dealt more damage per fight (743 vs 448).
2. **With RARE tier 20 gear the side still decides almost everything, though warlocks already deal about twice the damage.** (confidence: medium)
   60 fights, seed 1. The left team won 59 of 60 fights. Warriors won 29 and warlocks 31. Damage per fight was 15,100 for warlocks and 7,466 for warriors.
3. **With LEGENDARY tier 50 gear the warlocks are clearly stronger, and this holds on both sides of the arena.** (confidence: high)
   Seed 1, 60 fights: warlocks won 47 (78%), 30 on the left and 17 on the right. Seed 7, 100 fights: warlocks won 74 (74%), 50 on the left and 24 on the right. Warlocks dealt about 430k damage per fight against about 192k for warriors. Warlocks finished with about 46% of their health left, warriors with about 4%.
4. **At LEGENDARY tier 99 the warlocks are still ahead, but by less than at tier 50.** (confidence: medium)
   Seed 2, 60 fights: warlocks won 38 (63%), 30 on the left and 8 on the right. The left team won 52 of 60 fights, so the side effect is large. Warlocks dealt about 647k damage against about 287k for warriors. This is one match, and its win rate is lower than the tier-50 runs.
5. **Better gear does change the picture. With poor gear the matchup is decided by the side. With high gear the warlock advantage is clear.** (confidence: medium)
   Warlock win rate rose from 52% (RARE 20) to 74–78% (LEGENDARY 50) and 63% (LEGENDARY 99). Fights lasted 4.6 s, 5.1 s, 7.3 s and 6.2 s, so higher gear gives longer fights in which the warlock damage and survival lead shows.

## Recommendations

- **Check the warrior damage and survivability numbers before changing any value. One candidate is the core-skill or SLAM_1/REND_1 damage scaling with gear. Another is a warlock cap on how much damage and survival it gains per gear tier. I am not proposing specific values.**
  Warlocks win 63–78% at LEGENDARY gear with more than double the damage. These simulations only tested one build per class, so they do not support a precise number.
- **Look at the arena's left/right advantage, for example by giving the right side a small bonus. No specific value is proposed.**
  At RARE tier 20 and below, and often at LEGENDARY, the left side won 76–100% of decided fights.

## Limitations

- I tested only one build per class: Fury talents with SLAM, REND and BATTLE_CRY for warriors, and Destruction talents with CORRUPTION, CURSE_OF_AGONY and SOULFIRE for warlocks. Defensive warrior builds (Protection talents, SHIELD_BLOCK, TAUNT) or other warlock builds could change the result.
- I used one level (10) and one skill tier (2). Other levels and skill tiers were not tested.
- I did not try LEGENDARY tier 99 on a second seed, so that result rests on one match of 60 fights.
- I tested only the gear steps COMMON 0, RARE 20, LEGENDARY 50 and LEGENDARY 99. The point where the warlock advantage becomes visible lies somewhere between RARE 20 and LEGENDARY 50. I did not find it.
- Both teams used identical heroes. Mixed teams, which are more common in real play, were not tested.
