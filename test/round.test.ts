import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { CompleteFn } from "../src/advisors.ts";
import type { ModelLike, ModelLookup } from "../src/config-resolve.ts";
import { DEFAULT_CONFIG, DEFAULT_PRESET, type MoaConfig } from "../src/config.ts";
import { EFFORT_PROFILES } from "../src/effort.ts";
import { BASE_RULES, NATIVE_BASE_RULES, NO_RECONCILIATION, ROLE_PROMPTS, SYNTHESIS_RULES, withLengthLine } from "../src/roles.ts";
import { advisorView, appendAdvice, CAPPED_NOTE, cleanResult, isNoReconciliation, runRound, SYNTHESIS_MAX_TOKENS, type MoaRecord, type RoundDeps, type RoundInput } from "../src/round.ts";
import { ADVICE_REQUEST, adviceRequest, SYNTHESIS_REQUEST } from "../src/view.ts";
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

/** The text view's base rules at the default (medium) effort. */
const MEDIUM_RULES = withLengthLine(BASE_RULES, EFFORT_PROFILES.medium.lengthLine);

function setup(complete: CompleteFn<ModelLike>, overrides: Partial<RoundInput<ModelLike>> = {}) {
	const records: MoaRecord[] = [];
	const logs: string[] = [];
	const input: RoundInput<ModelLike> = {
		messages,
		config: council,
		presetName: "council",
		models,
		actor: sonnet,
		reason: "user_turn",
		turn: "10:abc",
		step: 1,
		...overrides,
	};
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
	it("runs the advisors in display order and records the round", async () => {
		const contexts = new Map<string, Context>();
		const { input, deps, records } = setup(async (model, context) => {
			contexts.set(model.id, context);
			return assistant([text(`${model.id} says hi`)], { usage: usage(0.01) });
		});
		const snapshot = structuredClone(messages);
		const result = await runRound(input, deps);

		expect(messages).toEqual(snapshot);
		expect(result?.interrupted).toBe(false);
		expect(result?.results.map((r) => [r.label, r.role, r.text])).toEqual([
			["A", "planner", "gpt says hi"],
			["B", "critic", "sonnet says hi"],
		]);

		expect(contexts.get("gpt")?.systemPrompt).toBe(`${MEDIUM_RULES}\n\nPlan from file.`);
		expect(contexts.get("gpt")?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		// "current" is the actor: native view, instructions in the trailing user message.
		const native = contexts.get("sonnet")!;
		expect(native.systemPrompt).toBeUndefined();
		expect(native.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "user"]);
		const instruction = (native.messages.at(-1)!.content as { text: string }[])[0]!.text;
		expect(instruction).toContain(NATIVE_BASE_RULES);
		expect(instruction).toContain(ROLE_PROMPTS.critic);
		expect(instruction).toContain("Stance: skeptical");
		expect(instruction.endsWith(ADVICE_REQUEST)).toBe(true);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ preset: "council", reason: "user_turn", turn: "10:abc", step: 1 });
		expect(records[0]).not.toHaveProperty("interrupted");
		expect(records[0]?.advisors.map((a) => [a.label, a.model, a.role, a.ok, a.costUsd])).toEqual([
			["A", "openai/gpt", "planner", true, 0.01],
			["B", "anthropic/sonnet", "critic", true, 0.01],
		]);
	});

	it("records and returns failures when every advisor fails", async () => {
		const { input, deps, records } = setup(async () => {
			throw new Error("down");
		});
		expect((await runRound(input, deps))?.results.every((r) => !r.ok)).toBe(true);
		expect(records[0]?.advisors.map((a) => a.error)).toEqual(["down", "down"]);
	});

	it("still returns advice when recording throws", async () => {
		const { input, deps, logs } = setup(async () => assistant([text("ok")]));
		deps.appendEntry = () => {
			throw new Error("disk full");
		};
		expect((await runRound(input, deps))?.results.every((r) => r.ok)).toBe(true);
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
		// Text view (gpt): per-slot id; native view (sonnet, the actor): the actor's own.
		expect(seen.get("gpt")?.sessionId).toBe("moa0-sess-1");
		expect(seen.get("sonnet")?.sessionId).toBe("sess-1");
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

	it("marks a round interrupted when the request is aborted during it", async () => {
		const controller = new AbortController();
		const { input, deps, records } = setup(async () => {
			controller.abort();
			return assistant([text("late")]);
		}, { signal: controller.signal, reason: "on_failure" });
		expect((await runRound(input, deps))?.interrupted).toBe(true);
		expect(records[0]).toMatchObject({ reason: "on_failure", interrupted: true });
	});

	it("consult: appends the question to every advisor's request, records it, and saves no entry without appendEntry", async () => {
		const contexts = new Map<string, Context>();
		const { input, deps, records } = setup(
			async (model, context) => {
				contexts.set(model.id, context);
				return assistant([text("ok")]);
			},
			{ reason: "consult", question: "Is the fixture wrong?" },
		);
		delete deps.appendEntry;
		const out = await runRound(input, deps);
		const request = adviceRequest("Is the fixture wrong?");
		expect(request).toBe(`${ADVICE_REQUEST}\n\nThe acting agent asks: Is the fixture wrong?`);
		const lastText = (c: Context) => (c.messages.at(-1)!.content as { text: string }[]).at(-1)!.text;
		expect(lastText(contexts.get("sonnet")!).endsWith(`\n\n${request}`)).toBe(true);
		expect(lastText(contexts.get("gpt")!)).toBe(`\n\n${request}`);
		expect(records).toEqual([]);
		expect(out?.record).toMatchObject({ preset: "council", reason: "consult", question: "Is the fixture wrong?", turn: "10:abc", step: 1 });
		expect(out?.record.advisors).toBe(out?.results);
	});

	it("skips an unknown preset", async () => {
		const { input, deps } = setup(async () => assistant([text("ok")]), { presetName: "nope" });
		expect(await runRound(input, deps)).toBeUndefined();
	});
});

