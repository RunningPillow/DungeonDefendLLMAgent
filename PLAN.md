# Plán projektu

Pracovní dokument v češtině. Co stavíme, v jakém pořadí a co je hotové.

## Cíl

1. **Nástroj pro balanc Dungeon Defend.** Najít nejsilnější kombinace hrdinů, skillů a talentů v PvP dřív než hráči, pochopit proč jsou silné a ověřit, že oprava funguje.
2. **Ukázka do portfolia** pro pozice typu AI Agent Engineer: vlastní agent, MCP, napojení na skutečná data, měření ceny a spolehlivosti.

## Jak to do sebe zapadá

| Část | Co to je | Je uvnitř LLM? |
|---|---|---|
| Kód hry | Skutečný výpočet boje na serveru hry. Neměníme ho. | ne |
| Simulátor | Tenká obálka: postaví dva týmy, zavolá skutečný kód hry a sečte výsledky. | ne |
| MCP server | „Zásuvka", přes kterou simulátor použije jakýkoli agent (Claude Code i náš vlastní). | ne |
| Agent | Program, který nechá model ve smyčce pokládat simulátoru otázky a vyhodnocovat odpovědi. | ano |
| Měření | Kolik jeden běh agenta stojí a jak často dojde ke stejnému závěru. | ano |

## Kroky

### 1. Simulátor — hotovo

- postaví libovolný tým až 5 hrdinů,
- pustí zápas = mnoho soubojů, každý tým polovinu na levé a polovinu na pravé straně,
- vrátí winrate, způsob výhry (zabitím / na čas), damage a přežití po hrdinech,
- zopakuje přesně stejný zápas podle čísla `seed`,
- běží bez databáze: data se načtou jednou na začátku, zápis je zablokovaný.

### 2. Aby simulace odpovídala hře — hotovo

Sílu hrdiny určují čtyři věci a všechny se dají nastavit:

| Co | Jak se zadává | Pravidla, která simulátor hlídá |
|---|---|---|
| Třída | `WARRIOR`, `SHAMAN`, `WARLOCK` | |
| Výbava | rarita + tier, stejné pro všech 8 předmětů | rarita `POOR` až `LEGENDARY`, tier 0–99; předměty vyrábí herní generátor |
| Skilly | až 3 skilly + tier skillů 0–5 pro celý tým | skill musí patřit třídě; tier nejvýš tolik, kolik skill má |
| Talenty | talent → počet ranků | body (1 za úroveň hrdiny), body utracené ve stromu, návaznost talentů, jen jeden capstone |

Změny „co kdyby" (dočasná úprava čísla jen v simulátoru) jsme vypustili. Balanc se mění přímo v databázi a simulátor si změnu načte sám.

### 3. MCP server — hotovo

Server nabízí agentům dva nástroje:

| Nástroj | Co dělá |
|---|---|
| `list_team_options` | Vypíše, z čeho jde postavit tým: skilly, talenty a pravidla. |
| `simulate_match` | Pustí zápas dvou týmů a vrátí statistiky. |

Co server dělá navíc:
- **Drží data v paměti.** První volání trvá asi 4 s, další kolem půl sekundy.
- **Hlídá čerstvost dat.** Před každým voláním se zeptá databáze, jestli se něco změnilo, a změněné dokumenty načte znovu.
- **Upozorní na starý kód hry.** Když se hra po startu serveru znovu zkompiluje, výsledek to oznámí. Pak je potřeba server restartovat.
- **Přidává poznámky k výsledku.** Například když o všech soubojích rozhodla strana arény, takže winrate nic neříká o síle týmů.

### 4. Používání s Claude Code — další na řadě

Server je pro tento projekt zapsaný v `.mcp.json`. Postup:

1. Otevřít novou konverzaci Claude Code v této složce.
2. Povolit server `dungeon-defend-sim`, až se Claude Code zeptá.
3. Klást otázky k balancu. Tady se ukáže, které dávají smysl a co nástrojům chybí.

Pro použití z jiného projektu (třeba přímo z Dungeon Defend) se server přidá s celou cestou:

```
claude mcp add dungeon-defend-sim -- node "<cesta k DDLLMAgent>/node_modules/tsx/dist/cli.mjs" "<cesta k DDLLMAgent>/src/mcp/server.ts"
```

