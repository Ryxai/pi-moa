import { describe, expect, it } from "vitest";
import { moveCacheMarker } from "../src/cache.ts";
import { FRAMING_HEADER } from "../src/framing.ts";
import { ADVICE_REQUEST, ADVICE_REQUEST_BLOCKS } from "../src/view.ts";

const ADVICE = `${FRAMING_HEADER}\nAdvice from 1 advisor. It may be wrong.\n\nAdvisor A (advisor):\nCheck the failing test first.`;
const CC = { type: "ephemeral" } as const;
const CC_LONG = { type: "ephemeral", ttl: "1h" } as const;

/** Moves and checks the input was not modified. */
function move(payload: unknown, texts: readonly string[] = [ADVICE]): unknown {
	const before = structuredClone(payload);
	const out = moveCacheMarker(payload, texts);
	expect(payload).toEqual(before);
	return out;
}

// Shapes as pi-ai 1.4.0 builds them: anthropic-messages.js buildParams/convertMessages
// (cache_control on system, last tool, last block of the last user/system message).
function anthropic(messages: unknown[]): Record<string, unknown> {
	return {
		model: "claude-sonnet-4-5",
		messages,
		max_tokens: 32000,
		stream: true,
		system: [{ type: "text", text: "You are pi.", cache_control: CC }],
		tools: [
			{ name: "read", description: "Read", input_schema: { type: "object", properties: {} } },
			{ name: "bash", description: "Bash", input_schema: { type: "object", properties: {} }, cache_control: CC },
		],
	};
}

const anthropicTurn = [
	{ role: "user", content: [{ type: "text", text: "Fix the failing test" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Run the tests.", signature: "sig" },
			{ type: "text", text: "Running the tests." },
			{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "npm test" } },
		],
	},
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "1 failing" }], is_error: true }] },
];

describe("moveCacheMarker: Anthropic Messages", () => {
	it("moves the marker from the advice block to the previous tool_result block", () => {
		const payload = anthropic([...anthropicTurn, { role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] }]);
		const out = move(payload) as ReturnType<typeof anthropic>;
		const messages = out.messages as { content: Record<string, unknown>[] }[];
		expect(messages[3]!.content[0]).toEqual({ type: "text", text: ADVICE });
		expect(messages[2]!.content[0]).toMatchObject({ type: "tool_result", cache_control: CC });
		// Nothing else changed: system, tools, earlier messages, other fields.
		expect({ ...out, messages: messages.slice(0, 2) }).toEqual({ ...payload, messages: anthropicTurn.slice(0, 2) });
	});

	it("keeps the marker's exact value (1h TTL)", () => {
		const payload = anthropic([anthropicTurn[0], { role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC_LONG }] }]);
		const out = move(payload) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[0]!.content[0]).toEqual({ type: "text", text: "Fix the failing test", cache_control: CC_LONG });
	});

	it("moves within one user message with several blocks", () => {
		const payload = anthropic([
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
					{ type: "text", text: ADVICE, cache_control: CC },
				],
			},
		]);
		const out = move(payload) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[0]!.content.map((b) => b.cache_control)).toEqual([undefined, CC, undefined]);
	});

	it("converts string content of the previous user message to a marked text block", () => {
		const payload = anthropic([
			{ role: "user", content: "Fix the failing test" },
			{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
		]);
		const out = move(payload) as { messages: { content: unknown }[] };
		expect(out.messages[0]!.content).toEqual([{ type: "text", text: "Fix the failing test", cache_control: CC }]);
	});

	it("skips thinking blocks and lands on tool_use when the advice follows an assistant message", () => {
		const assistantLast = {
			role: "assistant",
			content: [
				{ type: "text", text: "Done." },
				{ type: "tool_use", id: "t", name: "bash", input: {} },
				{ type: "redacted_thinking", data: "x" },
			],
		};
		const payload = anthropic([anthropicTurn[0], assistantLast, { role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] }]);
		const out = move(payload) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[1]!.content.map((b) => b.cache_control)).toEqual([undefined, CC, undefined]);
	});

	it("moves a marker that sits after the advice (pending system message flushed at the end)", () => {
		const payload = anthropic([
			...anthropicTurn,
			{ role: "user", content: [{ type: "text", text: ADVICE }] },
			{ role: "system", content: [{ type: "text", text: "Model changed.", cache_control: CC }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		]);
		const out = move(payload) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[4]!.content[0]).toEqual({ type: "text", text: "Model changed." });
		expect(out.messages[2]!.content[0]).toMatchObject({ cache_control: CC });
		expect(out.messages[5]).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
	});

	it("leaves the payload alone when no marker is on or after the advice", () => {
		const unmarked = anthropic([...anthropicTurn, { role: "user", content: [{ type: "text", text: ADVICE }] }]);
		expect(move(unmarked)).toBe(unmarked);
		// Advice not last, and the marker is before it.
		const before = anthropic([
			{ role: "user", content: [{ type: "text", text: "task", cache_control: CC }] },
			{ role: "user", content: [{ type: "text", text: ADVICE }] },
		]);
		expect(move(before)).toBe(before);
	});

	it("leaves the payload alone when the advice is absent or only similar", () => {
		const marked = (text: string) => anthropic([anthropicTurn[0], { role: "user", content: [{ type: "text", text, cache_control: CC }] }]);
		for (const text of ["Just a user message", `${ADVICE} `, FRAMING_HEADER, ADVICE.slice(0, -1)]) {
			const payload = marked(text);
			expect(move(payload)).toBe(payload);
		}
		const payload = marked(ADVICE);
		expect(move(payload, [])).toBe(payload);
		expect(move(payload, ["", "  "])).toBe(payload);
	});

	it("does not match advice text inside an assistant message or a tool result", () => {
		const payload = anthropic([
			{ role: "assistant", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: ADVICE }], cache_control: CC }] },
		]);
		expect(move(payload)).toBe(payload);
	});

	it("matches advice whose unpaired surrogates the adapter stripped", () => {
		const raw = `${ADVICE} \uD83D tail`;
		const payload = anthropic([anthropicTurn[0], { role: "user", content: [{ type: "text", text: `${ADVICE}  tail`, cache_control: CC }] }]);
		const out = move(payload, [raw]) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[0]!.content[0]).toMatchObject({ cache_control: CC });
	});

	it("removes the marker without adding one when nothing before the advice can carry it", () => {
		const payload = anthropic([
			{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
			{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
		]);
		const out = move(payload) as { messages: { content: Record<string, unknown>[] }[] };
		expect(JSON.stringify(out.messages)).not.toContain("cache_control");
		expect(out.messages[1]!.content[0]).toEqual({ type: "text", text: ADVICE });
		expect(out.messages[0]).toEqual((payload.messages as unknown[])[0]);
	});

	it("never adds a breakpoint: total marker count stays the same or drops", () => {
		const count = (value: unknown) => JSON.stringify(value).split('"cache_control"').length - 1;
		const payload = anthropic([...anthropicTurn, { role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] }]);
		expect(count(move(payload))).toBe(count(payload));
		const alreadyMarked = anthropic([
			{ role: "user", content: [{ type: "text", text: "task", cache_control: CC }] },
			{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
		]);
		expect(count(move(alreadyMarked))).toBe(count(alreadyMarked) - 1);
	});
});

