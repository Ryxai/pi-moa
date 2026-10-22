import {
	getCurrentSystemMessage,
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Message,
	type SystemMessage,
	type TextContent,
	type ToolCall,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm, type ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import type { ModelLike } from "./config-resolve.ts";
import type { ContextView, PinItem } from "./schema.ts";
import { head, truncateMiddle } from "./text.ts";
import { CONSULT_TOOL } from "./tool-names.ts";
import { trimEntries } from "./trim.ts";

export type AgentMessage = ContextWithSystemEvent["messages"][number];

export const TOOL_ARGS_CHARS = 400;

export const ADVICE_REQUEST =
	"Above is the conversation so far between the user and the agent. Give your advice for the agent's next step.";

/**
 * Prefixes every block after the first in a turn: some adapters (openai-completions) join an
 * assistant message's text blocks with "".
 */
const BLOCK_SEPARATOR = "\n\n";

/** The advice request, with the acting agent's question for a `consult` call. */
export function adviceRequest(question?: string): string {
	return question ? `${ADVICE_REQUEST}\n\nThe acting agent asks: ${question}` : ADVICE_REQUEST;
}

/** The exact texts a text view's advice-request block can have (its own message, or appended to a user turn). */
export function adviceRequestBlocks(request: string): readonly string[] {
	return [request, `${BLOCK_SEPARATOR}${request}`];
}

export const ADVICE_REQUEST_BLOCKS = adviceRequestBlocks(ADVICE_REQUEST);

const CONSULT_OMITTED = "advice omitted";

const AGENT_FIRST = "(The transcript starts with the agent.)";

/** `auto` is native when the advisor is the actor's model (same provider and id), else text. */
export function selectView(view: ContextView, advisor: ModelLike, actor: ModelLike | undefined): "native" | "text" {
	if (view !== "auto") return view;
	return actor && advisor.provider === actor.provider && advisor.id === actor.id ? "native" : "text";
}

/** The native view's trailing user message: advisor instructions, then the advice request. */
export function nativeInstruction(prompt: string, request = ADVICE_REQUEST): string {
	return `${prompt}\n\n${request}`;
}

/**
 * What pi does to the request after the `context_with_system` handlers, from the run's prompt
 * options and settings (pi-coding-agent 1.4.0).
 */
export interface RequestProjection {
	/** `_installHiddenDeclarationsProjection`: declarations requests leave out. */
	hiddenTools?: readonly string[];
	/** `_installAgentForcedPromptProjection`: a `before_agent_start` handler replaced the prompt. */
	forceSystemPrompt?: string;
	/** `images.blockImages`: sdk.js's `convertToLlm` wrapper replaces images with a note. */
	blockImages?: boolean;
}

/**
 * The actor's own request (system message with prompt and tools, transcript, thinking), projected
 * as pi projects it, followed by `instruction` as one trailing user message, so the provider
 * prefix matches the actor's.
 */
export function buildNativeView(messages: readonly AgentMessage[], instruction: string, projection: RequestProjection = {}): Context {
	let transcript: Message[] = convertToLlm([...messages]);
	if (projection.hiddenTools?.length) transcript = hideDeclarations(transcript, new Set(projection.hiddenTools));
	if (projection.forceSystemPrompt !== undefined) transcript = forcePrompt(transcript, projection.forceSystemPrompt);
	if (projection.blockImages) transcript = transcript.map(blockImages);
	const request: UserMessage = { role: "user", content: [{ type: "text", text: instruction }], timestamp: transcript.at(-1)?.timestamp ?? 0 };
	return { messages: [...transcript, request] };
}

/** Mirrors agent-session.js `_installHiddenDeclarationsProjection`. */
function hideDeclarations(messages: Message[], hidden: ReadonlySet<string>): Message[] {
	return messages.map((message) => {
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
		const { toolsAdded, toolsRemoved, ...rest } = message;
		const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
		const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
		return { ...rest, ...(added.length > 0 ? { toolsAdded: added } : {}), ...(removed.length > 0 ? { toolsRemoved: removed } : {}) };
	});
}

/** Mirrors agent-session.js `_installAgentForcedPromptProjection` (timestamp 0 instead of now; not sent). */
function forcePrompt(messages: Message[], forced: string): Message[] {
	const current = getCurrentSystemMessage(messages);
	const head: SystemMessage = {
		role: "system",
		content: forced,
		...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
		timestamp: current?.timestamp ?? 0,
	};
	return [head, ...messages.filter((message) => message.role !== "system")];
}

const IMAGES_BLOCKED = "Image reading is disabled.";

/** Mirrors sdk.js `convertToLlmWithBlockImages`. */
function blockImages(message: Message): Message {
	if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
	const content: (TextContent | ImageContent)[] = message.content;
	if (!content.some((c) => c.type === "image")) return message;
	const filtered = content
		.map((c): TextContent | ImageContent => (c.type === "image" ? { type: "text", text: IMAGES_BLOCKED } : c))
		.filter((c, i, arr) => {
			const previous = arr[i - 1];
			return !(c.type === "text" && c.text === IMAGES_BLOCKED && previous?.type === "text" && previous.text === IMAGES_BLOCKED);
		});
	return { ...message, content: filtered } as Message;
}

/** One rendered source message. */
export interface Entry {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	/** The source message's role; "omitted" marks a trimming marker. */
	source: AgentMessage["role"] | "omitted";
	/** Tool calls of an assistant message. */
	calls?: readonly ToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export interface Turn {
	role: "user" | "assistant";
	/** One block per source message, so earlier blocks never change as the transcript grows. */
	blocks: string[];
	/** Timestamp of the first message merged into this turn. */
	timestamp: number;
}

export interface TextViewOptions {
	systemPrompt: string;
	toolResultChars: number;
	/** Size limit for the whole view in characters (see `budgetChars`); omitted = no trimming. */
	budgetChars?: number;
	pin?: readonly PinItem[];
	/** The closing advice request (see `adviceRequest`); default `ADVICE_REQUEST`. */
	request?: string;
}

/**
 * The Hermes-style advisor view: plain text turns, no tools, ending with the advice request.
 * The request is always its own content block (in the final user message, or a new user
 * message after an assistant turn), so every earlier block is byte-identical across steps.
 */
export function buildTextView(messages: readonly AgentMessage[], options: TextViewOptions): Context {
	const request = options.request ?? ADVICE_REQUEST;
	let entries = renderEntries(messages, options.toolResultChars);
	if (options.budgetChars !== undefined) {
		const fixed = options.systemPrompt.length + BLOCK_SEPARATOR.length + request.length;
		entries = trimEntries(entries, { budget: options.budgetChars, fixed, pin: options.pin ?? [] });
	}
	const turns = mergeEntries(entries);
	const last = turns.at(-1);
	if (last?.role === "user") last.blocks.push(`${BLOCK_SEPARATOR}${request}`);
	else turns.push({ role: "user", blocks: [request], timestamp: last?.timestamp ?? 0 });
	return { systemPrompt: options.systemPrompt, messages: turns.map(toMessage) };
}

/**
 * Renders the transcript as alternating text turns, starting with a user turn: assistant turns
 * hold the agent's text and ⟨tool …⟩ calls, user turns hold user messages and ⟨result …⟩ blocks.
 */
export function renderTranscript(messages: readonly AgentMessage[], toolResultChars: number): Turn[] {
	return mergeEntries(renderEntries(messages, toolResultChars));
}

/** Renders each source message on its own; messages with nothing to show are skipped. */
export function renderEntries(messages: readonly AgentMessage[], toolResultChars: number): Entry[] {
	const entries: Entry[] = [];
	for (const source of messages) {
		for (const message of convertToLlm([source])) {
			const rendered = renderMessage(message, toolResultChars);
			if (!rendered) continue;
			const entry: Entry = { ...rendered, timestamp: message.timestamp, source: source.role };
			if (message.role === "assistant") entry.calls = message.content.filter((block) => block.type === "toolCall");
			if (message.role === "toolResult") Object.assign(entry, { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError });
			entries.push(entry);
		}
	}
	return entries;
}

/**
 * Same-role neighbours merge by appending blocks, so a longer transcript repeats the blocks of
 * its prefix.
 */
function mergeEntries(entries: readonly Entry[]): Turn[] {
	const turns: Turn[] = [];
	for (const entry of entries) {
		const last = turns.at(-1);
		if (last?.role === entry.role) {
			last.blocks.push(`${BLOCK_SEPARATOR}${entry.text}`);
			continue;
		}
		if (!last && entry.role === "assistant") turns.push({ role: "user", blocks: [AGENT_FIRST], timestamp: entry.timestamp });
		turns.push({ role: entry.role, blocks: [entry.text], timestamp: entry.timestamp });
	}
	return turns;
}

function renderMessage(message: Message, toolResultChars: number): { role: Turn["role"]; text: string } | undefined {
	let role: Turn["role"];
	let text: string;
	switch (message.role) {
		case "system":
			return undefined;
		case "user":
			role = "user";
			text = renderContent(message.content);
			break;
		case "assistant":
			// pi's provider transform drops failed responses too.
			if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
			role = "assistant";
			text = message.content
				.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? renderToolCall(block) : ""))
				.filter((part) => part.trim() !== "")
				.join("\n\n");
			break;
		case "toolResult": {
			// Results form their own user turn, as in a real transcript, so each step appends new
			// messages instead of growing the agent's turn (adapters such as openai-completions join
			// an assistant message's text parts into one string, which would defeat prompt caching).
			role = "user";
			// Advisors never see earlier advice: a consult result is the advice itself.
			const body = message.toolName === CONSULT_TOOL ? CONSULT_OMITTED : truncateMiddle(renderContent(message.content), toolResultChars);
			text = `⟨result ${message.toolName}${message.isError ? " (error)" : ""}: ${body}⟩`;
			break;
		}
	}
	text = text.trim();
	return text ? { role, text } : undefined;
}

function renderContent(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function renderToolCall(call: ToolCall): string {
	let args: string;
	try {
		args = JSON.stringify(call.arguments) ?? "";
	} catch {
		args = "…";
	}
	if (args.length > TOOL_ARGS_CHARS) args = `${head(args, TOOL_ARGS_CHARS)}…`;
	return `⟨tool ${call.name}(${args})⟩`;
}

function toMessage(turn: Turn): Message {
	const content: TextContent[] = turn.blocks.map((text) => ({ type: "text", text }));
	if (turn.role === "user") return { role: "user", content, timestamp: turn.timestamp } satisfies UserMessage;
	return {
		role: "assistant",
		content,
		api: "pi-moa",
		provider: "pi-moa",
		model: "transcript",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: turn.timestamp,
	} satisfies AssistantMessage;
}