Co nástrojům nejspíš bude chybět:
- rozpad damage po skillech (který skill dělá kolik),
- popis, co který skill a talent dělá,
- víc zápasů v jednom volání (turnaj „každý s každým").

### 5. Vlastní agent — hotovo, běží

Agent je program, který nechá model opakovat čtyři kroky, dokud neodevzdá report:

1. pošle modelu dosavadní rozhovor a seznam nástrojů,
2. model odpoví textem nebo žádostí o zavolání nástrojů,
3. program nástroje spustí a výsledky přidá do rozhovoru,
4. opakuje.

Model rozhoduje, co dál. Program rozhoduje, co model smí, počítá cenu a umí ho zastavit.

Smyčku umí točit dva „motory". Zadání, nástroje i tvar reportu mají společné:

| Motor | Kdo točí smyčku | Kdo platí | Stav |
|---|---|---|---|
| `claude-code` (výchozí) | Claude Code spuštěný bez okna, omezený jen na naše zadání a naše dva nástroje | předplatné Claude, za běh se neplatí | běží, ověřeno skutečnými běhy |
| `api` | naše ručně psaná smyčka v `loop.ts` nad Claude API | klíč k API, platí se za tokeny | otestovaná s modelem nahrazeným scénářem; naostro neběžela, protože nemáme klíč |

Co agent umí:
- nástroje si zjistí od MCP serveru, o simulátoru sám nic neví,
- odpověď má pevný tvar (odpověď, zjištění s důkazy a jistotou, doporučení, omezení); report ve špatném tvaru se nepřijme,
- doporučení jsou jen návrhy, do hry nic nezapisuje,
- má strop na počet kol,
- počítá tokeny a cenu každého běhu (u předplatného cenu, jakou by běh stál přes API),
- celý běh uloží do složky `runs/` (report, každé volání nástroje, tokeny, cena).

Spuštění:

```
npm run agent -- "Je v aréně silnější pět warriorů, nebo pět warlocků?"
npm run agent -- "..." --model opus --effort high --max-rounds 20
npm run agent -- "..." --engine api
```

Výchozí model je `sonnet`. Běhy se počítají do limitů předplatného; na konci běhu se vypíše, kolik z limitu je vyčerpáno.

Ukázkový report ze skutečného běhu: `examples/reports/warriors-vs-warlocks.md` (4 kola, 5 zápasů, 53 s).

### 6. Měření — první kolo hotovo

Sada otázek, u kterých správnou odpověď spočítá sám simulátor (bez modelu). Agent dostane každou otázku několikrát, pokaždé od nuly, a jeho odpověď se automaticky porovná.

```
npm run eval                        všechny otázky, 3 běhy na každou
npm run eval -- --truth-only        jen spočítat správné odpovědi, agenta nespouštět (zdarma)
npm run eval -- --only mirror --reps 1
```

Výsledek 14. 11. 2026 (model sonnet, 4 otázky × 3 běhy): **12 z 12 správně**, všechny běhy se shodly. Průměrně 2,9 kola, 16 s a 0,022 USD na běh v cenách API (nic se neplatilo). Souhrn je v `examples/evals/2026-11-14-sonnet.md`.

Záznamy ukázaly, že agent pokaždé simuloval přesně zadané týmy se správnou výbavou. Jednou mu report neprošel kontrolou tvaru a sám ho opravil.

Omezení: otázky jsou zatím snadné (rozdíl 100 : 0 nebo jasná chyba v buildu). Ověřují, že agent funguje, ale k porovnání modelů nebo nastavení jsou málo citlivé. K tomu chybí těžší otázky, například zápas, o kterém rozhoduje strana arény nebo časový limit.

### 7. Prezentace

README v angličtině, ukázkové výstupy, krátké video.

## Jak to spustit

Vždy ve složce tohoto projektu (`DDLLMAgent`):

```
npm run sim -- list warrior
npm run sim -- fight --a WARRIOR,WARRIOR,SHAMAN --b WARLOCK,WARLOCK,SHAMAN --gear EPIC:10 --level 15
npm run sim -- fight --file examples/berserker-vs-guardian.json --seed 7
npm test
```

MCP server se nespouští ručně. Spustí si ho Claude Code (nebo později náš agent).

## Soubory

| Soubor | K čemu je |
|---|---|
| `src/sim/game.ts` | Načte zkompilovaný kód hry ze složky Dungeon Defend. |
| `src/sim/data.ts` | Jednou přečte z databáze definice skillů, talentů a vzorovou postavu. Pak už jen z paměti. |
| `src/sim/team.ts` | Z popisu týmu vyrobí herní postavu s hrdiny. |
| `src/sim/gear.ts` | Výbava podle rarity a tieru, vyrobená herním generátorem. |
| `src/sim/talents.ts` | Naučí hrdinu talenty a hlídá pravidla talentového stromu. |
| `src/sim/fight.ts` | Jeden souboj: totéž, co dělá server pro arénu. |
| `src/sim/match.ts` | Série soubojů a souhrn výsledků. |
| `src/sim/random.ts` | Opakovatelná náhoda (`seed`). |
| `src/sim/catalog.ts` | Seznam skillů, talentů a pravidel pro stavbu týmu. |
| `src/cli.ts` | Příkazová řádka. |
| `src/mcp/server.ts` | MCP server: nabízí simulátor agentům jako nástroje. |
| `.mcp.json` | Říká Claude Code, jak MCP server spustit. |
| `src/agent/loop.ts` | Motor `api`: ručně psaná smyčka agenta nad Claude API. |
| `src/agent/claude-code.ts` | Motor `claude-code`: spustí Claude Code bez okna jen s naším zadáním a nástroji a z jeho výstupu sestaví záznam běhu. |
| `src/agent/types.ts` | Záznam jednoho běhu, společný oběma motorům. |
| `src/agent/prompt.ts` | Zadání pro model: kdo je, jaké má nástroje a jak má pracovat. |
| `src/agent/tools.ts` | Připojí se k MCP serveru a předá modelu jeho nástroje; přidá nástroj na odevzdání reportu. |
| `src/agent/report.ts` | Tvar reportu a jeho převod na čitelný text. |
| `src/agent/pricing.ts` | Přepočet tokenů na dolary. |
| `src/agent/cli.ts` | Příkazová řádka agenta: ukazuje průběh, vytiskne a uloží report. |
| `test/sim.test.ts` | Automatické testy simulátoru. |
| `test/mcp.test.ts` | Automatické testy MCP serveru (volá ho stejně jako agent). |
| `test/agent.test.ts` | Automatické testy smyčky agenta s modelem nahrazeným scénářem. |
| `test/claude-code.test.ts` | Automatické testy záznamu běhu z Claude Code (bez spouštění, bez čerpání limitu). |
| `src/eval/cases.ts` | Měření: otázky, výpočet správné odpovědi simulátorem a hodnocení odpovědi agenta. |
| `src/eval/run.ts` | Měření: pustí agenta na každou otázku několikrát a sepíše souhrn. |
| `test/eval.test.ts` | Automatické testy hodnocení (aby měření nehodnotilo špatně). |

## Co už to o hře ukázalo

Výsledky platí pro kód hry zkompilovaný 14. 11. 2026 ve 12:51. Po každé změně boje se mohou změnit; ten den se tak stalo.

- **Dva stejné týmy warriorů bez skillů a talentů:** zhruba 50 : 50 a strany arény jsou vyrovnané (3 × 400 soubojů). Ve starším sestavení téhož dne vyhrával vždy tým vlevo.
- **Pět warriorů (Fury) proti pěti warlockům (Destruction), se skilly a talenty:** do výbavy EPIC 30 vyhraje vždy tým vlevo, takže sílu týmů nejde určit. U LEGENDARY 50 vyhrávají warlockové 65 % soubojů a jako jediní i zprava. Zjistil to agent, celý report je v `examples/reports/warriors-vs-warlocks.md`.

## Otevřené otázky

1. Existuje maximální úroveň hrdiny? V kódu jsem strop nenašel. Úroveň teď znamená hlavně počet talentových bodů.
2. Generátor výbavy pro raritu `MYTHICAL` skončí chybou „Gear must have maximum stars to evolve!". Je to záměr (mythical jen vylepšením), nebo chyba ve hře?
3. Je výhoda útočníka (levé strany) v aréně záměr? U týmů se skilly a talenty pořád rozhoduje.
