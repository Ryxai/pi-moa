import { truncateMiddle } from "./text.ts";

/** Safety cap on one advisor's text, kept head and tail. */
export const ADVISOR_TEXT_CHARS = 12_000;

export const REMOVED_NOTE = "[removed tool-call-like text]";
export const REMOVED_HEADER_NOTE = "[removed framing-like text]";

export interface Sanitized {
	text: string;
	/** Tool-call-like or framing-like text was replaced. */
	changed: boolean;
	/** The text was cut to `maxChars`. */
	truncated: boolean;
}

/** XML-ish tool syntax (Anthropic, Hermes/Qwen, generic) as a line-leading tag. */
const TOOL_TAGS = "(?:antml:)?(?:function_calls|function_call|invoke|tool_calls?|tool_use|tool_code)";
const TAG_BLOCK = new RegExp(`^[ \\t]*<(${TOOL_TAGS})\\b[^>\\n]*>[\\s\\S]*?<\\/\\1>[^\\n]*$`, "gim");

/** Lines that open or close tool syntax, start with a leaked tool-call token, or mimic a transcript. */
const MARKER_LINE = new RegExp(
	[
		`^[ \\t>]*<\\/?${TOOL_TAGS}\\b`,
		"^[ \\t>]*<(?:antml:)?parameter\\s+name=",
		// `<|tool_call|>`, `<｜tool▁calls▁begin｜>`, `<|python_tag|>`, `<|call|>`
		"^[ \\t>]*<[|｜][^|｜<>\\n]{0,40}(?:tool|function|call|python_tag)[^|｜<>\\n]{0,40}[|｜]>",
		"^[ \\t>]*\\[TOOL_CALLS\\]",
		"^[ \\t>]*⟨(?:tool|result) ",
		"^[ \\t>]*\\[(?:called tool|tool result):",
	].join("|"),
	"i",
);
const HEADER_LINE = /^[ \t>]*\[MoA reference context/i;

/** A fence opening or closing line (``` or ~~~). */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

const NAME_KEYS = ["name", "tool", "tool_name"];
const ARG_KEYS = ["arguments", "input", "args", "parameters"];
const CALL_KEYS = new Set([...NAME_KEYS, ...ARG_KEYS, "id", "type", "call_id", "tool_call_id"]);
const CALL_TYPES = new Set(["tool_use", "function_call"]);

const MAX_JSON_CHARS = 20_000;
/** Total characters the JSON scan may visit per text; bounds adversarial input. */
const MAX_SCAN_STEPS = 200_000;

/**
 * Neutralises advisor text that the actor could mistake for its own action syntax, outside code
 * fences only (code samples stay verbatim): transcript marker lines, line-leading provider
 * tool-call tags and tokens, top-level tool-call JSON objects, and our framing header. Then caps it.
 */
export function sanitizeAdvice(input: string, maxChars = ADVISOR_TEXT_CHARS): Sanitized {
	// Pre-cap bounds the work on pathological output.
	const before = truncateMiddle(input, maxChars * 2);
	const budget = { steps: MAX_SCAN_STEPS };
	const text = splitFences(before)
		.map((segment) => (segment.fenced ? segment.text : cleanProse(segment.text, budget)))
		.join("\n");
	const changed = text !== before;
	const capped = truncateMiddle(text, maxChars);
	return { text: capped, changed, truncated: capped !== text || before !== input };
}

/** Consecutive lines inside or outside code fences; an unclosed fence runs to the end. */
function splitFences(text: string): { fenced: boolean; text: string }[] {
	const segments: { fenced: boolean; lines: string[] }[] = [];
	let fence: string | undefined;
	const push = (fenced: boolean, line: string) => {
		const last = segments.at(-1);
		if (last?.fenced === fenced) last.lines.push(line);
		else segments.push({ fenced, lines: [line] });
	};
	for (const line of text.split("\n")) {
		const marker = FENCE_LINE.exec(line)?.[1];
		if (fence === undefined) {
			if (marker) fence = marker;
			push(fence !== undefined, line);
		} else {
			push(true, line);
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
		}
	}
	return segments.map((s) => ({ fenced: s.fenced, text: s.lines.join("\n") }));
}

function cleanProse(text: string, budget: { steps: number }): string {
	const replaced = replaceToolJson(text.replace(TAG_BLOCK, REMOVED_NOTE), budget);
	const out: string[] = [];
	for (const line of replaced.split("\n")) {
		const next = HEADER_LINE.test(line) ? REMOVED_HEADER_NOTE : MARKER_LINE.test(line) ? REMOVED_NOTE : line;
		if (next.trim() === REMOVED_NOTE && out.at(-1)?.trim() === REMOVED_NOTE) continue;
		out.push(next);
	}
	return out.join("\n");
}

/**
 * Replaces top-level JSON objects that are exactly a tool call. Parseable containers (objects or
 * arrays) are skipped whole, so calls nested in examples, definitions or responses are kept.
 */
function replaceToolJson(text: string, budget: { steps: number }): string {
	const start = /[[{]\s*["[{]/g;
	let out = "";
	let from = 0;
	for (let match = start.exec(text); match && budget.steps > 0; match = start.exec(text)) {
		const end = balancedEnd(text, match.index, budget);
		if (end === undefined) continue;
		const value = parseJson(text.slice(match.index, end));
		if (value === undefined) continue;
		if (isCallObject(value)) {
			out += text.slice(from, match.index) + REMOVED_NOTE;
			from = end;
		}
		start.lastIndex = end;
	}
	return out + text.slice(from);
}

/** Index after the bracket closing the one at `open`, skipping strings; undefined if unbalanced. */
function balancedEnd(text: string, open: number, budget: { steps: number }): number | undefined {
	const stack: string[] = [];
	let inString = false;
	const limit = Math.min(text.length, open + MAX_JSON_CHARS, open + budget.steps);
	for (let i = open; i < limit; i++) {
		budget.steps--;
		const ch = text[i]!;
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
		else if (ch === "}" || ch === "]") {
			if (stack.pop() !== ch) return undefined;
			if (stack.length === 0) return i + 1;
		}
	}
	return undefined;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `tool_use`/`function_call` typed object, or `{name|tool|tool_name: string, arguments|input|args|parameters: …}`
 * with only call and id keys, whose arguments are an object (or, for `arguments`, a JSON object
 * string) and, for `parameters`, not a JSON Schema (a tool definition).
 */
function isCallObject(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (typeof value.type === "string" && CALL_TYPES.has(value.type)) return true;
	if (!Object.keys(value).every((key) => CALL_KEYS.has(key))) return false;
	if (!NAME_KEYS.some((key) => typeof value[key] === "string")) return false;
	return ARG_KEYS.some((key) => key in value && isArguments(key, value[key]));
}

function isArguments(key: string, value: unknown): boolean {
	if (key === "arguments" && typeof value === "string") return isRecord(parseJson(value));
	if (!isRecord(value)) return false;
	return key !== "parameters" || !(value.type === "object" || "properties" in value);
}
