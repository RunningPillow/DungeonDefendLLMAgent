// The agent's tools.
//
// Two come from the simulator's MCP server: the agent starts that server as a separate process,
// asks it which tools it has, and passes their descriptions to the model unchanged. The agent
// does not know anything about the simulator beyond what the server tells it.
// The third, submit_report, lives here: it is how the model hands in its final answer.

import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { repoRoot } from "../env.js";
import { reportSchema } from "./report.js";

export const SUBMIT_REPORT = "submit_report";

/** A long match can take over a minute; the MCP client's default limit is 60 s. */
const TOOL_TIMEOUT_MS = 10 * 60_000;

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface ToolSet {
  /** Tool descriptions in the form the Claude API expects. */
  definitions: Anthropic.Beta.BetaTool[];
  /** Runs one of the simulator's tools. */
  call(name: string, input: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

/** The final-answer tool. `strict` makes the API guarantee that the input matches the schema. */
export const submitReportTool: Anthropic.Beta.BetaTool = {
  name: SUBMIT_REPORT,
  description: "Hand in the final report. Call this exactly once, when the simulations you ran are enough to answer the question. It ends your work.",
  input_schema: withoutSchemaKey(z.toJSONSchema(reportSchema)) as Anthropic.Beta.BetaTool.InputSchema,
  strict: true,
};

/** The command that starts the simulator's MCP server. */
export const simulatorServer = {
  command: process.execPath, // this Node.js
  args: [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "src/mcp/server.ts")],
};

/** Starts the simulator's MCP server and returns its tools plus submit_report. */
export async function connectSimulatorTools(): Promise<ToolSet> {
  const client = new Client({ name: "dungeon-defend-balance-agent", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ ...simulatorServer, cwd: repoRoot }),
  );

  const { tools } = await client.listTools();
  const simulatorTools: Anthropic.Beta.BetaTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: withoutSchemaKey(tool.inputSchema) as Anthropic.Beta.BetaTool.InputSchema,
  }));

  return {
    definitions: [...simulatorTools, submitReportTool],
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input as Record<string, unknown> }, undefined, { timeout: TOOL_TIMEOUT_MS });
      const blocks = (result.content ?? []) as { type: string; text?: string }[];
      return { text: blocks.map((block) => block.text ?? "").join("\n"), isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

/** JSON Schema generators add a "$schema" key that the tool definition does not need. */
function withoutSchemaKey(schema: object): object {
  const { $schema: _unused, ...rest } = schema as Record<string, unknown>;
  return rest;
}
