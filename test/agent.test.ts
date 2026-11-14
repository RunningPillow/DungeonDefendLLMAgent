// Tests of the agent loop. The model is replaced by a script and the tools by stand-ins, so these
// tests need no API key, no database, and cost nothing. They check what the loop does with the
// model's answers: which tools it runs, what it sends back, when it stops, and what it counts.

import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type ModelCall } from "../src/agent/loop.js";
import { costUsd } from "../src/agent/pricing.js";
import { LAST_ROUND_NOTICE, MISSING_REPORT_NOTICE } from "../src/agent/prompt.js";
import { submitReportTool, SUBMIT_REPORT, type ToolSet } from "../src/agent/tools.js";
import type { AgentOptions } from "../src/agent/types.js";

type Request = Anthropic.Beta.MessageCreateParamsNonStreaming;
const OPTIONS: AgentOptions = { model: "claude-opus-5-5", effort: "medium", maxRounds: 6 };

const REPORT = {
  answer: "Warlocks win.",
  findings: [{ claim: "Warlocks beat warriors", evidence: "40 fights, 0:40", confidence: "high" }],
  recommendations: [],
  limitations: ["Only core skills were tested."],
};

// ---- building blocks for scripted model answers
let nextId = 0;
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value, signature: "sig" });
const toolUse = (name: string, input: unknown) => ({ type: "tool_use", id: `call_${++nextId}`, name, input });

