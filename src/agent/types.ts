// The record of one agent run. Both engines produce the same record, so reports and measurements
// do not depend on which one ran.

import type { TokenUsage } from "./pricing.js";
import type { Report } from "./report.js";

/**
 * What runs the agent loop.
 * "api": the loop in loop.ts, written by hand on the Claude API. Needs an API key; billed per token.
 * "claude-code": Claude Code running without a window, restricted to our instructions and our tools.
 *   Uses the Claude subscription; nothing is billed per run.
 */
export type Engine = "api" | "claude-code";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** How a run ended. Only "report" is a success. */
export type Outcome = "report" | "no_report" | "max_rounds" | "refusal" | "max_tokens" | "error";

export interface AgentOptions {
  model: string;
  /** How thoroughly the model works. Higher = more thinking and more tool calls = more tokens. */
  effort: Effort;
  /** Upper limit on requests to the model. One round can contain several tool calls. */
  maxRounds: number;
  /** Called as things happen, to show progress. */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "round"; round: number; usage: TokenUsage; servedBy: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: string; isError: boolean; ms: number };

export interface ToolCallRecord {
  round: number;
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
  ms: number;
}

export interface AgentRun {
  engine: Engine;
  question: string;
  model: string;
  effort: Effort;
  outcome: Outcome;
  report: Report | null;
  /** The model's last plain text, or the error message, for runs that ended without a report. */
  lastText: string;
  rounds: number;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  /**
   * Cost in USD at API list prices; null if unknown. With the "api" engine this is what the run
   * cost. With "claude-code" nothing is charged: it is what the same run would cost on the API.
   */
  costUsd: number | null;
  /** Models that actually answered. */
  servedBy: string[];
  seconds: number;
  /** "claude-code" only: share of the subscription's usage windows used so far (0..1), as reported during the run. */
  subscriptionUsage?: { fiveHour?: number; sevenDay?: number };
}