describe("advisorView", () => {
	const preset = (context: Partial<typeof DEFAULT_PRESET.context>) => ({ ...DEFAULT_PRESET, context: { ...DEFAULT_PRESET.context, ...context } });
	const input = (extra: Partial<RoundInput<ModelLike>> = {}) => ({ actor: sonnet, config: council, ...extra });
	const slot = (model: ModelLike, extra = {}) => ({ model, config: { model: "x", role: "advisor", ...extra } });

	it.each([
		["auto", sonnet, "native"],
		["auto", gpt, "text"],
		["text", sonnet, "text"],
		["native", gpt, "native"],
	] as const)("view %s with advisor %o is %s", (view, model, expected) => {
		expect(advisorView(messages, slot(model), { input: input(), preset: preset({ view }) }).view).toBe(expected);
	});

	it("uses the text view when there is no actor", () => {
		expect(advisorView(messages, slot(sonnet), { input: input({ actor: undefined }), preset: preset({}) }).view).toBe("text");
	});

	it("appends project instructions to the text view's system prompt only when enabled", () => {
		const on = advisorView(messages, slot(gpt), { input: input({ projectInstructions: "## AGENTS.md\n\nUse tabs." }), preset: preset({}) });
		expect(on.context.systemPrompt).toBe(`${MEDIUM_RULES}\n\n${ROLE_PROMPTS.advisor}\n\n# Project instructions\n\n## AGENTS.md\n\nUse tabs.`);
		const off = advisorView(messages, slot(gpt), {
			input: input({ projectInstructions: "## AGENTS.md\n\nUse tabs." }),
			preset: preset({ projectInstructions: false }),
		});
		expect(off.context.systemPrompt).not.toContain("Project instructions");
		// The native view has them in the actor's own system prompt already.
		const native = advisorView(messages, slot(sonnet), { input: input({ projectInstructions: "x" }), preset: preset({}) });
		expect(JSON.stringify(native.context)).not.toContain("Project instructions");
	});

	it("trims the text view to the advisor's context window, and not without one", () => {
		const long = [...messages, ...Array.from({ length: 40 }, (_, i) => [assistant([text(`step ${i} ${"x".repeat(2000)}`)]), user(`more ${i}`, 20 + i)]).flat()];
		const small = { ...gpt, contextWindow: 20_000 };
		const trimmed = advisorView(long, slot(small, { maxTokens: 1000 }), { input: input(), preset: preset({}) });
		expect(JSON.stringify(trimmed.context)).toContain("earlier messages omitted");
		const texts = trimmed.context.messages.flatMap((m) => (m.content as { text: string }[]).map((b) => b.text));
		const chars = trimmed.context.systemPrompt!.length + texts.join("").length;
		expect(chars).toBeLessThanOrEqual((20_000 * 0.9 - 1000) * 4);
		const whole = advisorView(long, slot(gpt), { input: input(), preset: preset({}) });
		expect(JSON.stringify(whole.context)).not.toContain("omitted");
	});

	it("native: actor's thinking unless the slot sets one, actor's session id, nativeToolChoice, pi's projection", () => {
		const extra = { actorThinking: "medium" as const, thinkingBudgets: { medium: 5000 }, sessionId: "s", projection: { forceSystemPrompt: "FORCED" } };
		const native = advisorView(messages, slot(sonnet), { input: input(extra), preset: preset({}) });
		expect(native).toMatchObject({ thinking: "medium", thinkingBudgets: { medium: 5000 }, sessionId: "s", toolChoice: "omit" });
		expect(native.context.messages[0]).toMatchObject({ role: "system", content: "FORCED" });
		const own = advisorView(messages, slot(sonnet, { thinking: "low" }), { input: input(extra), preset: preset({ nativeToolChoice: "none" }) });
		expect(own).toMatchObject({ thinking: "low", toolChoice: "none" });
		const text = advisorView(messages, { ...slot(gpt), slot: 2 }, { input: input(extra), preset: preset({}) });
		// Text views think at the effort level (medium by default), never at the actor's level.
		expect(text.thinking).toBe("medium");
		expect(text.sessionId).toBe("moa2-s");
		expect(text.toolChoice).toBeUndefined();
		expect(text.thinkingBudgets).toBeUndefined();
	});

	it("gives the payload hook the right tail texts per view", () => {
		const native = advisorView(messages, slot(sonnet), { input: input(), preset: preset({}) });
		const instruction = (native.context.messages.at(-1)!.content as { text: string }[])[0]!.text;
		expect(native.tailTexts).toEqual([instruction]);
		expect(advisorView(messages, slot(gpt), { input: input(), preset: preset({}) }).tailTexts).toContain(ADVICE_REQUEST);
		const asked = advisorView(messages, slot(gpt), { input: input({ question: "Why?" }), preset: preset({}) });
		expect(asked.tailTexts).toEqual([adviceRequest("Why?"), `\n\n${adviceRequest("Why?")}`]);
	});
});

