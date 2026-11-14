// The second engine: Claude Code as the agent loop.
//
// Claude Code is itself an agent: a program that runs the loop from loop.ts around a Claude model.
// It can run without a window, as a command. Here it is started with everything of its own
// switched off and only our parts switched on:
//
//   our instructions          instead of its own (a coding assistant's)
//   our two simulator tools   instead of its own (files, terminal, web)
//   our report structure      as the required shape of the final answer
//
// What comes out is the same specialised agent as with the "api" engine. The difference is who
// runs the loop and who pays: this engine uses the Claude subscription, so a run is not billed.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { addUsage, NO_USAGE, type TokenUsage } from "./pricing.js";
import { systemPrompt } from "./prompt.js";
import { reportSchema } from "./report.js";
import { simulatorServer, SUBMIT_REPORT } from "./tools.js";
import type { AgentEvent, AgentOptions, AgentRun } from "./types.js";

const MCP_SERVER_NAME = "dungeon-defend-sim";
/** Claude Code names an MCP tool "mcp__<server>__<tool>". */
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const SIMULATOR_TOOLS = ["list_team_options", "simulate_match"];
/** Claude Code's built-in tool for handing in an answer that must match a schema. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const RUN_TIMEOUT_MS = 20 * 60_000;

export async function runWithClaudeCode(question: string, options: AgentOptions): Promise<AgentRun> {
  const { $schema: _unused, ...schema } = z.toJSONSchema(reportSchema) as Record<string, unknown>;

  const args = [
    "--print", `${question}\n\n(You have at most ${options.maxRounds} rounds.)`,
    "--output-format", "stream-json", "--verbose", // one JSON line per event, as it happens
    "--model", options.model,
    "--effort", options.effort,
    "--system-prompt", systemPrompt("claude-code"),
    "--json-schema", JSON.stringify(schema),
    // tools: none of Claude Code's own, only the simulator's MCP server
    "--tools", "",
    "--mcp-config", JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: simulatorServer } }),
    "--strict-mcp-config",
    "--allowedTools", ...SIMULATOR_TOOLS.map((tool) => TOOL_PREFIX + tool),
    "--permission-prompts", "none", // anything not allowed above is refused, never asked about
    // isolation: no personal settings, memory, skills or saved session
    "--restricted",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];

  // The child must use the subscription login. An API key in the environment would switch it to
  // per-token billing, and the two CLAUDE* variables mark "already inside Claude Code".
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];

  const collector = new RunCollector(question, options);
  const child = spawn(findClaudeCode(), args, { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timeout = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);

  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    collector.add(JSON.parse(line));
    if (collector.overRoundLimit) child.kill(); // Claude Code has no round limit of its own
  }
  const exitCode: number | null = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timeout);

  return collector.finish(exitCode === 0 ? "" : stderr.trim() || `Claude Code exited with code ${exitCode}.`);
}

/** Turns Claude Code's stream of events into the run record. Kept apart from the process handling so it can be tested. */
export class RunCollector {
  private readonly started = Date.now();
  private readonly run: AgentRun;
  private readonly seenMessages = new Set<string>();
  private readonly pendingCalls = new Map<string, { name: string; input: unknown; round: number; startedAt: number }>();
  private result: any;

  constructor(
    question: string,
    private readonly options: AgentOptions,
  ) {
    this.run = {
      engine: "claude-code",
      question,
      model: options.model,
      effort: options.effort,
      outcome: "error",
      report: null,
      lastText: "",
      rounds: 0,
      toolCalls: [],
      usage: NO_USAGE,
      costUsd: null,
      servedBy: [],
      seconds: 0,
    };
  }

  get overRoundLimit(): boolean {
    return this.run.rounds > this.options.maxRounds;
  }

  add(event: any): void {
    if (event.type === "assistant") this.addModelMessage(event.message);
    else if (event.type === "user") this.addToolResults(event.message);
    else if (event.type === "rate_limit_event") this.addSubscriptionUsage(event.rate_limit_info);
    else if (event.type === "result") this.result = event;
  }

