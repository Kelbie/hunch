import type { Finding } from "./check.js";
import type { Hunk } from "./diff.js";

/** Focus is an attribution question. The complete parent and its counterevidence remain visible. */
export async function localizeFinding(input: {
  finding: Finding; hunk: Hunk; maxLines: number;
  evaluate: (startLine: number, endLine: number) => Promise<string | null>;
}): Promise<Finding[]> {
  const { finding, hunk, maxLines, evaluate } = input;
  const changed = [...new Set(hunk.added.map(line => line.line))].sort((a, b) => a - b);
  if (!changed.length) return [{ ...finding, evidence: `${finding.evidence}; deletion-only location is a surviving-line anchor` }];
  async function narrow(lines: number[], parent: Finding): Promise<Finding[]> {
    if (lines.at(-1)! - lines[0]! + 1 <= maxLines || lines.length < 2) return [parent];
    const middle = Math.floor(lines.length / 2);
    const halves = [lines.slice(0, middle), lines.slice(middle)];
    // Evaluate both siblings before descending. A failed call cannot erase the parent's evidence.
    const answers: (string | null)[] = [];
    for (const half of halves) answers.push(await evaluate(half[0]!, half.at(-1)!));
    const supported = halves.flatMap((half, index) => answers[index] ? [{ half, evidence: answers[index]! }] : []);
    if (!supported.length) return [{ ...parent, evidence: `${parent.evidence}; broader context retained (neither child independently supported)` }];
    const findings: Finding[] = [];
    for (const { half, evidence } of supported) findings.push(...await narrow(half, { ...parent, line: half[0]!, endLine: half.at(-1)!, evidence: `${evidence}; localized with full parent context; baseline ${finding.evidence}` }));
    return findings;
  }
  return narrow(changed, finding);
}
