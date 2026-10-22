/**
 * Prompt-cache marker fix for request-local tail content (the actor's advice block, the advisor's
 * advice request).
 *
 * pi's adapters put the conversation cache marker on the last block of the request. When that
 * block is content that changes every request, the cache entry written is `prefix + tail`, which
 * the next request never matches, and the plain prefix is never stored. `moveCacheMarker` moves
 * that marker onto the last cacheable block before the tail, so the stored entry is the stable
 * prefix. It only moves markers (never adds one), works on a copy, and never throws: unknown
 * shapes come back unchanged.
 *
 * Shapes handled, as built by pi-ai 1.4.0:
 * - Anthropic Messages (`anthropic-messages.js` convertMessages): `{ model, messages: [{ role,
 *   content: string | Block[] }] }`, marker `cache_control` on a block.
 * - OpenAI chat completions with `cacheControlFormat: "anthropic"` (`openai-completions.js`
 *   applyAnthropicCacheControl): `cache_control` on a text part of a user/assistant/tool message.
 *   Providers with `requiresAssistantAfterToolResult` get a synthetic assistant message ("I have
 *   processed the tool results.") between tool results and a user message, so after the actor's
 *   tool steps the marker lands on that synthetic text (a stable prefix too; an edge case).
 * - Bedrock Converse (`bedrock-converse-stream.js` convertMessages): `{ modelId, messages: [{ role,
 *   content: Block[] }] }`, marker is a separate `{ cachePoint }` element after the cached block.
 */

type Json = Record<string, unknown>;

interface Position {
	message: number;
	block: number;
}

/** Block types Anthropic accepts `cache_control` on (not thinking / redacted_thinking). */
const ANTHROPIC_CACHEABLE = new Set([
	"text",
	"image",
	"document",
	"search_result",
	"tool_use",
	"tool_result",
	"tool_addition",
	"tool_removal",
]);

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** pi's adapters drop unpaired surrogates from text before sending (`sanitizeSurrogates`). */
function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Moves every cache marker on or after the tail block (the last user-message text block whose
 * text is exactly one of `tailTexts`) onto the last cacheable block before it. Returns `payload`
 * itself when nothing changes, otherwise a copy; the input is never modified.
 */
export function moveCacheMarker(payload: unknown, tailTexts: readonly string[]): unknown {
	try {
		if (!isObject(payload) || !Array.isArray(payload.messages)) return payload;
		const texts = new Set<string>();
		for (const text of tailTexts) {
			if (typeof text !== "string" || text.trim() === "") continue;
			texts.add(text);
			texts.add(sanitizeSurrogates(text));
		}
		if (texts.size === 0) return payload;
		if (typeof payload.modelId === "string") return moveBedrock(payload, payload.messages, texts);
		return moveBlockMarker(payload, payload.messages, texts, isOpenAIChat(payload, payload.messages));
	} catch {
		return payload;
	}
}

function isOpenAIChat(payload: Json, messages: unknown[]): boolean {
	if ("stream_options" in payload || "prompt_cache_key" in payload || "max_completion_tokens" in payload) return true;
	if (messages.some((m) => isObject(m) && (m.role === "tool" || m.role === "developer" || "tool_calls" in m))) return true;
	// Anthropic sends the system prompt as `payload.system`; chat completions as the first message.
	const first = messages[0];
	return isObject(first) && first.role === "system" && payload.system === undefined;
}

/** The last text block of a user message whose text is one of `texts`. */
function findTail(messages: unknown[], texts: Set<string>, textOf: (block: unknown) => unknown): Position | undefined {
	for (let m = messages.length - 1; m >= 0; m--) {
		const message = messages[m];
		if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
		for (let b = message.content.length - 1; b >= 0; b--) {
			const text = textOf(message.content[b]);
			if (typeof text === "string" && texts.has(text)) return { message: m, block: b };
		}
	}
	return undefined;
}

/** Copy-on-write access to `payload.messages[i].content`. */
class Draft {
	readonly messages: unknown[];
	private readonly copied = new Set<number>();

	constructor(source: unknown[]) {
		this.messages = [...source];
	}

	message(index: number): Json {
		if (!this.copied.has(index)) {
			const original = this.messages[index] as Json;
			this.messages[index] = { ...original, content: Array.isArray(original.content) ? [...original.content] : original.content };
			this.copied.add(index);
		}
		return this.messages[index] as Json;
	}

