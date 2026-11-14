// The agent's final answer has a fixed shape. The model must fill in exactly these fields; an
// answer that does not fit is sent back to the model with the reason, and it tries again.

import { z } from "zod";

export const reportSchema = z.object({
  answer: z.string().describe("Direct answer to the question, two or three sentences."),
  findings: z
    .array(
      z.object({
        claim: z.string().describe("One thing the simulations showed."),
        evidence: z.string().describe("The matches and numbers behind the claim: teams, settings, runs, result."),
        confidence: z.enum(["high", "medium", "low"]).describe("high: clear and repeated; medium: clear in one match; low: close or decided by side or time limit."),
      }),
    )
    .describe("What the simulations showed, most important first."),
  recommendations: z
    .array(
      z.object({
        change: z.string().describe("A concrete change to the game data: which number, from what, to what."),
        reason: z.string().describe("Which finding supports it."),
      }),
    )
    .describe("Proposals for the game designer. Empty when the simulations support none."),
  limitations: z.array(z.string()).describe("What these simulations cannot tell."),
});

export type Report = z.infer<typeof reportSchema>;

export function reportAsMarkdown(question: string, report: Report): string {
  const lines = [`# ${question}`, "", report.answer, "", "## Findings", ""];
  report.findings.forEach((finding, index) => {
    lines.push(`${index + 1}. **${finding.claim}** (confidence: ${finding.confidence})`, `   ${finding.evidence}`);
  });
  lines.push("", "## Recommendations", "");
  if (report.recommendations.length === 0) lines.push("None.");
  for (const recommendation of report.recommendations) lines.push(`- **${recommendation.change}**`, `  ${recommendation.reason}`);
  lines.push("", "## Limitations", "");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n") + "\n";
}
