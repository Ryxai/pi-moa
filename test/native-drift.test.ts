/**
 * Native view against the installed pi-ai adapters (no network: `onPayload` records the payload
 * and throws before any request is sent). The advisor's call goes through `advisorView` and
 * `runAdvisors`, so it gets the real call options (`toolChoice`, payload hook).
 */
import { Type, type Context, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { describe, expect, it } from "vitest";
import { runAdvisors } from "../src/advisors.ts";
import { moveCacheMarker } from "../src/cache.ts";
import { DEFAULT_CONFIG, DEFAULT_PRESET } from "../src/config.ts";
import { FRAMING_HEADER } from "../src/framing.ts";
import { advisorView } from "../src/round.ts";
import type { AgentMessage } from "../src/view.ts";
import { assistant, text, toolResult } from "./fixtures.ts";

const ADVICE = `${FRAMING_HEADER}\nAdvice from 1 advisor.\n\nAdvisor A (advisor):\nCheck the failing test first.`;
const STOP = "captured payload; no request sent";

type StreamFn = (model: Model<never>, context: Context, options?: SimpleStreamOptions) => { result(): Promise<unknown> };
type AnyModel = Model<never> & { provider: string; id: string; api: string };

/** Runs the adapter until it hands over its (hook-transformed) payload, then stops it. */
async function capture(stream: unknown, model: AnyModel, context: Context, options: SimpleStreamOptions): Promise<{ payload: unknown; options: SimpleStreamOptions }> {
	let payload: unknown;
	const hook = options.onPayload;
	await (stream as StreamFn)(model, context, {
		apiKey: "test-key",
		...options,
		onPayload: async (p, m) => {
			payload = structuredClone(hook ? await hook(p, m) : p);
			throw new Error(STOP);
		},
	}).result();
	expect(payload).toBeDefined();
	return { payload, options };
}

const bash = { name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) };

/** The actor's transcript at a tool step, its assistant turn made by `model` (signed thinking). */
function transcript(model: AnyModel): AgentMessage[] {
	return [
		{ role: "system", content: "You are pi.", toolsAdded: [bash], timestamp: 0 },
		{ role: "user", content: "Fix the failing test", timestamp: 1 },
		assistant(
			[
				{ type: "thinking", thinking: "Run the tests.", thinkingSignature: "sig" },
				text("Running the tests."),
				{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "npm test" } },
			],
			{ api: model.api as never, provider: model.provider, model: model.id, stopReason: "toolUse" },
		),
		{ ...toolResult("bash", "1 failing", true), toolCallId: "toolu_1" },
	];
}

/** The actor's own request for that step, with our advice and its marker fix. */
async function actorPayload(stream: unknown, model: AnyModel, extra: SimpleStreamOptions) {
	const messages = [...(transcript(model) as Message[]), { role: "user" as const, content: [text(ADVICE)], timestamp: 4 }];
	const onPayload = (p: unknown) => moveCacheMarker(p, [ADVICE]);
	return (await capture(stream, model, { messages }, { ...extra, onPayload })).payload;
}

/** The native advisor's request: `runAdvisors` with the real adapter as `complete`. */
async function advisorPayload(stream: unknown, model: AnyModel, extra: SimpleStreamOptions, nativeToolChoice: "omit" | "none" = "none") {
	const preset = { ...DEFAULT_PRESET, context: { ...DEFAULT_PRESET.context, nativeToolChoice } };
	const input = { actor: model, config: DEFAULT_CONFIG, actorThinking: "high" as const, sessionId: "s1" };
	const view = advisorView(transcript(model), { model, config: preset.advisors[0]! }, { input, preset });
	expect(view.view).toBe("native");
	expect(view.thinking).toBe("high");
	let seen: { payload: unknown; options: SimpleStreamOptions } | undefined;
	const [result] = await runAdvisors(
		[
			{
				label: "A",
				model,
				role: "advisor",
				context: view.context,
				thinking: view.thinking,
				sessionId: view.sessionId,
				toolChoice: view.toolChoice,
				onPayload: (p: unknown) => moveCacheMarker(p, view.tailTexts),
			},
		],
		{
			complete: async (m, context, options) => {
				seen = await capture(stream, m, context, { ...extra, ...options });
				throw new Error(STOP);
			},
			timeoutMs: 5000,
		},
	);
	expect(result?.error).toBe(STOP);
	return { ...seen!, instruction: (view.context.messages.at(-1)!.content as { text: string }[])[0]!.text };
}

