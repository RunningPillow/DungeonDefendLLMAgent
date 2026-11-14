// Tests of the Claude Code engine's record keeping. They feed the collector the kinds of events
// Claude Code emits (shapes copied from a real run, values made up), so they start no process
// and use no subscription quota.

import assert from "node:assert/strict";
import { test } from "node:test";
import { findClaudeCode, RunCollector } from "../src/agent/claude-code.js";
import { systemPrompt } from "../src/agent/prompt.js";
import type { AgentEvent, AgentOptions } from "../src/agent/types.js";

const OPTIONS: AgentOptions = { model: "sonnet", effort: "medium", maxRounds: 5 };

const REPORT = {
  answer: "Warlocks win.",
  findings: [{ claim: "Warlocks beat warriors", evidence: "40 fights, 10:30", confidence: "medium" }],
  recommendations: [],
  limitations: ["Only core skills were tested."],
};

// ---- events in the shapes Claude Code emits with --output-format stream-json
const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 60 };
const modelMessage = (id: string, ...content: unknown[]) => ({ type: "assistant", message: { id, model: "claude-sonnet-5-5", content, usage } });
const toolRequest = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, text: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] } });
const rateLimit = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.32 }, seven_day: { utilization: 0.15 } } } };
const finalResult = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.0145,
  structured_output: REPORT,
  result: JSON.stringify(REPORT),
  modelUsage: {
    "claude-sonnet-5-5": { inputTokens: 4, outputTokens: 900, cacheReadInputTokens: 9000, cacheCreationInputTokens: 1000 },
    "claude-haiku-5-5": { inputTokens: 1200, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  },
  ...extra,
});

const A_SUCCESSFUL_RUN = [
  { type: "system", subtype: "init", tools: ["StructuredOutput", "mcp__dungeon-defend-sim__simulate_match"] },
  modelMessage("msg_1", toolRequest("call_1", "mcp__dungeon-defend-sim__simulate_match", { runs: 40 })),
  rateLimit,
  toolResult("call_1", '{"a":{"wins":10},"b":{"wins":30}}'),
  modelMessage("msg_2", { type: "thinking", thinking: "" }),
  modelMessage("msg_2", toolRequest("call_2", "StructuredOutput", REPORT)),
  toolResult("call_2", "Structured output provided successfully"),
  finalResult(),
];

function collect(events: unknown[], options: AgentOptions = OPTIONS, failure = "") {
  const seen: AgentEvent[] = [];
  const collector = new RunCollector("Who wins?", { ...options, onEvent: (event) => seen.push(event) });
  for (const event of events) collector.add(event);
  return { run: collector.finish(failure), seen, collector };
}

test("a successful run becomes the same kind of record as with the API engine", () => {
  const { run } = collect(A_SUCCESSFUL_RUN);

  assert.equal(run.engine, "claude-code");
  assert.equal(run.outcome, "report");
  assert.deepEqual(run.report, REPORT);
  assert.equal(run.rounds, 2, "two answers from the model, although the second arrived as two events");
  assert.deepEqual(run.toolCalls.map((call) => [call.round, call.name, call.isError]), [[1, "simulate_match", false], [2, "submit_report", false]], "tool names lose the MCP prefix; the answer tool is called submit_report as in the other engine");
  assert.deepEqual(run.toolCalls[0]!.input, { runs: 40 });
  assert.equal(run.toolCalls[0]!.result, '{"a":{"wins":10},"b":{"wins":30}}');
});

test("tokens are added up over every model that worked on the run; the cost is Claude Code's own figure", () => {
  const { run } = collect(A_SUCCESSFUL_RUN);
  assert.deepEqual(run.usage, { inputTokens: 1204, cacheWriteTokens: 1000, cacheReadTokens: 9000, outputTokens: 1100 });
  assert.deepEqual(run.servedBy, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.equal(run.costUsd, 0.0145);
  assert.deepEqual(run.subscriptionUsage, { fiveHour: 0.32, sevenDay: 0.15 });
});

test("progress is reported as it happens: round, tool call, tool result", () => {
  const { seen } = collect(A_SUCCESSFUL_RUN);
  assert.deepEqual(seen.map((event) => event.type), ["round", "tool_call", "tool_result", "round", "tool_call", "tool_result"]);
  assert.deepEqual(seen[1], { type: "tool_call", name: "simulate_match", input: { runs: 40 } });
});

test("a tool error is recorded as an error", () => {
  const { run } = collect([modelMessage("msg_1", toolRequest("call_1", "mcp__dungeon-defend-sim__simulate_match", {})), toolResult("call_1", "unknown skill", true), finalResult()]);
  assert.deepEqual([run.toolCalls[0]!.isError, run.toolCalls[0]!.result], [true, "unknown skill"]);
});

test("a final answer that does not fit the report schema is not accepted as a report", () => {
  const { run } = collect([finalResult({ structured_output: { answer: "Warlocks." }, result: "Warlocks." })]);
  assert.equal(run.outcome, "no_report");
  assert.equal(run.report, null);
  assert.equal(run.lastText, "Warlocks.");
});

test("the round limit is enforced here, because Claude Code has none of its own", () => {
  const events = [1, 2, 3].map((n) => modelMessage(`msg_${n}`, toolRequest(`call_${n}`, "mcp__dungeon-defend-sim__simulate_match", {})));
  const collector = new RunCollector("Who wins?", { ...OPTIONS, maxRounds: 2 });
  collector.add(events[0]);
  collector.add(events[1]);
  assert.equal(collector.overRoundLimit, false, "two rounds are allowed");
  collector.add(events[2]);
  assert.equal(collector.overRoundLimit, true, "the third is over the limit: the caller stops the process");

  const run = collector.finish("");
  assert.equal(run.outcome, "max_rounds");
  assert.equal(run.rounds, 2);
});

test("a failed process or an error result ends as an error with the reason", () => {
  assert.deepEqual([collect([], OPTIONS, "not logged in").run.outcome, collect([], OPTIONS, "not logged in").run.lastText], ["error", "not logged in"]);
  const { run } = collect([finalResult({ is_error: true, subtype: "error_during_execution", result: "usage limit reached", structured_output: undefined })]);
  assert.deepEqual([run.outcome, run.lastText], ["error", "usage limit reached"]);
});

test("both engines get the same instructions, apart from how to hand in the report", () => {
  const api = systemPrompt("api");
  const claudeCode = systemPrompt("claude-code");
  assert.match(api, /submit_report: your final answer/);
  assert.doesNotMatch(claudeCode, /submit_report/);
  assert.equal(api.replace(/^- submit_report.*$/m, ""), claudeCode.replace(/^Your final answer is the report.*$/m, ""));
});

test("CLAUDE_CODE_PATH overrides where the Claude Code program is looked for", () => {
  const before = process.env.CLAUDE_CODE_PATH;
  process.env.CLAUDE_CODE_PATH = "/custom/claude";
  try {
    assert.equal(findClaudeCode(), "/custom/claude");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = before;
  }
});
