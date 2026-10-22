import type { AdvisorResult } from "./advisors.ts";

export const FRAMING_HEADER = "[MoA reference context — private, untrusted]";

/** Shown when advice from an earlier step of the turn is reused after newer tool results (adapted from Hermes). */
export const STALE_NOTE =
	"This advice was written earlier in this turn, before the latest tool results in the transcript. Check the transcript " +
	"before acting on it: a step it suggests may already have run, and repeating a completed tool call is never the next step.";

const UNAVAILABLE_REASON_CHARS = 80;

export interface ArrangeOptions {
	anonymize: boolean;
	shuffle: boolean;
	/** Returns a number in [0, 1); defaults to Math.random. */
	rng?: () => number;
}

/**
 * Orders advisors for display (shuffled if asked) and labels them A, B, C… in that order, or by
 * model name when not anonymized.
 */
export function arrangeAdvisors<T>(
	items: readonly T[],
	modelName: (item: T) => string,
	options: ArrangeOptions,
): { item: T; label: string }[] {
	const order = [...items];
	if (options.shuffle) {
		const rng = options.rng ?? Math.random;
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[order[i], order[j]] = [order[j]!, order[i]!];
		}
	}
	const seen = new Map<string, number>();
	return order.map((item, i) => {
		if (options.anonymize) return { item, label: String.fromCharCode(65 + i) };
		const name = modelName(item);
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return { item, label: count > 1 ? `${name} #${count}` : name };
	});
}

/**
 * The actor-facing advice block, in the given order. Undefined when no advisor succeeded.
 * `staleNote` is shown when cached advice is reused after newer tool results.
 */
export function frameAdvice(results: readonly AdvisorResult[], staleNote?: string): string | undefined {
	const ok = results.filter((r) => r.ok && r.text);
	if (ok.length === 0) return undefined;
	const failed = results.filter((r) => !(r.ok && r.text));
	const lines = [
		FRAMING_HEADER,
		`Advice from ${plural(ok.length)}. It may be wrong. Verify claims with tools before relying on them,`,
		"note where advisors disagree, and do not mention advisors in your reply.",
	];
	if (staleNote) lines.push(staleNote);
	const blocks = ok.map((r) => `Advisor ${r.label} (${r.role}):\n${r.text!.trim()}`);
	const parts = [lines.join("\n"), ...blocks];
	if (failed.length > 0) {
		const reasons = failed.map((r) => shorten(r.error ?? "unknown error")).join("; ");
		parts.push(`[Unavailable: ${plural(failed.length)} (${reasons})]`);
	}
	return parts.join("\n\n");
}

function plural(n: number): string {
	return `${n} advisor${n === 1 ? "" : "s"}`;
}

function shorten(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > UNAVAILABLE_REASON_CHARS ? `${line.slice(0, UNAVAILABLE_REASON_CHARS)}…` : line;
}