	content(index: number): unknown[] {
		return this.message(index).content as unknown[];
	}
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages and OpenAI chat completions (`cache_control` on a content block)

function moveBlockMarker(payload: Json, messages: unknown[], texts: Set<string>, openai: boolean): unknown {
	const tail = findTail(messages, texts, (block) => (isObject(block) && block.type === "text" ? block.text : undefined));
	if (!tail) return payload;

	const marked: Position[] = [];
	for (let m = tail.message; m < messages.length; m++) {
		const message = messages[m];
		if (!isObject(message) || !Array.isArray(message.content)) continue;
		for (let b = m === tail.message ? tail.block : 0; b < message.content.length; b++) {
			const block = message.content[b];
			if (isObject(block) && block.cache_control !== undefined) marked.push({ message: m, block: b });
		}
	}
	const first = marked[0];
	if (!first) return payload;
	const marker = ((messages[first.message] as Json).content as Json[])[first.block]!.cache_control;

	const draft = new Draft(messages);
	for (const { message, block } of marked) {
		const content = draft.content(message);
		const { cache_control: _removed, ...rest } = content[block] as Json;
		content[block] = rest;
	}

	const target = findBlockTarget(messages, tail, openai);
	if (target) {
		const original = messages[target.message] as Json;
		if (typeof original.content === "string") {
			draft.message(target.message).content = [{ type: "text", text: original.content, cache_control: marker }];
		} else {
			const content = draft.content(target.message);
			const block = content[target.block] as Json;
			if (block.cache_control === undefined) content[target.block] = { ...block, cache_control: marker };
		}
	}
	return { ...payload, messages: draft.messages };
}

/** Last block before the tail that may carry `cache_control`; `block: -1` means string content. */
function findBlockTarget(messages: unknown[], tail: Position, openai: boolean): Position | undefined {
	const roles = openai ? ["user", "assistant", "tool"] : ["user", "assistant", "system"];
	for (let m = tail.message; m >= 0; m--) {
		const message = messages[m];
		if (!isObject(message) || !roles.includes(message.role as string)) continue;
		if (typeof message.content === "string") {
			if (m !== tail.message && message.content.trim() !== "") return { message: m, block: -1 };
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		const end = m === tail.message ? tail.block : message.content.length;
		for (let b = end - 1; b >= 0; b--) {
			if (isCacheableBlock(message.content[b], openai)) return { message: m, block: b };
		}
	}
	return undefined;
}

function isCacheableBlock(block: unknown, openai: boolean): boolean {
	if (!isObject(block) || typeof block.type !== "string") return false;
	if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== "";
	return !openai && ANTHROPIC_CACHEABLE.has(block.type);
}

// ---------------------------------------------------------------------------------------------
// Bedrock Converse (`{ cachePoint }` element after the cached block)

const isCachePoint = (block: unknown): boolean => isObject(block) && "cachePoint" in block;

function moveBedrock(payload: Json, messages: unknown[], texts: Set<string>): unknown {
	const tail = findTail(messages, texts, (block) => (isObject(block) && !("type" in block) ? block.text : undefined));
	if (!tail) return payload;

	let marker: unknown;
	const draft = new Draft(messages);
	for (let m = tail.message; m < messages.length; m++) {
		const message = messages[m];
		if (!isObject(message) || !Array.isArray(message.content)) continue;
		const from = m === tail.message ? tail.block + 1 : 0;
		if (!message.content.slice(from).some(isCachePoint)) continue;
		const kept = message.content.filter((block, b) => b < from || !isCachePoint(block));
		// Bedrock rejects empty content; pi never sends a marker-only message, so leave it alone.
		if (kept.length === 0) return payload;
		marker ??= message.content.slice(from).find(isCachePoint);
		draft.message(m).content = kept;
	}
	if (marker === undefined) return payload;

	// Cache points are placed in user messages only, as pi does.
	for (let m = tail.message; m >= 0; m--) {
		const message = messages[m];
		if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
		const end = m === tail.message ? tail.block : message.content.length;
		for (let b = end - 1; b >= 0; b--) {
			const block = message.content[b];
			if (!isObject(block) || isCachePoint(block)) continue;
			if (!isCachePoint(message.content[b + 1])) draft.content(m).splice(b + 1, 0, marker);
			return { ...payload, messages: draft.messages };
		}
	}
	return { ...payload, messages: draft.messages };
}