// openai-completions.js buildParams + applyAnthropicCacheControl (cacheControlFormat "anthropic",
// e.g. OpenRouter anthropic/*): system message first, assistant content as a string, tool results
// as role "tool" with string content, cache_control on a text part.
function openaiChat(messages: unknown[]): Record<string, unknown> {
	return {
		model: "anthropic/claude-sonnet-4.5",
		messages: [{ role: "system", content: [{ type: "text", text: "You are pi.", cache_control: CC }] }, ...messages],
		stream: true,
		stream_options: { include_usage: true },
		prompt_cache_key: undefined,
		tools: [{ type: "function", function: { name: "bash", parameters: {} }, cache_control: CC }],
	};
}

describe("moveCacheMarker: OpenAI chat completions with cache_control", () => {
	const turn = [
		{ role: "user", content: "Fix the failing test" },
		{ role: "assistant", content: "Running the tests.", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
		{ role: "tool", content: "1 failing", tool_call_id: "c1" },
	];

	it("moves the marker onto the tool message (string content becomes a marked text part)", () => {
		const payload = openaiChat([...turn, { role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] }]);
		const out = move(payload) as { messages: Record<string, unknown>[] };
		expect(out.messages[3]).toEqual({ role: "tool", content: [{ type: "text", text: "1 failing", cache_control: CC }], tool_call_id: "c1" });
		expect(out.messages[4]).toEqual({ role: "user", content: [{ type: "text", text: ADVICE }] });
		expect(out.messages[0]).toEqual((payload.messages as unknown[])[0]);
	});

	it("skips image parts and system messages", () => {
		const payload = openaiChat([
			{ role: "user", content: [{ type: "text", text: "See image" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
			{ role: "system", content: "Tools changed." },
			{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
		]);
		const out = move(payload) as { messages: { content: unknown }[] };
		expect(out.messages[1]!.content).toEqual([
			{ type: "text", text: "See image", cache_control: CC },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
		]);
		expect(out.messages[2]!.content).toBe("Tools changed.");
	});

	it("skips an assistant message with only tool calls", () => {
		const payload = openaiChat([
			{ role: "user", content: "task" },
			{ role: "assistant", content: null, tool_calls: [] },
			{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] },
		]);
		const out = move(payload) as { messages: { content: unknown }[] };
		expect(out.messages[1]!.content).toEqual([{ type: "text", text: "task", cache_control: CC }]);
		expect(out.messages[2]!.content).toBeNull();
	});
});

// bedrock-converse-stream.js convertMessages: cachePoint element appended to the last user message.
function bedrock(messages: unknown[]): Record<string, unknown> {
	return {
		modelId: "us.anthropic.claude-sonnet-4-5",
		messages,
		system: [{ text: "You are pi." }, { cachePoint: { type: "default" } }],
		inferenceConfig: { maxTokens: 32000 },
	};
}
const POINT = { cachePoint: { type: "default" } };

describe("moveCacheMarker: Bedrock Converse", () => {
	const turn = [
		{ role: "user", content: [{ text: "Fix the failing test" }] },
		{ role: "assistant", content: [{ text: "Running." }, { toolUse: { toolUseId: "c1", name: "bash", input: {} } }] },
		{ role: "user", content: [{ toolResult: { toolUseId: "c1", content: [{ text: "1 failing" }], status: "error" } }] },
	];

	it("moves the cachePoint after the previous tool result", () => {
		const payload = bedrock([...turn, { role: "user", content: [{ text: ADVICE }, POINT] }]);
		const out = move(payload) as { messages: { content: unknown[] }[]; system: unknown };
		expect(out.messages[3]!.content).toEqual([{ text: ADVICE }]);
		expect(out.messages[2]!.content).toEqual([turn[2]!.content[0], POINT]);
		expect(out.system).toEqual(payload.system);
	});

	it("moves within one message and only into user messages", () => {
		const within = bedrock([{ role: "user", content: [{ text: "task" }, { text: ADVICE }, POINT] }]);
		expect((move(within) as { messages: { content: unknown[] }[] }).messages[0]!.content).toEqual([{ text: "task" }, POINT, { text: ADVICE }]);

		const afterAssistant = bedrock([turn[0], turn[1], { role: "user", content: [{ text: ADVICE }, POINT] }]);
		const out = move(afterAssistant) as { messages: { content: unknown[] }[] };
		expect(out.messages[0]!.content).toEqual([{ text: "Fix the failing test" }, POINT]);
		expect(out.messages[1]!.content).toEqual(turn[1]!.content);
	});

	it("does not duplicate an existing cachePoint and leaves unmarked payloads alone", () => {
		const payload = bedrock([{ role: "user", content: [{ text: "task" }, POINT] }, { role: "user", content: [{ text: ADVICE }, POINT] }]);
		const out = move(payload) as { messages: { content: unknown[] }[] };
		expect(out.messages).toEqual([{ role: "user", content: [{ text: "task" }, POINT] }, { role: "user", content: [{ text: ADVICE }] }]);

		const unmarked = bedrock([...turn, { role: "user", content: [{ text: ADVICE }] }]);
		expect(move(unmarked)).toBe(unmarked);
	});
});

describe("moveCacheMarker: advisor text view", () => {
	it("moves the marker off the advice request appended to the last user turn", () => {
		const payload = anthropic([
			{ role: "user", content: [{ type: "text", text: "Fix the test" }] },
			{ role: "assistant", content: [{ type: "text", text: "⟨tool bash({})⟩" }, { type: "text", text: "\n\n⟨result bash: ok⟩" }] },
			{ role: "user", content: [{ type: "text", text: ADVICE_REQUEST, cache_control: CC }] },
		]);
		const out = move(payload, ADVICE_REQUEST_BLOCKS) as { messages: { content: Record<string, unknown>[] }[] };
		expect(out.messages[1]!.content[1]).toMatchObject({ cache_control: CC });
		expect(out.messages[2]!.content[0]).toEqual({ type: "text", text: ADVICE_REQUEST });
	});
});

describe("moveCacheMarker: robustness", () => {
	it("returns unknown shapes unchanged", () => {
		const responses = { model: "gpt-5", input: [{ role: "user", content: [{ type: "input_text", text: ADVICE }] }], prompt_cache_key: "s" };
		const google = { contents: [{ role: "user", parts: [{ text: ADVICE }] }] };
		for (const payload of [responses, google, null, undefined, 42, "text", [], { messages: "nope" }]) {
			expect(moveCacheMarker(payload, [ADVICE])).toBe(payload);
		}
	});

	it("never throws on garbage", () => {
		const garbage: unknown[] = [
			{ messages: [null, 1, "x", [], { role: "user" }, { role: "user", content: [null, 1, { type: 5 }] }] },
			{ messages: [{ role: "user", content: [{ type: "text", text: ADVICE, cache_control: CC }] }] },
			{ modelId: "m", messages: [null, { role: "user", content: [{ text: ADVICE }, POINT] }] },
			{ modelId: "m", messages: [{ role: "user", content: [{ text: ADVICE }] }, { role: "user", content: [POINT] }] },
		];
		const trap = new Proxy(
			{},
			{
				get() {
					throw new Error("trap");
				},
				has() {
					throw new Error("trap");
				},
			},
		);
		garbage.push({ messages: [trap] }, { messages: [{ role: "user", content: [trap] }] });
		for (const payload of garbage) expect(() => moveCacheMarker(payload, [ADVICE])).not.toThrow();
		// A marker-only message after the advice would become empty: left alone.
		expect(moveCacheMarker(garbage[3], [ADVICE])).toBe(garbage[3]);
		// The only advice block: marker removed, nothing to move it to.
		expect(moveCacheMarker(garbage[1], [ADVICE])).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: ADVICE }] }] });
	});
});
