// Command line for the agent.
//
//   npm run agent -- "Which is stronger in the arena: five warriors or five warlocks?"
//
// Options: --engine claude-code|api   --model <name>   --effort low|medium|high|xhigh|max   --max-rounds 15
//
//   --engine claude-code (default): Claude Code runs the loop, on the Claude subscription. Not billed per run.
//   --engine api: the loop in loop.ts runs on the Claude API. Needs ANTHROPIC_API_KEY; billed per token.
//
// Shows what the agent does as it works, prints the report, and saves the whole run (report,
// every tool call, token counts, cost) to the runs/ folder.

import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { repoRoot } from "../env.js";
import { runWithClaudeCode } from "./claude-code.js";
import { runAgent } from "./loop.js";
import { reportAsMarkdown } from "./report.js";
import { connectSimulatorTools, SUBMIT_REPORT } from "./tools.js";
import type { AgentEvent, AgentOptions, AgentRun, Effort, Engine } from "./types.js";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ENGINES: Engine[] = ["claude-code", "api"];
/** Each engine's default model. Claude Code takes short names and picks the current version. */
const DEFAULT_MODEL: Record<Engine, string> = { "claude-code": "sonnet", api: "claude-opus-5-5" };

const print = (line = "") => process.stdout.write(line + "\n");
const count = (value: number) => value.toLocaleString("en-US");

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { engine: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, "max-rounds": { type: "string" } },
  });
  const question = positionals.join(" ").trim();
  if (!question) {
    print('Usage: npm run agent -- "your question about arena balance" [--engine claude-code|api] [--model <name>] [--effort medium] [--max-rounds 15]');
    return;
  }
  const engine = (values.engine ?? "claude-code") as Engine;
  if (!ENGINES.includes(engine)) throw new Error(`--engine must be one of: ${ENGINES.join(", ")}.`);
  const effort = (values.effort ?? "medium") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}.`);
  const maxRounds = values["max-rounds"] ? Number(values["max-rounds"]) : 15;
  if (!Number.isInteger(maxRounds) || maxRounds < 2) throw new Error("--max-rounds must be a whole number of at least 2.");
  const options: AgentOptions = { model: values.model ?? DEFAULT_MODEL[engine], effort, maxRounds, onEvent: showProgress };

  print(`Question: ${question}`);
  print(`Engine: ${engine}, model ${options.model}, effort ${effort}, at most ${maxRounds} rounds\n`);

  const run = engine === "api" ? await runOnApi(question, options) : await runWithClaudeCode(question, options);

  print("\n" + "=".repeat(72));
  if (run.report) print(reportAsMarkdown(run.question, run.report));
  else print(`The run ended without a report (${run.outcome}).${run.lastText ? `\n\n${run.lastText}` : ""}\n`);
  print("=".repeat(72));

  const matches = run.toolCalls.filter((call) => call.name === "simulate_match" && !call.isError).length;
  print(`rounds: ${run.rounds}   tool calls: ${run.toolCalls.length} (${matches} matches)   time: ${run.seconds.toFixed(0)} s   model: ${run.servedBy.join(", ") || run.model}`);
  print(`tokens: ${count(run.usage.inputTokens)} input + ${count(run.usage.cacheWriteTokens)} written to cache + ${count(run.usage.cacheReadTokens)} read from cache + ${count(run.usage.outputTokens)} output`);
  const cost = run.costUsd === null ? "unknown" : `$${run.costUsd.toFixed(4)}`;
  if (engine === "api") print(`estimated cost: ${cost}`);
  else print(`cost: nothing charged (Claude subscription). The same run on the API would cost about ${cost}.`);
  if (run.subscriptionUsage) {
    const percent = (share: number | undefined) => (share === undefined ? "?" : `${Math.round(share * 100)} %`);
    print(`subscription usage so far: ${percent(run.subscriptionUsage.fiveHour)} of the 5-hour limit, ${percent(run.subscriptionUsage.sevenDay)} of the weekly limit`);
  }
  print(`saved to: ${save(run)}`);
}

/** The "api" engine: our own loop, the Claude API, and the simulator's tools over MCP. */
async function runOnApi(question: string, options: AgentOptions): Promise<AgentRun> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from .env or the environment
  const tools = await connectSimulatorTools();
  try {
    return await runAgent(question, (request) => client.beta.messages.create(request), tools, options);
  } finally {
    await tools.close();
  }
}

function showProgress(event: AgentEvent) {
  if (event.type === "round") {
    print(`round ${event.round}   (${count(event.usage.inputTokens + event.usage.cacheWriteTokens)} new + ${count(event.usage.cacheReadTokens)} cached input tokens, ${count(event.usage.outputTokens)} output)`);
  } else if (event.type === "tool_call") {
    print(`  -> ${event.name}  ${describeInput(event.name, event.input)}`);
  } else {
    print(`  <- ${event.isError ? "ERROR: " : ""}${describeResult(event.name, event.result, event.isError)}  (${(event.ms / 1000).toFixed(1)} s)`);
  }
}

function describeInput(name: string, input: any): string {
  if (name === "simulate_match") return `${input?.teamA?.name} vs ${input?.teamB?.name}, ${input?.runs ?? 40} fights`;
  if (name === SUBMIT_REPORT) return "";
  return JSON.stringify(input);
}

function describeResult(name: string, result: string, isError: boolean): string {
  if (name === "simulate_match" && !isError) {
    const match = JSON.parse(result);
    return `${match.a.name} ${match.a.wins} : ${match.b.wins} ${match.b.name}${match.notes.length ? `   [${match.notes.length} note${match.notes.length === 1 ? "" : "s"}]` : ""}`;
  }
  const oneLine = result.replace(/\s+/g, " ");
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}... (${count(result.length)} characters)` : oneLine;
}

/** Writes the report and the full record of the run; returns the folder. */
function save(run: AgentRun): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const withoutAccents = run.question.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const slug = withoutAccents.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const folder = path.join(repoRoot, "runs", `${stamp}-${slug}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "run.json"), JSON.stringify(run, null, 2));
  if (run.report) writeFileSync(path.join(folder, "report.md"), reportAsMarkdown(run.question, run.report));
  return path.relative(repoRoot, folder);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const keyHelp = "Create a key at https://platform.claude.com/settings/keys and put it in .env as ANTHROPIC_API_KEY=... (or use --engine claude-code, which needs no key).";
    if (error instanceof Anthropic.AuthenticationError) process.stderr.write(`The Claude API rejected the key. ${keyHelp}\n`);
    else if (error instanceof Anthropic.APIError) process.stderr.write(`Claude API error ${error.status}: ${error.message}\n`);
    else process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
