/**
 * Trimming the text view to the advisor's context window.
 *
 * Sizes are estimated at 3 characters per token (conservative for code and JSON). When the view
 * is over budget, the oldest droppable messages go behind a `[… N earlier messages omitted …]`
 * marker, while the pinned ones stay: the last two steps, the last message, and the configured
 * `pin` items.
 *
 * Trimming is chunked so advisor prompt caching keeps working: the amount dropped grows in steps
 * of 30% of the budget (`goal` below), and the dropped set is always the oldest droppable
 * messages up to that amount. Messages leaving the last two steps join the end of that order, so
 * between cuts the dropped set, and so the view's prefix, stays the same; after a cut the view is
 * at most ~70% of the budget and grows again for several steps. The prefix also changes when a
 * pin moves: a new error, diff or user message frees the old pinned one (now droppable in the
 * middle of the order, so it is dropped and the cut point can shift). When even the kept
 * messages do not fit (`fitBlocks`), the truncated blocks change every step and so does the prefix.
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import type { PinItem, ThinkingLevel } from "./schema.ts";
import { truncateMiddle } from "./text.ts";
import { CONSULT_TOOL } from "./tool-names.ts";
import type { Entry } from "./view.ts";

export const CHARS_PER_TOKEN = 3;
/** Share of the context window the view may use. */
export const WINDOW_SHARE = 0.9;
/** Output reserve when the advisor sets no `maxTokens`. */
export const DEFAULT_RESERVE_TOKENS = 8192;
/** The reserve never takes more than this share of the window. */
export const MAX_RESERVE_SHARE = 0.5;
/**
 * Thinking budgets pi adds on top of `maxTokens` for budget-based models (pi-ai
 * `DEFAULT_THINKING_BUDGETS`; xhigh/max clamp to high).
 */
const THINKING_BUDGETS: Record<ThinkingLevel, number> = { off: 0, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };
/** Each cut drops a multiple of this share of the budget. */
export const CHUNK_SHARE = 0.3;
/** Kept blocks are never truncated below this. */
export const MIN_BLOCK_CHARS = 400;
/** Slack for the "[… N chars omitted …]" line that truncation adds. */
const TRUNCATION_SLACK = 64;

/**
 * The view's size limit in characters: `window × 0.9 − reserve`, the reserve being `maxTokens`
 * (8192 when unset) plus the thinking budget, capped at half the window. Undefined (no trimming)
 * when the window is unknown.
 */
export function budgetChars(contextWindow: number | undefined, maxTokens: number | undefined, thinking?: ThinkingLevel): number | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	const reserve = Math.min((maxTokens ?? DEFAULT_RESERVE_TOKENS) + THINKING_BUDGETS[thinking ?? "off"], contextWindow * MAX_RESERVE_SHARE);
	return Math.floor(contextWindow * WINDOW_SHARE - reserve) * CHARS_PER_TOKEN;
}

export function omittedMarker(count: number): string {
	return `[… ${count} earlier message${count === 1 ? "" : "s"} omitted …]`;
}

export interface TrimOptions {
	/** Characters allowed for the whole view. */
	budget: number;
	/** Characters outside the entries (system prompt, advice request). */
	fixed: number;
	pin: readonly PinItem[];
}

/** Returns `entries` (copied) when they fit, else the trimmed list; the input is not modified. */
export function trimEntries(entries: readonly Entry[], options: TrimOptions): Entry[] {
	const total = options.fixed + totalChars(entries);
	if (total <= options.budget) return [...entries];
	const pinned = pinnedIndices(entries, options.pin);
	const chunk = Math.max(1, Math.floor(options.budget * CHUNK_SHARE));
	const goal = Math.ceil((total - options.budget) / chunk) * chunk;
	const dropped = new Set<number>();
	let cut = 0;
	for (let i = 0; i < entries.length && cut < goal; i++) {
		if (pinned.has(i)) continue;
		dropped.add(i);
		cut += entries[i]!.text.length;
	}
	return fitBlocks(withMarkers(entries, dropped), options.budget - options.fixed);
}