describe("appendAdvice", () => {
	it("appends the text as a trailing user message without touching the input", () => {
		const snapshot = structuredClone(messages);
		const out = appendAdvice(messages, "advice", 99);
		expect(messages).toEqual(snapshot);
		expect(out.slice(0, -1)).toEqual(messages);
		expect(out.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "advice" }], timestamp: 99 });
	});
});

describe("cleanResult", () => {
	const result = (text: string, extra: Partial<AdvisorResultLike> = {}): AdvisorResultLike => ({ label: "A", model: "m/x", role: "advisor", ok: true, text, latencyMs: 1, ...extra });
	type AdvisorResultLike = Parameters<typeof cleanResult>[0];

	it("reads the verdict line and keeps it in the text", () => {
		const clean = cleanResult(result("Verdict: revise\nRun the tests first."));
		expect(clean.verdict).toBe("revise");
		expect(clean.text).toBe("Verdict: revise\nRun the tests first.");
		expect(cleanResult(result("No verdict here."))).not.toHaveProperty("verdict");
	});

	it("appends the cut-off note to a capped reply, after sanitising", () => {
		const clean = cleanResult(result("Verdict: on-track\nKeep going and then", { capped: true }));
		expect(clean.text).toBe(`Verdict: on-track\nKeep going and then\n\n${CAPPED_NOTE}`);
		expect(clean.verdict).toBe("on-track");
		expect(clean.capped).toBe(true);
	});

	it("leaves failures alone", () => {
		const failed = { ...result(""), ok: false, text: undefined, error: "timeout" };
		expect(cleanResult(failed)).toBe(failed);
	});
});

