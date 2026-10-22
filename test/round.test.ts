import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { CompleteFn } from "../src/advisors.ts";
import type { ModelLike, ModelLookup } from "../src/config-resolve.ts";
import { DEFAULT_CONFIG, DEFAULT_PRESET, type MoaConfig } from "../src/config.ts";
import { BASE_RULES, ROLE_PROMPTS } from "../src/roles.ts";
import { runRound, type MoaRecord, type RoundDeps, type RoundInput } from "../src/round.ts";
import { FRAMING_HEADER } from "../src/framing.ts";
import { ADVICE_REQUEST } from "../src/view.ts";
import { assistant, system, text, toolResult, user, usage } from "./fixtures.ts";

const sonnet: ModelLike = { provider: "anthropic", id: "sonnet" };
const gpt: ModelLike = { provider: "openai", id: "gpt" };
const models: ModelLookup<ModelLike> = {
	find: (provider, id) => [sonnet, gpt].find((m) => m.provider === provider && m.id === id),
	hasConfiguredAuth: () => true,
};

const council: MoaConfig = {
	...DEFAULT_CONFIG,
	roles: { planner: { promptFile: "/roles/planner.md" } },
	presets: {
		solo: DEFAULT_PRESET,
		council: {
			...DEFAULT_PRESET,
			advisors: [
				{ model: "openai/gpt", role: "planner", maxTokens: 256 },
				{ model: "current", role: "critic", stance: "against" },
			],
			framing: { anonymize: true, shuffle: false },
		},
	},
};

const messages = [system("You are pi."), user("Fix the test", 10), assistant([text("On it.")]), toolResult("bash", "1 failing", true)];

function setup(complete: CompleteFn<ModelLike>, overrides: Partial<RoundInput<ModelLike>> = {}) {
	const records: MoaRecord[] = [];
	const logs: string[] = [];
	const input: RoundInput<ModelLike> = { messages, config: council, presetName: "council", models, actor: sonnet, ...overrides };
	const deps: RoundDeps<ModelLike> = {
		complete,
		appendEntry: (type, data) => {
			expect(type).toBe("moa");
			records.push(data);
		},
		readPromptFile: (path) => (path === "/roles/planner.md" ? "Plan from file." : undefined),
		debug: (line) => logs.push(line),
		now: () => 1234,
	};
	return { input, deps, records, logs };
}

describe("runRound", () => {
	it("appends framed advice as a trailing user message and records the round", async () => {
		const contexts = new Map<string, Context>();
		const { input, deps, records } = setup(async (model, context) => {
			contexts.set(model.id, context);
			return assistant([text(`${model.id} says hi`)], { usage: usage(0.01) });
		});
		const snapshot = structuredClone(messages);
		const result = await runRound(input, deps);
		const out = result?.messages;

		expect(messages).toEqual(snapshot);
		expect(out).toHaveLength(messages.length + 1);
		expect(out?.slice(0, -1)).toEqual(messages);
		const advice = out?.at(-1);
		expect(advice).toMatchObject({ role: "user", timestamp: 1234 });
		const adviceText = (advice as { content: { text: string }[] }).content[0]!.text;
		expect(adviceText.startsWith(FRAMING_HEADER)).toBe(true);
		expect(adviceText).toContain("Advisor A (planner):\ngpt says hi");
		expect(adviceText).toContain("Advisor B (critic):\nsonnet says hi");
		expect(result?.advice).toBe(adviceText);

		expect(contexts.get("gpt")?.systemPrompt).toBe(`${BASE_RULES}\n\nPlan from file.`);
		expect(contexts.get("sonnet")?.systemPrompt).toContain(ROLE_PROMPTS.critic);
		expect(contexts.get("sonnet")?.systemPrompt).toContain("Stance: skeptical");
		expect(contexts.get("gpt")?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ preset: "council", turn: 10, step: 1 });
		expect(records[0]?.advisors.map((a) => [a.label, a.model, a.role, a.ok, a.costUsd])).toEqual([
			["A", "openai/gpt", "planner", true, 0.01],
			["B", "anthropic/sonnet", "critic", true, 0.01],
		]);
	});

	it("records but returns undefined when every advisor fails", async () => {
		const { input, deps, records } = setup(async () => {
			throw new Error("down");
		});
		expect(await runRound(input, deps)).toBeUndefined();
		expect(records[0]?.advisors.map((a) => a.error)).toEqual(["down", "down"]);
	});

	it("still returns advice when recording throws", async () => {
		const { input, deps, logs } = setup(async () => assistant([text("ok")]));
		deps.appendEntry = () => {
			throw new Error("disk full");
		};
		expect((await runRound(input, deps))?.messages).toHaveLength(messages.length + 1);
		expect(logs.some((l) => l.includes("disk full"))).toBe(true);
	});

	it("skips quietly when the preset does not resolve", async () => {
		const calls: string[] = [];
		const { input, deps, records, logs } = setup(async (m) => {
			calls.push(m.id);
			return assistant([text("ok")]);
		}, { actor: undefined });
		expect(await runRound(input, deps)).toBeUndefined();
		expect(calls).toEqual([]);
		expect(records).toEqual([]);
		expect(logs.some((l) => l.includes("round skipped"))).toBe(true);
	});

	it("gives each advisor slot a stable session id and the cache-marker payload hook", async () => {
		const seen = new Map<string, SimpleStreamOptions>();
		const { input, deps } = setup(
			async (model, _context, options) => {
				seen.set(model.id, options);
				return assistant([text("ok")]);
			},
			{ sessionId: "sess-1" },
		);
		input.config = { ...council, presets: { ...council.presets, council: { ...council.presets.council!, framing: { anonymize: true, shuffle: true } } } };
		await runRound(input, { ...deps, rng: () => 0 });
		expect(seen.get("gpt")?.sessionId).toBe("moa0-sess-1");
		expect(seen.get("sonnet")?.sessionId).toBe("moa1-sess-1");
		const hook = seen.get("gpt")?.onPayload;
		expect(hook).toBeTypeOf("function");
		const payload = {
			model: "claude",
			messages: [
				{ role: "user", content: [{ type: "text", text: "transcript" }, { type: "text", text: `\n\n${ADVICE_REQUEST}`, cache_control: { type: "ephemeral" } }] },
			],
		};
		expect(await hook!(payload, {} as never)).toEqual({
			model: "claude",
			messages: [
				{ role: "user", content: [{ type: "text", text: "transcript", cache_control: { type: "ephemeral" } }, { type: "text", text: `\n\n${ADVICE_REQUEST}` }] },
			],
		});
	});

	it("omits advisor session ids without a pi session id", async () => {
		const seen: SimpleStreamOptions[] = [];
		const { input, deps } = setup(async (_m, _c, options) => {
			seen.push(options);
			return assistant([text("ok")]);
		});
		await runRound(input, deps);
		expect(seen.every((o) => o.sessionId === undefined)).toBe(true);
	});

	it("skips an unknown preset", async () => {
		const { input, deps } = setup(async () => assistant([text("ok")]), { presetName: "nope" });
		expect(await runRound(input, deps)).toBeUndefined();
	});
});
