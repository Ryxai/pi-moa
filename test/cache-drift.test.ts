/**
 * Shape-drift guard: builds real provider payloads with the installed pi-ai adapters (no network:
 * `onPayload` records the payload and throws before any request is sent) and checks that
 * `moveCacheMarker` still finds and moves their cache marker. If pi changes how it places
 * markers, these fail instead of the fix silently doing nothing.
 */
import { Type, type Context, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { describe, expect, it } from "vitest";
import { moveCacheMarker } from "../src/cache.ts";
import { FRAMING_HEADER } from "../src/framing.ts";
import { ADVICE_REQUEST_BLOCKS, buildTextView, type AgentMessage } from "../src/view.ts";
import { assistant, text, toolResult } from "./fixtures.ts";

const ADVICE = `${FRAMING_HEADER}\nAdvice from 1 advisor.\n\nAdvisor A (advisor):\nCheck the failing test first.`;
const STOP = "captured payload; no request sent";

type StreamFn = (model: Model<never>, context: Context, options?: SimpleStreamOptions) => { result(): Promise<unknown> };

/** Runs the adapter until it hands us its payload, then stops it. */
async function capture(stream: unknown, model: unknown, context: Context, options: SimpleStreamOptions = {}): Promise<unknown> {
	let payload: unknown;
	const result = await (stream as StreamFn)(model as Model<never>, context, {
		apiKey: "test-key",
		...options,
		onPayload: (p) => {
			payload = structuredClone(p);
			throw new Error(STOP);
		},
	}).result();
	expect(JSON.stringify(result)).toContain(STOP);
	expect(payload).toBeDefined();
	return payload;
}

const bash = { name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) };

/** The actor's request after `context_with_system`: a tool step, then our advice as the last user message. */
function actorContext(): Context {
	const messages: Message[] = [
		{ role: "system", content: "You are pi.", toolsAdded: [bash], timestamp: 0 },
		{ role: "user", content: "Fix the failing test", timestamp: 1 },
		assistant(
			[
				{ type: "thinking", thinking: "Run the tests.", thinkingSignature: "sig" },
				text("Running the tests."),
				{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "npm test" } },
			],
			{ api: "anthropic-messages", provider: "anthropic", model: "x", stopReason: "toolUse" },
		),
		toolResult("bash", "1 failing", true) as Message,
		{ role: "user", content: [text(ADVICE)], timestamp: 4 },
	];
	(messages[3] as { toolCallId: string }).toolCallId = "toolu_1";
	return { messages };
}

/** An advisor's text view of the same step. */
function advisorContext(): Context {
	const transcript: AgentMessage[] = [
		{ role: "user", content: "Fix the failing test", timestamp: 1 },
		assistant([text("Running the tests."), { type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "npm test" } }]),
		toolResult("bash", "1 failing", true),
	];
	return buildTextView(transcript, { systemPrompt: "You advise.", toolResultChars: 4000 });
}

const json = (value: unknown) => JSON.stringify(value);
const countMarkers = (value: unknown, key: string) => json(value).split(`"${key}"`).length - 1;