describe("effort in rounds", () => {
	const optionsOf = (options: SimpleStreamOptions[]) => options.map((o) => [o.reasoning, o.maxTokens]);

	it("text advisors get the level's thinking and cap; native advisors keep the actor's thinking", async () => {
		const options: SimpleStreamOptions[] = [];
		const { input, deps } = setup(async (_m, _c, o) => {
			options.push(o);
			return assistant([text("Verdict: on-track\nok")]);
		}, { actorThinking: "low" });
		await runRound(input, deps);
		// Display order is fixed (shuffle: false): A = gpt (text), B = sonnet (native).
		expect(optionsOf(options)).toEqual([
			["medium", 256], // the slot's own maxTokens wins
			["low", 2048],
		]);
	});

	it("on_failure rounds run one level higher; a requested effort replaces that; maxEffort caps both", async () => {
		const levels = async (reason: RoundInput<ModelLike>["reason"], effort?: RoundInput<ModelLike>["effort"], maxEffort: MoaConfig["presets"][string]["maxEffort"] = "max") => {
			const options: SimpleStreamOptions[] = [];
			const config = { ...council, presets: { ...council.presets, council: { ...council.presets.council!, maxEffort } } };
			const { input, deps } = setup(async (_m, _c, o) => {
				options.push(o);
				return assistant([text("ok")]);
			}, { reason, effort, config });
			const round = await runRound(input, deps);
			return { options: optionsOf(options), efforts: round?.results.map((r) => r.effort) };
		};
		expect(await levels("on_failure")).toEqual({ options: [["high", 256], [undefined, 4096]], efforts: ["high", "high"] });
		expect(await levels("consult", "low")).toEqual({ options: [["low", 256], [undefined, 1024]], efforts: ["low", "low"] });
		expect(await levels("consult", "max", "medium")).toEqual({ options: [["medium", 256], [undefined, 2048]], efforts: ["medium", "medium"] });
	});

	it("a native slot with its own effort thinks at that level", async () => {
		const options: SimpleStreamOptions[] = [];
		const config = { ...council, presets: { ...council.presets, council: { ...council.presets.council!, advisors: [{ model: "current", effort: "high" as const }] } } };
		const { input, deps } = setup(async (_m, _c, o) => {
			options.push(o);
			return assistant([text("ok")]);
		}, { actorThinking: "low", config });
		await runRound(input, deps);
		expect(optionsOf(options)).toEqual([["high", 4096]]);
	});

	it("puts the level's length line in the prompt", async () => {
		const prompts: (string | undefined)[] = [];
		const { input, deps } = setup(async (_m, c) => {
			prompts.push(c.systemPrompt ?? (c.messages.at(-1)!.content as { text: string }[])[0]!.text);
			return assistant([text("ok")]);
		}, { reason: "on_failure" });
		await runRound(input, deps);
		for (const prompt of prompts) expect(prompt).toContain(EFFORT_PROFILES.high.lengthLine);
	});
});