type Blocks = { role: string; content: Record<string, unknown>[] }[];

describe("native view: real pi-ai payloads", () => {
	it("anthropic: same system, tools and transcript as the actor; marker on the tool_result; tool_choice none", async () => {
		const model = ANTHROPIC_MODELS["claude-sonnet-4-5"] as unknown as AnyModel;
		const extra = { reasoning: "high" } as const;
		const actor = (await actorPayload(anthropicStream, model, extra)) as { system: unknown; tools: unknown; messages: Blocks };
		const advisor = await advisorPayload(anthropicStream, model, extra);
		const payload = advisor.payload as typeof actor & { tool_choice?: unknown };
		expect(advisor.options.toolChoice).toBe("none");
		expect(payload.tool_choice).toEqual({ type: "none" });
		expect(payload.system).toEqual(actor.system);
		expect(payload.tools).toEqual(actor.tools);
		expect(payload.messages.slice(0, -1)).toEqual(actor.messages.slice(0, -1));
		// Same-model thinking is replayed with its signature.
		expect(payload.messages[1]!.content[0]).toEqual({ type: "thinking", thinking: "Run the tests.", signature: "sig" });
		const toolResultBlock = payload.messages.at(-2)!.content.at(-1)!;
		expect(toolResultBlock).toMatchObject({ type: "tool_result", cache_control: expect.anything() });
		expect(payload.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: advisor.instruction }] });
	});

	it("anthropic, nativeToolChoice omit (default): the whole request but max_tokens matches the actor's", async () => {
		const model = ANTHROPIC_MODELS["claude-sonnet-4-5"] as unknown as AnyModel;
		const extra = { reasoning: "high" } as const;
		const actor = (await actorPayload(anthropicStream, model, extra)) as Record<string, unknown> & { messages: Blocks };
		const advisor = await advisorPayload(anthropicStream, model, extra, "omit");
		const payload = advisor.payload as typeof actor;
		expect(advisor.options.toolChoice).toBeUndefined();
		expect(advisor.options.sessionId).toBe("s1");
		const strip = ({ messages, max_tokens: _max, ...rest }: typeof actor) => ({ ...rest, messages: messages.slice(0, -1) });
		expect(payload).not.toHaveProperty("tool_choice");
		expect(strip(payload)).toEqual(strip(actor));
	});

	it("openai-completions (OpenRouter, anthropic cache_control): same prefix, marker on the tool message", async () => {
		const model = OPENROUTER_MODELS["anthropic/claude-sonnet-4.5"] as unknown as AnyModel;
		const actor = (await actorPayload(completionsStream, model, {})) as { tools: unknown; messages: { role: string; content: unknown }[] };
		const advisor = await advisorPayload(completionsStream, model, {});
		const payload = advisor.payload as typeof actor & { tool_choice?: unknown };
		expect(payload.tool_choice).toBe("none");
		expect(payload.tools).toEqual(actor.tools);
		expect(payload.messages.slice(0, -1)).toEqual(actor.messages.slice(0, -1));
		expect(payload.messages.at(-2)).toMatchObject({ role: "tool", content: [{ type: "text", text: "1 failing", cache_control: expect.anything() }] });
		expect(JSON.stringify(payload.messages.at(-1))).not.toContain("cache_control");
	});

	it("bedrock: keeps toolConfig (no toolChoice), same prefix, cachePoint after the tool result", async () => {
		const model = AMAZON_BEDROCK_MODELS["anthropic.claude-opus-4-8"] as unknown as AnyModel;
		const extra: SimpleStreamOptions = { env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" } };
		const actor = (await actorPayload(bedrockStream, model, extra)) as { system: unknown; toolConfig: unknown; messages: Blocks };
		const advisor = await advisorPayload(bedrockStream, model, extra);
		const payload = advisor.payload as typeof actor;
		expect(advisor.options.toolChoice).toBeUndefined();
		expect(payload.toolConfig).toBeDefined();
		expect(payload.toolConfig).toEqual(actor.toolConfig);
		expect(payload.system).toEqual(actor.system);
		expect(payload.messages.slice(0, -1)).toEqual(actor.messages.slice(0, -1));
		const results = payload.messages.at(-2)!.content;
		expect(results.at(-2)).toHaveProperty("toolResult");
		expect(results.at(-1)).toHaveProperty("cachePoint");
		expect(payload.messages.at(-1)!.content).toEqual([{ text: advisor.instruction }]);
	});
});
