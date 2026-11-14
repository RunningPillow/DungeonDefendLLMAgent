// The agent loop. This file is the agent; everything else is preparation.
//
// A language model cannot do anything by itself: it reads text and writes text. An agent is the
// program around it that repeats four steps:
//
//   1. send the conversation so far to the model, together with the list of tools
//   2. the model answers with text and/or requests to call tools
//   3. the program runs those tools and adds the results to the conversation
//   4. repeat, until the model hands in its report (or a limit is reached)
//
// The model decides what to do next; the program decides what the model is allowed to do, counts
// what it costs, and stops it. The Anthropic SDK has a helper that runs this loop for you (the
// tool runner). It is written out by hand here so that every step is visible.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { addUsage, costUsd, NO_USAGE, type TokenUsage } from "./pricing.js";
import { LAST_ROUND_NOTICE, MISSING_REPORT_NOTICE, systemPrompt } from "./prompt.js";
import { reportSchema } from "./report.js";
import { SUBMIT_REPORT, type ToolSet } from "./tools.js";
import type { AgentOptions, AgentRun, Outcome } from "./types.js";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type Request = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** One request to the model. The real one calls the Claude API; tests pass a scripted stand-in. */
export type ModelCall = (request: Request) => Promise<Message>;

/**
 * Models for which the API can retry a request on another model when a safety classifier declines
 * it. Rare for game balance, but without it a declined request simply ends the run.
 */
const MODELS_WITH_FALLBACK = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export async function runAgent(question: string, callModel: ModelCall, tools: ToolSet, options: AgentOptions): Promise<AgentRun> {
  const started = Date.now();
  const run: AgentRun = {
    engine: "api",
    question,
    model: options.model,
    effort: options.effort,
    outcome: "max_rounds",
    report: null,
    lastText: "",
    rounds: 0,
    toolCalls: [],
    usage: NO_USAGE,
    costUsd: 0,
    servedBy: [],
    seconds: 0,
  };
  const finish = (outcome: Outcome): AgentRun => ({ ...run, outcome, seconds: (Date.now() - started) / 1000 });

  // The conversation. It only ever grows: the API is stateless, so every request carries all of it.
  const messages: MessageParam[] = [{ role: "user", content: `${question}\n\n(You have at most ${options.maxRounds} rounds.)` }];
  let remindedAboutReport = false;

  for (let round = 1; round <= options.maxRounds; round++) {
    // ---- 1. ask the model
    const response = await callModel({
      model: options.model,
      max_tokens: 16000,
      system: [{ type: "text", text: systemPrompt("api"), cache_control: { type: "ephemeral" } }],
      tools: tools.definitions,
      messages,
      output_config: { effort: options.effort },
      // Each request repeats the whole conversation. Caching lets the API reuse the part it has
      // already seen, at a fraction of the price.
      cache_control: { type: "ephemeral" },
      ...(MODELS_WITH_FALLBACK.has(options.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    run.rounds = round;
    account(run, response);
    options.onEvent?.({ type: "round", round, usage: usageOf(response).total, servedBy: response.model });

    // ---- 2. keep the model's answer, complete and unchanged (it includes its reasoning and tool requests)
    messages.push({ role: "assistant", content: response.content });
    run.lastText = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") || run.lastText;

    if (response.stop_reason === "refusal") return finish("refusal");
    if (response.stop_reason === "max_tokens") return finish("max_tokens");

    const toolRequests = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
    if (toolRequests.length === 0) {
      // The model stopped talking without handing in a report. Remind it once.
      if (remindedAboutReport) return finish("no_report");
      remindedAboutReport = true;
      messages.push({ role: "user", content: MISSING_REPORT_NOTICE });
      continue;
    }

    // ---- 3. run the tools the model asked for
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const request of toolRequests) {
      options.onEvent?.({ type: "tool_call", name: request.name, input: request.input });
      const toolStarted = Date.now();
      const result = request.name === SUBMIT_REPORT ? acceptReport(run, request.input) : await callTool(tools, request.name, request.input);
      const ms = Date.now() - toolStarted;

      run.toolCalls.push({ round, name: request.name, input: request.input, result: result.text, isError: result.isError, ms });
      options.onEvent?.({ type: "tool_result", name: request.name, result: result.text, isError: result.isError, ms });
      results.push({ type: "tool_result", tool_use_id: request.id, content: result.text, is_error: result.isError });
    }

    if (run.report) return finish("report");

    // ---- 4. give the results back: all of them in one message, in the order they were asked for
    messages.push({ role: "user", content: round === options.maxRounds - 1 ? [...results, { type: "text", text: LAST_ROUND_NOTICE }] : results });
  }

  return finish("max_rounds");
}

/** Checks the report against its schema. A report that does not fit goes back to the model with the reason. */
function acceptReport(run: AgentRun, input: unknown): { text: string; isError: boolean } {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return { text: `The report does not have the required shape:\n${z.prettifyError(parsed.error)}`, isError: true };
  run.report = parsed.data;
  return { text: "Report accepted.", isError: false };
}

/** Runs a simulator tool. A failure becomes an error result the model can read, never a crash of the agent. */
async function callTool(tools: ToolSet, name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    return await tools.call(name, input);
  } catch (error) {
    return { text: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

/** Adds one response's tokens and cost to the run's totals. */
function account(run: AgentRun, response: Message): void {
  const { total, byModel } = usageOf(response);
  run.usage = addUsage(run.usage, total);
  for (const [model, usage] of byModel) {
    if (!run.servedBy.includes(model)) run.servedBy.push(model);
    const cost = costUsd(model, usage);
    run.costUsd = run.costUsd === null || cost === null ? null : run.costUsd + cost;
  }
}

/**
 * Tokens used by one response. Normally one model answers. After a fallback the response lists the
 * tokens of each model that ran, and each is billed at its own price.
 */
function usageOf(response: Message): { total: TokenUsage; byModel: Map<string, TokenUsage> } {
  const usage = response.usage;
  const parts = usage.iterations?.flatMap((entry) => ("input_tokens" in entry ? [{ model: ("model" in entry && entry.model) || response.model, usage: entry }] : [])) ?? [];
  const entries = parts.length > 0 ? parts : [{ model: response.model, usage }];

  const byModel = new Map<string, TokenUsage>();
  for (const entry of entries) {
    const tokens: TokenUsage = {
      inputTokens: entry.usage.input_tokens ?? 0,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: entry.usage.cache_read_input_tokens ?? 0,
      outputTokens: entry.usage.output_tokens,
    };
    byModel.set(entry.model, addUsage(byModel.get(entry.model) ?? NO_USAGE, tokens));
  }
  return { total: [...byModel.values()].reduce(addUsage, NO_USAGE), byModel };
}