describe("synthesis", () => {
	const withSynthesis = (extra: Partial<NonNullable<MoaConfig["presets"][string]["synthesis"]>> = {}, advisors = council.presets.council!.advisors): MoaConfig => ({
		...council,
		presets: { ...council.presets, council: { ...council.presets.council!, advisors, synthesis: { model: "openai/gpt", ...extra } } },
	});
	const replies = (synthesis: string) => async (_m: ModelLike, c: Context, _o?: SimpleStreamOptions) => {
		const last = (c.messages.at(-1)!.content as { text: string }[]).map((b) => b.text).join("");
		return last.includes(SYNTHESIS_REQUEST) ? assistant([text(synthesis)], { usage: usage(0.003) }) : assistant([text(`Verdict: revise\n${_m.id} says so`)], { usage: usage(0.01) });
	};

	it("runs after the advisors with their advice, and is recorded and returned when it reconciles", async () => {
		const contexts: Context[] = [];
		const complete = replies("Verdict: revise\nA is right.");
		const { input, deps, records } = setup(async (m, c, o) => {
			contexts.push(c);
			return complete(m, c, o);
		}, { config: withSynthesis({ maxTokens: 300, prompt: "Prefer the cheaper path." }), sessionId: "s" });
		const round = await runRound(input, deps);
		expect(round?.synthesis).toMatchObject({ label: "synthesis", role: "synthesis", ok: true, verdict: "revise", text: "Verdict: revise\nA is right.", costUsd: 0.003 });
		expect(records[0]?.synthesis).toEqual(round?.synthesis);
		const synthesisContext = contexts.at(-1)!;
		expect(synthesisContext.systemPrompt).toBe(`${SYNTHESIS_RULES}\n\nPrefer the cheaper path.`);
		const request = (synthesisContext.messages.at(-1)!.content as { text: string }[]).at(-1)!.text;
		expect(request).toContain(SYNTHESIS_REQUEST);
		expect(request).toContain("Advisor A (planner):\nVerdict: revise\ngpt says so");
		expect(request).toContain("Advisor B (critic):\nVerdict: revise\nsonnet says so");
		expect(deps.now).toBeDefined();
	});

	it("uses its own cap and thinking, a session id after the advisor slots, and no project instructions", async () => {
		const options: SimpleStreamOptions[] = [];
		const { input, deps } = setup(async (_m, c, o) => {
			options.push(o);
			return replies("x")(_m, c, o);
		}, { config: withSynthesis({ thinking: "low" }), sessionId: "s", projectInstructions: "## AGENTS.md\n\nTabs." });
		await runRound(input, deps);
		expect(options.at(-1)).toMatchObject({ maxTokens: SYNTHESIS_MAX_TOKENS, reasoning: "low", sessionId: "moa2-s" });
	});

	it("is silent when it finds nothing to reconcile", async () => {
		const { input, deps, records } = setup(replies("No reconciliation needed."), { config: withSynthesis() });
		const round = await runRound(input, deps);
		expect(round?.synthesis).toMatchObject({ ok: true, silent: true });
		expect(round?.synthesis?.text).toBeUndefined();
		expect(records[0]?.synthesis?.silent).toBe(true);
		for (const variant of ["no reconciliation needed", "**No reconciliation needed.**", " No reconciliation needed! "]) expect(isNoReconciliation(variant)).toBe(true);
		expect(isNoReconciliation("No reconciliation needed, except that A is wrong.")).toBe(false);
		expect(NO_RECONCILIATION).toBe("No reconciliation needed.");
	});

	it("does not run with fewer than two answering advisors", async () => {
		let calls = 0;
		const { input, deps } = setup(async (m, c, o) => {
			calls++;
			return m.id === "gpt" && !JSON.stringify(c).includes(SYNTHESIS_REQUEST) ? assistant([], { stopReason: "error", errorMessage: "down" }) : replies("x")(m, c, o);
		}, { config: withSynthesis() });
		const round = await runRound(input, deps);
		expect(calls).toBe(2);
		expect(round?.synthesis).toBeUndefined();
		const solo = setup(replies("x"), { config: withSynthesis({}, [{ model: "current" }]) });
		await runRound(solo.input, solo.deps);
		expect(solo.records[0]?.synthesis).toBeUndefined();
	});

	it("records a failed synthesis without losing the advisors' advice", async () => {
		const { input, deps } = setup(async (m, c, o) => {
			const last = (c.messages.at(-1)!.content as { text: string }[]).map((b) => b.text).join("");
			if (last.includes(SYNTHESIS_REQUEST)) throw new Error("boom");
			return replies("x")(m, c, o);
		}, { config: withSynthesis() });
		const round = await runRound(input, deps);
		expect(round?.results.every((r) => r.ok)).toBe(true);
		expect(round?.synthesis).toMatchObject({ ok: false, error: "boom" });
	});
});
