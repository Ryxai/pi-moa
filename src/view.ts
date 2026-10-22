import type { AssistantMessage, Context, ImageContent, Message, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextWithSystemEvent["messages"][number];

export const TOOL_ARGS_CHARS = 400;

export const ADVICE_REQUEST =
	"Above is the conversation so far between the user and the agent. Give your advice for the agent's next step.";

/**
 * Prefixes every block after the first in a turn: some adapters (openai-completions) join an
 * assistant message's text blocks with "".
 */
const BLOCK_SEPARATOR = "\n\n";

const AGENT_FIRST = "(The transcript starts with the agent.)";

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
}

/**
 * The Hermes-style advisor view: plain text turns, no tools, ending with the advice request.
 * The request is always its own content block (in the final user message, or a new user
 * message after an assistant turn), so every earlier block is byte-identical across steps.
 */
export function buildTextView(messages: readonly AgentMessage[], options: TextViewOptions): Context {
	const turns = renderTranscript(messages, options.toolResultChars);
	const last = turns.at(-1);
	if (last?.role === "user") last.blocks.push(`${BLOCK_SEPARATOR}${ADVICE_REQUEST}`);
	else turns.push({ role: "user", blocks: [ADVICE_REQUEST], timestamp: last?.timestamp ?? 0 });
	return { systemPrompt: options.systemPrompt, messages: turns.map(toMessage) };
}

/**
 * Renders the transcript as alternating text turns, starting with a user turn. Each message
 * renders on its own into one block, and turns only grow by appending blocks, so a longer
 * transcript repeats the blocks of its prefix.
 */
export function renderTranscript(messages: readonly AgentMessage[], toolResultChars: number): Turn[] {
	const turns: Turn[] = [];
	for (const message of convertToLlm([...messages])) {
		const rendered = renderMessage(message, toolResultChars);
		if (!rendered) continue;
		const last = turns.at(-1);
		if (last?.role === rendered.role) {
			last.blocks.push(`${BLOCK_SEPARATOR}${rendered.text}`);
			continue;
		}
		if (!last && rendered.role === "assistant") turns.push({ role: "user", blocks: [AGENT_FIRST], timestamp: message.timestamp });
		turns.push({ role: rendered.role, blocks: [rendered.text], timestamp: message.timestamp });
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
			role = "assistant";
			const body = truncateMiddle(renderContent(message.content), toolResultChars);
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

/** Keeps the start and end of `text` within about `max` UTF-16 units, never splitting a surrogate pair. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const start = head(text, Math.ceil(max / 2));
	const end = tail(text, max - Math.ceil(max / 2));
	const omitted = text.length - start.length - end.length;
	return `${start}\n[… ${omitted} chars omitted …]\n${end}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function head(text: string, n: number): string {
	const cut = n > 0 && isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;
	return text.slice(0, cut);
}

function tail(text: string, n: number): string {
	if (n <= 0) return "";
	const from = text.length - n;
	return text.slice(isLowSurrogate(text.charCodeAt(from)) ? from + 1 : from);
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