function answer(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: content.some((block: any) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50, iterations: null },
    ...extra,
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** A model that gives the scripted answers in order and remembers every request it received. */
function scriptedModel(answers: Anthropic.Beta.BetaMessage[]) {
  const requests: Request[] = [];
  const call: ModelCall = async (request) => {
    requests.push(structuredClone(request)); // the loop keeps adding to `messages`; keep what was sent at the time
    const next = answers.shift();
    if (!next) throw new Error("The script ran out of answers: the loop asked the model more often than expected.");
    return next;
  };
  return { call, requests };
}

/** Tools that record their calls. `simulate_match` answers with a fixed text; `broken` throws. */
function fakeTools() {
  const calls: { name: string; input: unknown }[] = [];
  const tools: ToolSet = {
    definitions: [{ name: "simulate_match", description: "runs a match", input_schema: { type: "object" } }, submitReportTool],
    async call(name, input) {
      calls.push({ name, input });
      if (name === "broken") throw new Error("the server went away");
      if (name === "rejects") return { text: "unknown skill", isError: true };
      return { text: `result of ${name}`, isError: false };
    },
    close: async () => {},
  };
  return { tools, calls };
}

/** The tool results the loop sent to the model in a request (the last message of that request). */
const resultsSentIn = (request: Request) => request.messages.at(-1)!.content as any[];

test("happy path: runs the requested tool, sends the result back, and stops at the report", async () => {
  const model = scriptedModel([answer([text("Let me measure."), toolUse("simulate_match", { runs: 40 })]), answer([toolUse(SUBMIT_REPORT, REPORT)])]);
  const { tools, calls } = fakeTools();
  const run = await runAgent("Who wins?", model.call, tools, OPTIONS);

  assert.equal(run.outcome, "report");
  assert.deepEqual(run.report, REPORT);
  assert.equal(run.rounds, 2);
  assert.deepEqual(calls, [{ name: "simulate_match", input: { runs: 40 } }], "submit_report is handled by the agent, not sent to the simulator");

  const [result] = resultsSentIn(model.requests[1]!);
  assert.equal(result.type, "tool_result");
  assert.equal(result.content, "result of simulate_match");
  assert.equal(result.is_error, false);
});

test("every request carries the instructions, the tools and the whole conversation so far", async () => {
  const first = answer([thinking("Compare the two."), toolUse("simulate_match", {})]);
  const model = scriptedModel([first, answer([toolUse(SUBMIT_REPORT, REPORT)])]);
  await runAgent("Who wins?", model.call, fakeTools().tools, OPTIONS);

  const [one, two] = model.requests as [Request, Request];
  assert.match((one.messages[0]!.content as string), /^Who wins\?/);
  assert.match((one.messages[0]!.content as string), /at most 6 rounds/);
  assert.equal(one.model, "claude-opus-5-5");
  assert.deepEqual(one.output_config, { effort: "medium" });
  assert.deepEqual(one.tools!.map((tool: any) => tool.name), ["simulate_match", SUBMIT_REPORT]);
  assert.deepEqual(one.fallbacks, "default");

  assert.equal(two.messages.length, 3, "question, the model's answer, the tool results");
  assert.deepEqual(two.messages[1], { role: "assistant", content: first.content }, "the model's answer goes back unchanged, reasoning included");
  assert.deepEqual(two.system, one.system, "the instructions never change, so the API can cache them");
});

test("several tool requests in one answer: all results go back in one message, in order", async () => {
  const requested = [toolUse("simulate_match", { n: 1 }), toolUse("simulate_match", { n: 2 }), toolUse("simulate_match", { n: 3 })];
  const model = scriptedModel([answer(requested), answer([toolUse(SUBMIT_REPORT, REPORT)])]);
  const { tools, calls } = fakeTools();
  const run = await runAgent("Who wins?", model.call, tools, OPTIONS);

  assert.equal(calls.length, 3);
  assert.equal(run.toolCalls.length, 4);
  assert.deepEqual(resultsSentIn(model.requests[1]!).map((result) => result.tool_use_id), requested.map((request) => request.id));
});

test("a report that does not fit the schema is sent back with the reason, and the model can correct it", async () => {
  const broken = { ...REPORT, findings: [{ claim: "x", evidence: "y", confidence: "certain" }] };
  const model = scriptedModel([answer([toolUse(SUBMIT_REPORT, broken)]), answer([toolUse(SUBMIT_REPORT, REPORT)])]);
  const run = await runAgent("Who wins?", model.call, fakeTools().tools, OPTIONS);

  const [rejection] = resultsSentIn(model.requests[1]!);
  assert.equal(rejection.is_error, true);
  assert.match(rejection.content, /confidence/);
  assert.equal(run.outcome, "report");
  assert.deepEqual(run.report, REPORT);
});

test("a tool error or a crashing tool is reported to the model; the agent keeps going", async () => {
  const model = scriptedModel([answer([toolUse("rejects", {}), toolUse("broken", {})]), answer([toolUse(SUBMIT_REPORT, REPORT)])]);
  const run = await runAgent("Who wins?", model.call, fakeTools().tools, OPTIONS);

  const [rejected, crashed] = resultsSentIn(model.requests[1]!);
  assert.deepEqual([rejected.is_error, rejected.content], [true, "unknown skill"]);
  assert.equal(crashed.is_error, true);
  assert.match(crashed.content, /Tool broken failed: the server went away/);
  assert.equal(run.outcome, "report");
});

test("a model that stops without a report is reminded once, then the run ends without one", async () => {
  const model = scriptedModel([answer([text("I think warlocks win.")]), answer([text("As I said, warlocks.")])]);
  const run = await runAgent("Who wins?", model.call, fakeTools().tools, OPTIONS);

  assert.equal(model.requests[1]!.messages.at(-1)!.content, MISSING_REPORT_NOTICE);
  assert.equal(run.outcome, "no_report");
  assert.equal(run.report, null);
  assert.equal(run.lastText, "As I said, warlocks.");
});

test("the round limit: the model is told before its last round, and the run stops at the limit", async () => {
  const keepSimulating = () => answer([toolUse("simulate_match", {})]);
  const model = scriptedModel([keepSimulating(), keepSimulating(), keepSimulating()]);
  const run = await runAgent("Who wins?", model.call, fakeTools().tools, { ...OPTIONS, maxRounds: 3 });

  assert.equal(run.outcome, "max_rounds");
  assert.equal(run.rounds, 3);
  assert.equal(model.requests.length, 3, "never more requests than the limit");
  assert.ok(!resultsSentIn(model.requests[1]!).some((block) => block.type === "text"), "no notice after round 1");
  assert.deepEqual(resultsSentIn(model.requests[2]!).at(-1), { type: "text", text: LAST_ROUND_NOTICE });
});

test("a refusal or a cut-off answer ends the run and no tools are executed", async () => {
  for (const [stopReason, outcome] of [["refusal", "refusal"], ["max_tokens", "max_tokens"]] as const) {
    const model = scriptedModel([answer([toolUse("simulate_match", {})], { stop_reason: stopReason })]);
    const { tools, calls } = fakeTools();
    const run = await runAgent("Who wins?", model.call, tools, OPTIONS);
    assert.equal(run.outcome, outcome);
    assert.equal(calls.length, 0);
  }
});

test("tokens and cost are added up over all rounds", async () => {
  const usage = (input: number, written: number, read: number, output: number) => ({ usage: { input_tokens: input, cache_creation_input_tokens: written, cache_read_input_tokens: read, output_tokens: output, iterations: null } });
  const model = scriptedModel([answer([toolUse("simulate_match", {})], usage(1000, 2000, 0, 500)), answer([toolUse(SUBMIT_REPORT, REPORT)], usage(200, 300, 3000, 400))]);
  const run = await runAgent("Who wins?", model.call, fakeTools().tools, OPTIONS);

  assert.deepEqual(run.usage, { inputTokens: 1200, cacheWriteTokens: 2300, cacheReadTokens: 3000, outputTokens: 900 });
  // claude-opus-5-5: $4 input, $5 cache write (1.25x), $0.20 cache read, $20 output, per million tokens
  const expected = (1200 * 4 + 2300 * 5 + 3000 * 0.2 + 900 * 20) / 1_000_000;
  assert.ok(Math.abs(run.costUsd! - expected) < 1e-12);
  assert.deepEqual(run.servedBy, ["claude-opus-5-5"]);
});

test("after a fallback, each model's tokens are billed at that model's price", async () => {
  const iterations = [
    { type: "message", model: "claude-opus-5-5", input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cache_creation: null },
    { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100, cache_creation: null },
  ];
  const fellBack = answer([toolUse(SUBMIT_REPORT, REPORT)], { model: "claude-opus-4-8", usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100, iterations } });
  const run = await runAgent("Who wins?", scriptedModel([fellBack]).call, fakeTools().tools, OPTIONS);

  assert.deepEqual(run.servedBy, ["claude-opus-5-5", "claude-opus-4-8"]);
  assert.ok(Math.abs(run.costUsd! - (costUsd("claude-opus-5-5", { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })! + costUsd("claude-opus-4-8", { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 })!)) < 1e-12);
});

test("a model without a known price gives an unknown cost, not a wrong one", async () => {
  const run = await runAgent("Who wins?", scriptedModel([answer([toolUse(SUBMIT_REPORT, REPORT)], { model: "some-future-model" })]).call, fakeTools().tools, { ...OPTIONS, model: "some-future-model" });
  assert.equal(run.costUsd, null);
});

test("fallback is requested only for models that support it", async () => {
  const model = scriptedModel([answer([toolUse(SUBMIT_REPORT, REPORT)], { model: "claude-haiku-5-5" })]);
  await runAgent("Who wins?", model.call, fakeTools().tools, { ...OPTIONS, model: "claude-haiku-5-5" });
  assert.equal(model.requests[0]!.fallbacks, undefined);
  assert.equal(model.requests[0]!.betas, undefined);
});

test("submit_report is a strict tool: the API guarantees its shape before our own check runs", () => {
  assert.equal(submitReportTool.strict, true);
  const schema = submitReportTool.input_schema as any;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["answer", "findings", "recommendations", "limitations"]);
  assert.equal(schema.$schema, undefined);
});