describe("shape drift: real pi-ai payloads", () => {
	describe("anthropic-messages", () => {
		const models = [
			["claude-sonnet-4-5", ANTHROPIC_MODELS["claude-sonnet-4-5"]],
			["claude-sonnet-5-5 (mid-conversation effort)", ANTHROPIC_MODELS["claude-sonnet-5-5"]],
		] as const;

		it.each(models)("actor: moves cache_control from the advice to the tool_result (%s)", async (_name, model) => {
			expect(model).toBeDefined();
			const payload = (await capture(anthropicStream, model, actorContext(), { reasoning: "high" })) as {
				messages: { role: string; content: { type: string; text?: string; cache_control?: unknown }[] }[];
			};
			const adviceMessage = payload.messages.findLast((m) => m.role === "user")!;
			expect(adviceMessage.content.at(-1)).toMatchObject({ text: ADVICE, cache_control: expect.anything() });

			const out = moveCacheMarker(payload, [ADVICE]) as typeof payload;
			const adviceIndex = out.messages.findLastIndex((m) => m.role === "user");
			expect(out.messages[adviceIndex]!.content.at(-1)!.cache_control).toBeUndefined();
			expect(out.messages[adviceIndex - 1]!.content.at(-1)).toMatchObject({ type: "tool_result", cache_control: expect.anything() });
			expect(countMarkers(out, "cache_control")).toBe(countMarkers(payload, "cache_control"));
		});

		it("advisor: moves cache_control from the advice request to the last result", async () => {
			const payload = await capture(anthropicStream, ANTHROPIC_MODELS["claude-sonnet-4-5"], advisorContext());
			const out = moveCacheMarker(payload, ADVICE_REQUEST_BLOCKS) as { messages: { content: { text: string; cache_control?: unknown }[] }[] };
			const last = out.messages.at(-1)!.content;
			expect(last.at(-1)!.cache_control).toBeUndefined();
			expect(last.at(-2)).toMatchObject({ text: "⟨result bash (error): 1 failing⟩", cache_control: expect.anything() });
		});
	});

	describe("openai-completions with cacheControlFormat anthropic (OpenRouter)", () => {
		const model = OPENROUTER_MODELS["anthropic/claude-sonnet-4.5"];

		it("actor: moves cache_control from the advice to the tool message", async () => {
			const payload = (await capture(completionsStream, model, actorContext())) as { messages: { role: string; content: unknown }[] };
			expect(json(payload.messages.at(-1))).toContain("cache_control");
			const out = moveCacheMarker(payload, [ADVICE]) as typeof payload;
			expect(json(out.messages.at(-1))).not.toContain("cache_control");
			const previous = out.messages.at(-2)!;
			// `requiresAssistantAfterToolResult` providers get a synthetic assistant message here instead.
			expect(previous.role).toBe("tool");
			expect(previous.content).toEqual([{ type: "text", text: "1 failing", cache_control: expect.anything() }]);
		});

		it("advisor: moves cache_control from the advice request to the last result", async () => {
			const payload = await capture(completionsStream, model, advisorContext());
			const out = moveCacheMarker(payload, ADVICE_REQUEST_BLOCKS) as { messages: { role: string; content: { text: string; cache_control?: unknown }[] }[] };
			const last = out.messages.at(-1)!;
			expect(last.role).toBe("user");
			expect(last.content.at(-1)!.cache_control).toBeUndefined();
			expect(last.content.at(-2)).toMatchObject({ text: "⟨result bash (error): 1 failing⟩", cache_control: expect.anything() });
		});
	});

	describe("bedrock-converse-stream", () => {
		const model = AMAZON_BEDROCK_MODELS["anthropic.claude-opus-4-8"];
		const options: SimpleStreamOptions = {
			env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
		};

		it("actor: moves the cachePoint from after the advice to after the tool result", async () => {
			const payload = (await capture(bedrockStream, model, actorContext(), options)) as { messages: { role: string; content: Record<string, unknown>[] }[] };
			expect(payload.messages.at(-1)!.content.at(-1)).toHaveProperty("cachePoint");
			const out = moveCacheMarker(payload, [ADVICE]) as typeof payload;
			expect(out.messages.at(-1)!.content).toEqual([{ text: ADVICE }]);
			const previous = out.messages.at(-2)!.content;
			expect(previous.at(-2)).toHaveProperty("toolResult");
			expect(previous.at(-1)).toHaveProperty("cachePoint");
		});

		it("advisor: moves the cachePoint to after the last result", async () => {
			const payload = await capture(bedrockStream, model, advisorContext(), options);
			const out = moveCacheMarker(payload, ADVICE_REQUEST_BLOCKS) as { messages: { content: Record<string, unknown>[] }[] };
			const last = out.messages.at(-1)!.content;
			expect(last.map((b) => Object.keys(b)[0])).toEqual(["text", "cachePoint", "text"]);
			expect(last[0]).toEqual({ text: "⟨result bash (error): 1 failing⟩" });
		});
	});
});
