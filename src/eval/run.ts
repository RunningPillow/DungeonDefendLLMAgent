// Measures the agent: how often it is right, whether repeated runs agree, and what a run takes.
//
//   npm run eval                       all cases, 3 runs each
//   npm run eval -- --reps 1 --only mirror
//
// Options: --reps 3   --only <case id>   --model sonnet   --effort medium   --max-rounds 8
//          --truth-only   only compute the right answers, do not run the agent (free)
//
// For every case the simulator first computes the right answer by itself. Then the agent gets the
// question several times, each time from scratch, and its answers are compared with that.
// Runs use the Claude subscription (the default engine); nothing is billed.
//
// Everything is written to evals/<time>/: summary.md, results.json, and the full record of every run.

import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runWithClaudeCode } from "../agent/claude-code.js";
import type { AgentRun, Effort } from "../agent/types.js";
import { repoRoot } from "../env.js";
import { GameData } from "../sim/data.js";
import { CASES, groundTruth, labelIn, questionFor, type GroundTruth, type Label } from "./cases.js";

/**
 * How one run was graded.
 * correct / wrong: the agent gave a label.
 * no_label: the agent reported, but the answer did not start with a label, so it cannot be graded.
 * error: the run never produced a report (process failure, usage limit, round limit). This says
 *   nothing about the agent's judgement and is counted apart from wrong answers.
 */
type Status = "correct" | "wrong" | "no_label" | "error";

interface Row {
  caseId: string;
  rep: number;
  expected: Label;
  got: Label | null;
  status: Status;
  outcome: AgentRun["outcome"];
  rounds: number;
  toolCalls: number;
  matches: number;
  seconds: number;
  costUsd: number | null;
  servedBy: string[];
  answer: string;
  runFile: string;
}

const print = (line = "") => process.stdout.write(line + "\n");