  /** One answer from the model. Claude Code sends each part (reasoning, text, tool request) as its own event with the same message id. */
  private addModelMessage(message: any): void {
    if (!this.seenMessages.has(message.id)) {
      this.seenMessages.add(message.id);
      this.run.rounds++;
      this.emit({ type: "round", round: this.run.rounds, usage: tokensOf(message.usage), servedBy: message.model });
    }
    for (const block of message.content ?? []) {
      if (block.type === "text") this.run.lastText = block.text;
      if (block.type !== "tool_use") continue;
      const name = toolName(block.name);
      this.pendingCalls.set(block.id, { name, input: block.input, round: this.run.rounds, startedAt: Date.now() });
      this.emit({ type: "tool_call", name, input: block.input });
    }
  }

  private addToolResults(message: any): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const call = this.pendingCalls.get(block.tool_use_id);
      if (!call) continue;
      this.pendingCalls.delete(block.tool_use_id);

      const result = typeof block.content === "string" ? block.content : (block.content ?? []).map((part: any) => part.text ?? "").join("\n");
      const record = { round: call.round, name: call.name, input: call.input, result, isError: block.is_error === true, ms: Date.now() - call.startedAt };
      this.run.toolCalls.push(record);
      this.emit({ type: "tool_result", name: record.name, result, isError: record.isError, ms: record.ms });
    }
  }

  private addSubscriptionUsage(info: any): void {
    const windows = info?.unifiedWindows ?? {};
    this.run.subscriptionUsage = { fiveHour: windows.five_hour?.utilization, sevenDay: windows.seven_day?.utilization };
  }

  /** Closes the record. `failure` is what went wrong with the process itself, if anything. */
  finish(failure: string): AgentRun {
    const run = this.run;
    run.seconds = (Date.now() - this.started) / 1000;

    if (this.result) {
      // modelUsage lists every model that worked on the run, including a small helper model Claude Code uses internally
      const perModel: [string, any][] = Object.entries(this.result.modelUsage ?? {});
      run.servedBy = perModel.map(([model]) => model);
      run.usage = perModel
        .map(([, usage]) => ({ inputTokens: usage.inputTokens ?? 0, cacheWriteTokens: usage.cacheCreationInputTokens ?? 0, cacheReadTokens: usage.cacheReadInputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }))
        .reduce(addUsage, NO_USAGE);
      run.costUsd = typeof this.result.total_cost_usd === "number" ? this.result.total_cost_usd : null;
    }

    if (this.overRoundLimit) {
      run.outcome = "max_rounds";
      run.rounds = this.options.maxRounds;
    } else if (!this.result || this.result.is_error) {
      run.outcome = "error";
      run.lastText = failure || String(this.result?.result ?? this.result?.subtype ?? "Claude Code ended without a result.");
    } else {
      const parsed = reportSchema.safeParse(this.result.structured_output);
      run.report = parsed.success ? parsed.data : null;
      run.outcome = parsed.success ? "report" : "no_report";
      if (!parsed.success) run.lastText = String(this.result.result ?? run.lastText);
    }
    return run;
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }
}

/** "mcp__dungeon-defend-sim__simulate_match" -> "simulate_match"; the answer tool gets the same name as in the other engine. */
function toolName(name: string): string {
  if (name === STRUCTURED_OUTPUT_TOOL) return SUBMIT_REPORT;
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function tokensOf(usage: any): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

/**
 * Where the Claude Code program is. It ships inside the editor extension, so look there first;
 * otherwise expect a `claude` command. CLAUDE_CODE_PATH overrides both.
 */
export function findClaudeCode(): string {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;

  for (const editor of [".cursor", ".vscode", ".vscode-insiders", ".windsurf"]) {
    const extensions = path.join(os.homedir(), editor, "extensions");
    if (!existsSync(extensions)) continue;
    const newestFirst = readdirSync(extensions)
      .filter((name) => name.startsWith("anthropic.claude-code-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of newestFirst) {
      const binary = path.join(extensions, name, "resources/native-binary/claude");
      if (existsSync(binary)) return binary;
    }
  }
  return "claude";
}
