// Talks to the MCP server the way an agent's host does: starts it as a separate process and
// calls its tools over the protocol. Needs the same access as the simulator (see .env.example).

import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "test", version: "0.0.0" });

before(async () => {
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/server.ts"], cwd: repoRoot }));
});
after(() => client.close());

/** Calls a tool and returns its text and whether it reported an error. */
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]!.text, isError: result.isError === true };
}

const warriors = { name: "Warriors", heroes: [{ class: "WARRIOR" }, { class: "WARRIOR" }] };
const warlocks = { name: "Warlocks", heroes: [{ class: "WARLOCK" }, { class: "WARLOCK" }] };

test("the server announces its tools with descriptions and input schemas", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["list_team_options", "simulate_match"]);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 100, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("list_team_options returns skills and talent rules for one class", async () => {
  const { text, isError } = await call("list_team_options", { heroClass: "WARRIOR" });
  assert.equal(isError, false);
  assert.match(text, /WARRIOR {2}\(core skill: PUNCH_1\)/);
  assert.match(text, /WR_PROT_INTIMIDATION .*needs 3 points in this tree; after WR_PROT_DEFIANCE/);
  assert.doesNotMatch(text, /SHAMAN {2}\(core skill/);
});

test("simulate_match returns a result an agent can read, and a seed replays it", async () => {
  const args = { teamA: warriors, teamB: warlocks, runs: 10, seed: 5 };
  const first = await call("simulate_match", args);
  const second = await call("simulate_match", args);
  assert.equal(first.isError, false);
  assert.equal(first.text, second.text);

  const result = JSON.parse(first.text);
  assert.equal(result.runs, 10);
  assert.equal(result.seed, 5);
  assert.equal(result.a.name, "Warriors");
  assert.equal(result.a.wins + result.b.wins + result.draws, 10);
  assert.ok(Array.isArray(result.notes));
  assert.equal(result.a.heroes.length, 2);
});

test("an illegal team comes back as an error that says what to fix", async () => {
  const illegal = { name: "Illegal", heroes: [{ class: "WARRIOR", talents: { WR_PROT_INTIMIDATION: 1 } }] };
  const { text, isError } = await call("simulate_match", { teamA: illegal, teamB: warlocks });
  assert.equal(isError, true);
  assert.match(text, /needs 3 points spent in the Protection tree/);
});

test("input that does not fit the schema is rejected before the simulator runs", async () => {
  const result = await client.callTool({ name: "simulate_match", arguments: { teamA: { name: "A", heroes: [{ class: "PALADIN" }] }, teamB: warlocks } }).catch((error) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
  assert.equal(result.isError, true);
});

// ---- the agent end to end, with only the model replaced by a script (no API key, no cost)

test("the agent reaches the simulator through MCP: a scripted model runs a real match and reports", async () => {
  const { connectSimulatorTools, SUBMIT_REPORT } = await import("../src/agent/tools.js");
  const { runAgent } = await import("../src/agent/loop.js");

  const tools = await connectSimulatorTools();
  try {
    assert.deepEqual(tools.definitions.map((tool) => tool.name).sort(), ["list_team_options", "simulate_match", SUBMIT_REPORT].sort());
    for (const tool of tools.definitions) assert.ok(tool.description, `${tool.name} is passed to the model with its description`);

    const report = { answer: "Warlocks.", findings: [], recommendations: [], limitations: [] };
    const script = [
      [{ type: "tool_use", id: "call_1", name: "simulate_match", input: { teamA: warriors, teamB: warlocks, runs: 10, seed: 5 } }],
      [{ type: "tool_use", id: "call_2", name: SUBMIT_REPORT, input: report }],
    ];
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, iterations: null };
    const scriptedModel = async () => ({ model: "claude-opus-5-5", content: script.shift(), stop_reason: "tool_use", usage }) as any;

    const run = await runAgent("Who wins?", scriptedModel, tools, { model: "claude-opus-5-5", effort: "medium", maxRounds: 4 });
    assert.equal(run.outcome, "report");
    const match = JSON.parse(run.toolCalls[0]!.result);
    assert.equal(match.a.name, "Warriors");
    assert.equal(match.a.wins + match.b.wins + match.draws, 10);
  } finally {
    await tools.close();
  }
});