/** Indices that are never dropped: the last two steps, the last entry, and the `pin` items. */
export function pinnedIndices(entries: readonly Entry[], pin: readonly PinItem[]): Set<number> {
	const keep = new Set<number>();
	if (entries.length > 0) keep.add(entries.length - 1);
	const steps = entries.flatMap((entry, i) => (entry.source === "assistant" ? [i] : []));
	const tailStart = steps.length >= 2 ? steps.at(-2)! : (steps[0] ?? entries.length);
	for (let i = tailStart; i < entries.length; i++) keep.add(i);

	const add = (i: number) => i >= 0 && keep.add(i);
	if (pin.includes("task")) {
		const task = entries.findLastIndex((e) => e.source === "user");
		add(task >= 0 ? task : entries.findLastIndex((e) => e.source === "compactionSummary"));
	}
	if (pin.includes("latestError")) {
		const error = entries.findLastIndex((e) => e.source === "toolResult" && e.isError === true && e.toolName !== CONSULT_TOOL);
		if (error >= 0) {
			add(error);
			add(entries.findLastIndex((e, i) => i < error && e.calls?.some((call) => call.id === entries[error]!.toolCallId)));
		}
	}
	if (pin.includes("latestDiff")) {
		const diff = entries.findLastIndex((e) => e.calls?.some(isFileMutation));
		if (diff >= 0) {
			add(diff);
			const ids = new Set(entries[diff]!.calls!.filter(isFileMutation).map((call) => call.id));
			entries.forEach((e, i) => i > diff && e.toolCallId !== undefined && ids.has(e.toolCallId) && keep.add(i));
		}
	}
	return keep;
}

const MUTATING_TOOLS = new Set([
	"edit",
	"write",
	"multiedit",
	"applypatch",
	"patch",
	"strreplace",
	"strreplaceeditor",
	"strreplacebasededittool",
	"createfile",
	"writefile",
	"editfile",
]);
const PATH_ARGS = ["path", "file_path", "filePath", "relative_path", "relativePath", "file", "filename", "file_name", "fileName"];
const CHANGE_ARGS = ["content", "edits", "diff", "patch", "newText", "new_text", "new_string", "new_str", "old_string", "oldText", "repl", "replacement"];

/**
 * A call that changes files: a known edit/write tool name (any namespace prefix or case, `_`/`-`
 * ignored), or any tool whose arguments carry both a file path and new content or a diff.
 */
export function isFileMutation(call: Pick<ToolCall, "name" | "arguments">): boolean {
	const base = call.name.split(/__|[.:/]/).at(-1)!.toLowerCase().replace(/[-_]/g, "");
	if (MUTATING_TOOLS.has(base)) return true;
	const args = call.arguments as Record<string, unknown> | undefined;
	if (typeof args !== "object" || args === null) return false;
	return PATH_ARGS.some((key) => typeof args[key] === "string") && CHANGE_ARGS.some((key) => args[key] !== undefined);
}

/** Replaces each run of dropped entries with one user-role marker; merging keeps roles alternating. */
function withMarkers(entries: readonly Entry[], dropped: ReadonlySet<number>): Entry[] {
	const out: Entry[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (!dropped.has(i)) {
			out.push(entries[i]!);
			continue;
		}
		let end = i;
		while (dropped.has(end + 1)) end++;
		out.push({ role: "user", text: omittedMarker(end - i + 1), timestamp: entries[i]!.timestamp, source: "omitted" });
		i = end;
	}
	return out;
}

/** When the kept entries still exceed `room`, truncates the largest ones head and tail, once each. */
function fitBlocks(entries: Entry[], room: number): Entry[] {
	const done = new Set<number>();
	let over = totalChars(entries) - room;
	while (over > 0) {
		let largest = -1;
		entries.forEach((e, i) => {
			if (done.has(i) || e.source === "omitted" || e.text.length <= MIN_BLOCK_CHARS) return;
			if (largest < 0 || e.text.length > entries[largest]!.text.length) largest = i;
		});
		if (largest < 0) break;
		done.add(largest);
		const entry = entries[largest]!;
		const text = truncateMiddle(entry.text, Math.max(MIN_BLOCK_CHARS, entry.text.length - over - TRUNCATION_SLACK));
		over -= entry.text.length - text.length;
		entries[largest] = { ...entry, text };
	}
	return entries;
}

function totalChars(entries: readonly Entry[]): number {
	return entries.reduce((sum, e) => sum + e.text.length, 0);
}
