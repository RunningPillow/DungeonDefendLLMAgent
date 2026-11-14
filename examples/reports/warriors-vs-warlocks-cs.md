# Je v aréně silnější pět warriorů, nebo pět warlocků? A mění se to s lepší výbavou?

Při běžné výbavě (COMMON 0, RARE 20, EPIC 30) nelze určit, kdo je silnější, protože o každém souboji rozhodla strana arény. Teprve při LEGENDARY 50 se projevila převaha warlocků: vyhráli 65 % všech soubojů (130 z 200) a jako jediní vyhráli i na pravé straně (30 z 100). S lepší výbavou se tedy výsledek mění: warlockové nabírají náskok, ale jen v jednom testovaném sestavení.

## Findings

1. **Do výbavy EPIC 30 včetně rozhodovala jen strana arény. Kdo stál vlevo, vyhrál, takže síla týmů z toho nevyplývá.** (confidence: high)
   Level 10, skillTier 2, 5 vs 5. COMMON 0 (60 soubojů): vlevo vyhrál tým ve všech 60. RARE 20 (60 soubojů): totéž. EPIC 30 (200 soubojů): totéž, 100 výher vlevo pro každý tým. Warlockové působili víc poškození (např. u RARE 20 průměrně 13312 proti 8487), ale vítěze to neurčilo.
2. **Při LEGENDARY 50 jsou warlockové silnější. Vyhrají na obou stranách, warrioři jen když stojí vlevo.** (confidence: high)
   LEGENDARY 50, seed 2, 200 soubojů: warlockové 130 výher (65 %), z toho 100 vlevo a 30 vpravo. Warrioři 70 výher, všechny vlevo, 0 vpravo. Seed 1, 60 soubojů: warlockové 42 (70 %), z toho 12 vpravo. Warlockové dali průměrně 399 656 poškození proti 228 409 a zůstalo jim 36 % zdraví proti 5 %.
3. **Strana arény zůstává významná i u nejlepší výbavy. Vlevo vyhrálo 170 z 200 soubojů.** (confidence: high)
   LEGENDARY 50, seed 2: poznámka simulátoru uvádí 170 z 200 výher pro levý tým.

## Recommendations

- **Zatím neměnit čísla v datech. Nejdřív zjistit, kde mezi EPIC 30 a LEGENDARY 50 se rozdíl objeví, a ověřit to na dalších sestaveních. Pokud by se warlockové potvrdili jako příliš silní, začít u poškození SOULFIRE_1 nebo talentů WL_DES_KEEN_MALICE a WL_DES_INFERNAL_HEAT.**
  Převaha warlocků je doložená jen u LEGENDARY 50 a jen pro jedno sestavení. Příčinu (skaluje jejich poškození rychleji, nebo warriorům chybí výdrž) jsme nezkoumali.
- **Zvážit vyrovnání výhody levé strany (útočníka). Zatím bez konkrétního čísla.**
  Strana rozhodla všechny souboje do EPIC 30 a 85 % při LEGENDARY 50.

## Limitations

- Testoval jsem jen jedno sestavení na třídu: warrioři s Fury talenty a skilly SLAM, REND, WHIRLWIND; warlockové s Destruction talenty a skilly CORRUPTION, CURSE_OF_AGONY, SOULFIRE. Jiné buildy (Protection, Affliction, tankové skilly) mohou dopadnout jinak.
- Měřil jsem jen level 10 a skillTier 2. Mezi hodnotami výbavy jsem otestoval jen čtyři body: COMMON 0, RARE 20, EPIC 30 a LEGENDARY 50. Přesný bod zlomu neznám.
- Do EPIC 30 nelze tým s výhodou levé strany od slabšího rozlišit, takže tam nevíme, kdo je silnější.
- Nezkoušel jsem smíšené týmy ani týmy s podporou (shaman). Otázka se týkala čistých týmů po pěti hrdinech.
