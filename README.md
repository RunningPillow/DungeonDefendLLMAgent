# DungeonDefendLLMAgent

Balance tooling for the mobile game Dungeon Defend, built around a PvP simulator that runs the game's real server-side combat code. The goal is an LLM agent that finds overpowered team compositions before players do, explains why they win, and verifies a proposed fix by simulation.

**Status:** work in progress. The simulator, the MCP server and the agent work, and a first evaluation passed 12 of 12 runs. See [PLAN.md](PLAN.md) (in Czech) for the roadmap, [examples/reports/warriors-vs-warlocks.md](examples/reports/warriors-vs-warlocks.md) for a report from a real run (in Czech, the language of the question), and [examples/evals/2026-11-14-sonnet.md](examples/evals/2026-11-14-sonnet.md) for the evaluation.

## How it works

The game's backend is a Firebase Functions project in TypeScript. An arena fight is an autobattle computed by one server function. The simulator loads the game's compiled code, builds two teams in memory and calls that same function, so there is no second implementation of combat that could drift from the game.

Game definitions (skills, talent trees) are read from the staging database once, in a read-only transaction. After that everything runs in memory: fights never touch the database and any write attempt throws.

## Usage

Requires Node 22+, a local checkout of the game with compiled functions, and Firebase credentials with read access. Copy `.env.example` to `.env` and fill it in.

```
npm install

# what can go into a team: skills, talents and their rules
npm run sim -- list warrior

# quick match: heroes with their core skill only
npm run sim -- fight --a WARRIOR,WARRIOR,SHAMAN --b WARLOCK,WARLOCK,SHAMAN --gear EPIC:10 --level 15

# full teams with gear, skills and talents
npm run sim -- fight --file examples/berserker-vs-guardian.json --seed 7

npm test
```

A hero is described by the four things that make it strong in the game:

| | How it is given | Enforced |
|---|---|---|
| Class | `WARRIOR`, `SHAMAN`, `WARLOCK` | |
| Gear | rarity and tier, applied to all eight items | items come from the game's own generator |
| Skills | up to 3 skills, plus an upgrade tier 0-5 for the team | class restrictions, per-skill tier limits |
| Talents | talent id and rank | point budget, points required in the tree, connections between talents, one capstone |

A talent build the game would not let a player learn is rejected with the reason, so results never come from impossible heroes.

A match is a series of fights. Each team spends half of them on each side of the arena, because the side matters. The same `--seed` reproduces the same match exactly. Add `--json` for machine-readable output.

## MCP server

`src/mcp/server.ts` exposes the simulator to LLM agents over the Model Context Protocol (stdio). There is no LLM inside the server.

| Tool | Purpose |
|---|---|
| `list_team_options` | Skills, talent trees and the rules for building a team, read from current game data. |
| `simulate_match` | Runs a match between two teams and returns win rates, how the wins came about, and per-hero damage and survival. |

Design choices that matter for agents:

- **Results explain themselves.** Each result carries `notes` that flag misleading numbers, for example a 50 % win rate that only reflects which side of the arena a team stood on.
- **Errors are actionable.** An illegal team is rejected with the rule it breaks and the valid options, so the agent can correct itself.
- **Data is never stale.** Before each call the server asks the database whether the definitions changed and re-reads only what did. If the game was recompiled since the server started, the result says so.
- **Deterministic.** Matches run one at a time with seeded dice, so the same seed gives the same result even when an agent issues calls in parallel.
- **Read-only.** The server cannot write to the game's database.

`.mcp.json` registers the server for Claude Code in this project.

## Agent

`src/agent/` is a specialised agent that answers balance questions by running simulations:

```
npm run agent -- "Which is stronger in the arena: five warriors or five warlocks?"
```

It has one set of instructions, one set of tools and one report format, and two interchangeable engines that run the loop:

| Engine | What runs the loop | Billing | Status |
|---|---|---|---|
| `claude-code` (default) | Claude Code in headless mode, with its own system prompt and tools replaced by ours | Claude subscription, nothing per run | used for all real runs so far |
| `api` | `src/agent/loop.ts`, a loop written by hand on the Claude API | API key, per token | tested with a scripted model; not yet run against the live API |

The hand-written loop exists so every step is visible: send the conversation and the tool list to the model, run the tools it asks for, append the results, repeat. Both engines produce the same run record, so reports and measurements do not depend on which one ran.

- **Tools come from the MCP server.** The agent has no knowledge of the simulator of its own; it passes the server's tool descriptions to the model unchanged.
- **Locked down.** With the Claude Code engine the model gets no file, shell or web tools, no personal settings or memory, and anything outside the two simulator tools is refused without asking.
- **The answer has a schema.** A direct answer, findings with evidence and confidence, recommendations, limitations. An answer that fails validation is not accepted as a report.
- **Recommendations only.** The agent cannot change the game; a human decides.
- **Bounded.** A round limit that is announced to the model and enforced by the program. Tool failures become error results the model can react to.
- **Measured.** Every run records tokens (including prompt-cache reads and writes), cost at API list prices, time and each tool call, and is saved to `runs/`.

Both engines are covered by tests that need no model: the API loop runs against a scripted model, and the Claude Code engine's record keeping against recorded event shapes.

## Evaluation

`src/eval/` measures how often the agent is right and whether repeated runs agree:

```
npm run eval                   # every case, 3 runs each
npm run eval -- --truth-only   # compute the expected answers only (no model, free)
```

- **Ground truth from the simulator, not from a model.** Each case names two exact teams. Before the agent runs, the simulator plays 400 fights and derives the expected label (team A, team B, undecided, or invalid team). Expected answers therefore stay correct when the game is rebalanced, and no model is ever graded against another model's output.
- **Automatic grading.** The agent's answer must start with one of four labels; the grader itself has tests.
- **Coverage in both directions.** Besides clear wins, a mirror match checks that the agent does not invent a winner, and an illegal build checks that it refuses instead of simulating something else.
- **Failures kept apart.** A run that ends before answering (process error, usage limit, round limit) is reported separately and never counted as a wrong answer. Every run is saved in full so a surprising score can be traced.

First result (2026-11-14, `sonnet`, 4 cases × 3 runs): **12 of 12 correct**, all runs agreeing, 2.9 rounds, 16 s and $0.022 per run at API list prices. The records show the agent simulated exactly the specified teams every time, and once corrected a report that failed schema validation. The cases are easy so far, so this shows the agent works rather than separating models; harder cases (matches decided by arena side or the time limit) are the next step.

The game itself is not part of this repository, so the simulator, the server and their tests cannot run without access to it.