async function main() {
  const { values } = parseArgs({
    options: { reps: { type: "string" }, only: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, "max-rounds": { type: "string" }, "truth-only": { type: "boolean" } },
  });
  const reps = Number(values.reps ?? 3);
  const options = { model: values.model ?? "sonnet", effort: (values.effort ?? "medium") as Effort, maxRounds: Number(values["max-rounds"] ?? 8) };
  const cases = CASES.filter((evalCase) => !values.only || evalCase.id === values.only);
  if (cases.length === 0) throw new Error(`No case "${values.only}". Cases: ${CASES.map((evalCase) => evalCase.id).join(", ")}.`);

  // ---- the right answers, from the simulator alone
  print("Right answers, computed by the simulator:");
  const data = await GameData.load();
  const truths = new Map<string, GroundTruth>();
  for (const evalCase of cases) {
    const truth = await groundTruth(data, evalCase);
    truths.set(evalCase.id, truth);
    print(`  ${evalCase.id.padEnd(14)} ${truth.label.padEnd(13)} ${truth.stable ? "" : "UNSTABLE (close to the threshold)  "}${truth.detail}`);
  }

  if (values["truth-only"]) return; // check the cases without running the agent: uses no subscription quota

  // ---- the agent's answers
  const folder = path.join(repoRoot, "evals", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(path.join(folder, "runs"), { recursive: true });
  print(`\nAgent: engine claude-code, model ${options.model}, effort ${options.effort}, at most ${options.maxRounds} rounds, ${reps} run(s) per case`);
  const rows: Row[] = [];
  for (const evalCase of cases) {
    for (let rep = 1; rep <= reps; rep++) {
      const run = await runWithClaudeCode(questionFor(evalCase), options);
      const runFile = path.join("runs", `${evalCase.id}-${rep}.json`);
      writeFileSync(path.join(folder, runFile), JSON.stringify(run, null, 2));

      const expected = truths.get(evalCase.id)!.label;
      const got = run.report ? labelIn(run.report.answer) : null;
      const status: Status = !run.report ? "error" : got === null ? "no_label" : got === expected ? "correct" : "wrong";
      const row: Row = {
        caseId: evalCase.id, rep, expected, got, status, outcome: run.outcome, rounds: run.rounds, toolCalls: run.toolCalls.length,
        matches: run.toolCalls.filter((call) => call.name === "simulate_match" && !call.isError).length,
        seconds: run.seconds, costUsd: run.costUsd, servedBy: run.servedBy, answer: run.report?.answer ?? run.lastText, runFile,
      };
      rows.push(row);
      print(`  ${evalCase.id.padEnd(14)} run ${rep}: ${status.padEnd(8)} expected ${expected}, got ${got ?? "-"}   (${row.rounds} rounds, ${row.matches} matches, ${row.seconds.toFixed(0)} s)`);
      if (run.subscriptionUsage?.fiveHour !== undefined) print(`${" ".repeat(18)}subscription: ${Math.round(run.subscriptionUsage.fiveHour * 100)} % of the 5-hour limit used`);
    }
  }

  const summary = summarize(cases.map((evalCase) => ({ id: evalCase.id, checks: evalCase.checks, truth: truths.get(evalCase.id)! })), rows, options, reps);
  writeFileSync(path.join(folder, "results.json"), JSON.stringify({ options, reps, truths: Object.fromEntries(truths), rows }, null, 2));
  writeFileSync(path.join(folder, "summary.md"), summary);
  print("\n" + summary);
  print(`saved to: ${path.relative(repoRoot, folder)}`);
}

function summarize(cases: { id: string; checks: string; truth: GroundTruth }[], rows: Row[], options: { model: string; effort: string; maxRounds: number }, reps: number): string {
  const tally = (subset: Row[], status: Status) => subset.filter((row) => row.status === status).length;
  const graded = rows.filter((row) => row.status !== "error");
  const range = (values: number[], digits: number) => (values.length === 0 ? "-" : `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(digits)} (${Math.min(...values).toFixed(digits)} to ${Math.max(...values).toFixed(digits)})`);
  const costs = graded.flatMap((row) => (row.costUsd === null ? [] : [row.costUsd]));

  const lines = [
    "# Agent evaluation",
    "",
    `Engine claude-code, model ${options.model}, effort ${options.effort}, at most ${options.maxRounds} rounds. ${reps} run(s) per case, each from scratch.`,
    `Models that answered: ${[...new Set(rows.flatMap((row) => row.servedBy))].join(", ") || "-"}.`,
    "",
    `**Correct: ${tally(rows, "correct")} of ${graded.length} graded runs.** Wrong: ${tally(rows, "wrong")}. No label: ${tally(rows, "no_label")}. Runs that failed before answering (not graded): ${tally(rows, "error")}.`,
    "",
    "| Case | What it checks | Right answer | Correct | Runs agree | Answers |",
    "|---|---|---|---|---|---|",
  ];
  for (const evalCase of cases) {
    const subset = rows.filter((row) => row.caseId === evalCase.id);
    const answers = subset.map((row) => (row.status === "error" ? `(${row.outcome})` : (row.got ?? "(no label)")));
    lines.push(`| ${evalCase.id} | ${evalCase.checks} | ${evalCase.truth.label}${evalCase.truth.stable ? "" : " (unstable)"} | ${tally(subset, "correct")} of ${subset.length} | ${new Set(answers).size === 1 ? "yes" : "no"} | ${answers.join(", ")} |`);
  }
  lines.push(
    "",
    "Per run, average (lowest to highest), over graded runs:",
    "",
    `- rounds: ${range(graded.map((row) => row.rounds), 1)}`,
    `- simulated matches: ${range(graded.map((row) => row.matches), 1)}`,
    `- time: ${range(graded.map((row) => row.seconds), 0)} s`,
    `- cost at API list prices: $${range(costs, 3)}. Nothing was charged; the runs used a Claude subscription.`,
    "",
    "How the right answers were obtained (the simulator alone, no model):",
    "",
    ...cases.map((evalCase) => `- ${evalCase.id}: ${evalCase.truth.detail}`),
    "",
    `With ${graded.length} graded runs this is a check that the agent works, not a precise accuracy figure: one wrong run moves the result by ${graded.length ? Math.round(100 / graded.length) : 0} points.`,
    "",
  );
  return lines.join("\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
