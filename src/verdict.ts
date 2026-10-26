import { VERDICTS, type Verdict } from "./schema.ts";

const VERDICT_LINE = /^\s*(?:[*_#>\-\s]*)verdict\s*:\s*[*_]*\s*(on[\s-]?track|revise|blocked)\b/i;

/**
 * The verdict an advisor opened with, from the first non-empty line; undefined when it gave
 * none or an unknown one. Light markdown around the line (bold, heading, list marker) is tolerated.
 */
export function parseVerdict(text: string | undefined): Verdict | undefined {
	if (!text) return undefined;
	const first = text.split("\n").find((line) => line.trim() !== "");
	const match = first ? VERDICT_LINE.exec(first) : null;
	if (!match) return undefined;
	const word = match[1]!.toLowerCase().replace(/\s/g, "-");
	const verdict = word === "ontrack" ? "on-track" : word;
	return (VERDICTS as readonly string[]).includes(verdict) ? (verdict as Verdict) : undefined;
}
