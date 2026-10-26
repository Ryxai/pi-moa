import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryRenderer, ExtensionAPI, ExtensionCommandContext, ExtensionVirtualModel, ToolDefinition } from "@earendil-works/pi-coding-agent";
import moa from "../src/index.ts";
import { EFFORT_PROFILES } from "../src/effort.ts";
import { STALE_NOTE } from "../src/framing.ts";
import { RECORD_ENTRY, type MoaRecord } from "../src/round.ts";
import { STATE_ENTRY, type EntryLike } from "../src/state.ts";
import { ADVICE_REQUEST } from "../src/view.ts";
import { assistant, fakeTheme, system, text, toolResult, user, usage } from "./fixtures.ts";
import type { AgentMessage } from "../src/view.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Note = { message: string; type: string };

interface Harness {
	agentDir: string;
	entries: EntryLike[];
	notes: Note[];
	status: Map<string, string | undefined>;
	ctx: ExtensionCommandContext;
	handlers: Map<string, Handler>;
	run(args: string): Promise<void>;
	emit(event: string, payload?: unknown): Promise<unknown>;
	lastNote(): Note | undefined;
	auth: { ok: boolean };
	llm: { reply: (model: { id: string }) => Promise<unknown>; options: unknown[]; contexts: Context[] };
	working: (string | undefined)[];
	piState: { blockImages: boolean; thinking: string };
	/** Registered tools by name, the active set, and every `setActiveTools` call. */
	tools: { registered: Map<string, ToolDefinition>; active: string[]; sets: string[][] };
	entryRenderers: Map<string, EntryRenderer>;
	messageRenderers: Map<string, unknown>;
	/** Registered virtual models by id (all under provider `moa`), and every registration call. */
	virtual: Map<string, ExtensionVirtualModel<unknown>>;
	registrations: string[];
	/** `sendUserMessage` calls. */
	sent: { content: unknown; options: unknown }[];
	/** The selected model (`ctx.model`) and whether the agent is idle. */
	sel: { model: TestModel | undefined; idle: boolean; pending: boolean };
	/** Selects `next` as pi does: updates `ctx.model`, then emits `model_select`. */
	select(next: TestModel, source?: string): Promise<unknown>;
}

interface TestModel {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
}

const model: TestModel = { provider: "anthropic", id: "sonnet" };
const gpt: TestModel = { provider: "openai", id: "gpt", reasoning: true };
const virtualModel = (id: string): TestModel => ({ provider: "moa", id, api: "pi-virtual" });

async function setup(globalConfig?: unknown): Promise<Harness> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-moa-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (globalConfig !== undefined) await writeFile(join(agentDir, "moa.json"), JSON.stringify(globalConfig));
	const virtual = new Map<string, ExtensionVirtualModel<unknown>>();
	const registrations: string[] = [];
	const sent: { content: unknown; options: unknown }[] = [];
	const sel: { model: TestModel | undefined; idle: boolean; pending: boolean } = { model, idle: true, pending: false };
	const entries: EntryLike[] = [];
	const notes: Note[] = [];
	const status = new Map<string, string | undefined>();
	const handlers = new Map<string, Handler>();
	const auth = { ok: true };
	const llm = {
		reply: async (_model: { id: string }): Promise<unknown> => assistant([text("Check the failing test first.")]),
		options: [] as unknown[],
		contexts: [] as Context[],
	};
	const working: (string | undefined)[] = [];
	const piState = { blockImages: false, thinking: "medium" };
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const entryRenderers = new Map<string, EntryRenderer>();
	const messageRenderers = new Map<string, unknown>();
	const tools = { registered: new Map<string, ToolDefinition>(), active: ["read", "bash", "edit", "write"], sets: [] as string[][] };
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			tools.registered.set(tool.name, tool);
			if (tool.defaultActive !== false) tools.active.push(tool.name);
		},
		getActiveTools: () => [...tools.active],
		setActiveTools: (names: string[]) => {
			tools.sets.push(names);
			tools.active = [...names];
		},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (_name: string, options: typeof command) => {
			command = options;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getSettings: () => ({ images: { blockImages: piState.blockImages }, thinkingBudgets: { low: 3000 } }),
		getThinkingLevel: () => piState.thinking,
		registerEntryRenderer: (customType: string, renderer: EntryRenderer) => entryRenderers.set(customType, renderer),
		registerMessageRenderer: (customType: string, renderer: unknown) => messageRenderers.set(customType, renderer),
		registerVirtualModel: (definition: ExtensionVirtualModel<unknown>) => {
			registrations.push(definition.id);
			virtual.set(definition.id, definition);
		},
		unregisterVirtualModel: (_provider: string, id: string) => virtual.delete(id),
		sendUserMessage: (content: unknown, options: unknown) => sent.push({ content, options }),
	};
	await moa(pi as unknown as ExtensionAPI);
	const catalog = [model, gpt];
	const ctx = {
		cwd: join(agentDir, "project"),
		hasUI: true,
		get model() {
			return sel.model;
		},
		mode: "tui",
		isIdle: () => sel.idle,
		hasPendingMessages: () => sel.pending,
		isProjectTrusted: () => false,
		modelRegistry: {
			find: (provider: string, id: string) =>
				catalog.find((m) => m.provider === provider && m.id === id) ??
				(provider === "moa" && virtual.has(id) ? virtualModel(id) : undefined),
			getAll: () => [...catalog, ...[...virtual.keys()].map(virtualModel)],
			hasConfiguredAuth: () => auth.ok,
			streamSimple: (m: { id: string }, context: Context, options: unknown) => {
				llm.options.push(options);
				llm.contexts.push(context);
				return { result: () => llm.reply(m) };
			},
		},
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
		ui: {
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
			notify: (message: string, type = "info") => notes.push({ message, type }),
			setWorkingMessage: (message?: string) => working.push(message),
		},
	} as unknown as ExtensionCommandContext;
	return {
		agentDir,
		entries,
		notes,
		status,
		ctx,
		handlers,
		run: (args) => command!.handler(args, ctx),
		emit: async (event, payload = {}) => handlers.get(event)?.(payload, ctx),
		lastNote: () => notes.at(-1),
		auth,
		llm,
		working,
		piState,
		tools,
		entryRenderers,
		messageRenderers,
		virtual,
		registrations,
		sent,
		sel,
		select: async (next, source = "set") => {
			const previousModel = sel.model;
			sel.model = next;
			return handlers.get("model_select")?.({ type: "model_select", model: next, previousModel, source }, ctx);
		},
	};
}

const stateEntries = (h: Harness) => h.entries.filter((e) => e.customType === STATE_ENTRY).map((e) => e.data);
const writeGlobal = (h: Harness, data: unknown) => writeFile(join(h.agentDir, "moa.json"), JSON.stringify(data));

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterAll(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

let h: Harness;
beforeEach(async () => {
	h = await setup();
	await h.emit("session_start");
});

describe("/moa on|off", () => {
	it("persists state and sets/clears the status line", async () => {
		await h.run("on");
		expect(stateEntries(h)).toEqual([{ enabled: true, preset: "solo" }]);
		expect(h.status.get("moa")).toBe("moa:solo");
		await h.run("off");
		expect(stateEntries(h)).toEqual([{ enabled: true, preset: "solo" }, { enabled: false }]);
		expect(h.status.get("moa")).toBeUndefined();
	});

	it("does not append when the state is unchanged", async () => {
		await h.run("off");
		await h.run("on");
		await h.run("on solo");
		expect(stateEntries(h)).toEqual([{ enabled: true, preset: "solo" }]);
	});

	it.each(["nope", "constructor", "toString", "__proto__"])("rejects unknown preset %j", async (name) => {
		await h.run(`on ${name}`);
		expect(h.lastNote()).toMatchObject({ type: "error" });
		expect(h.lastNote()?.message).toContain(`unknown preset "${name}"`);
		expect(stateEntries(h)).toEqual([]);
	});

	it("refuses a preset whose model cannot be resolved", async () => {
		await writeGlobal(h, { presets: { far: { advisors: [{ model: "openai/missing" }] } } });
		await h.run("reload");
		await h.run("on far");
		expect(h.lastNote()?.message).toContain('model "openai/missing" not found');
		expect(stateEntries(h)).toEqual([]);
	});
});

describe("session restore", () => {
	it("restores the latest state from the branch", async () => {
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "solo" } });
		await h.emit("session_start");
		expect(h.status.get("moa")).toBe("moa:solo");
	});

	it("restores as off with a warning when the preset is gone", async () => {
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "gone" } });
		await h.emit("session_start");
		expect(h.status.get("moa")).toBeUndefined();
		expect(h.lastNote()).toMatchObject({ type: "warning" });
		expect(h.lastNote()?.message).toContain("restored as off");
	});

	it("persists an explicit off after a restore that was forced off", async () => {
		await writeGlobal(h, { presets: { council: { timeoutMs: 5000 } } });
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "council" } });
		h.auth.ok = false;
		await h.emit("session_start");
		expect(h.lastNote()?.message).toContain("restored as off");
		await h.run("off");
		expect(stateEntries(h).at(-1)).toEqual({ enabled: false });
		h.auth.ok = true;
		await h.emit("session_start");
		expect(h.status.get("moa")).toBeUndefined();
	});

	it("does not rewrite the branch when a restore is forced off", async () => {
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "solo" } });
		h.auth.ok = false;
		await h.emit("session_start");
		expect(stateEntries(h)).toEqual([{ enabled: true, preset: "solo" }]);
		h.auth.ok = true;
		await h.emit("session_start");
		expect(h.status.get("moa")).toBe("moa:solo");
	});
});

describe("/moa reload", () => {
	it("turns MoA off when the active preset is no longer usable", async () => {
		await writeGlobal(h, { presets: { council: { timeoutMs: 5000 } } });
		await h.run("reload");
		await h.run("on council");
		expect(h.status.get("moa")).toBe("moa:council");
		await writeGlobal(h, {});
		await h.run("reload");
		expect(h.status.get("moa")).toBeUndefined();
		expect(stateEntries(h).at(-1)).toEqual({ enabled: false });
		expect(h.notes.some((n) => n.type === "warning" && n.message.includes('"council" is no longer usable'))).toBe(true);
		await h.run("");
		expect(h.lastNote()?.message).toMatch(/^MoA off/);
	});
});

describe("/moa init", () => {
	it("writes defaults once and never overwrites", async () => {
		const file = join(h.agentDir, "moa.json");
		await h.run("init");
		expect(JSON.parse(await readFile(file, "utf8")).defaultPreset).toBe("solo");
		await writeFile(file, '{"mine":true}');
		await h.run("init");
		expect(await readFile(file, "utf8")).toBe('{"mine":true}');
		expect(h.lastNote()?.message).toContain("already exists");
	});
});

describe("other commands and hooks", () => {
	it("status reports on with the preset", async () => {
		await h.run("on");
		await h.run("");
		expect(h.lastNote()?.message).toMatch(/^MoA on · preset solo/);
	});
});

describe("context_with_system", () => {
	const event = () => ({ type: "context_with_system", messages: [system("You are pi."), user("Fix the test")] });
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY).map((e) => e.data as { advisors: { ok: boolean }[] });

	it("passes through while off", async () => {
		expect(await h.emit("context_with_system", event())).toBeUndefined();
		expect(records()).toEqual([]);
		expect(h.working).toEqual([]);
	});

	it("appends advice as the last user message without touching the original", async () => {
		await h.run("on");
		const e = event();
		const snapshot = structuredClone(e.messages);
		const result = (await h.emit("context_with_system", e)) as { messages: { role: string; content: unknown }[] };
		expect(e.messages).toEqual(snapshot);
		expect(result.messages.slice(0, -1)).toEqual(snapshot);
		const advice = result.messages.at(-1)!;
		expect(advice.role).toBe("user");
		expect(JSON.stringify(advice.content)).toContain("Advisor A (advisor):\\nCheck the failing test first.");
		expect(records()).toHaveLength(1);
		expect(records()[0]?.advisors[0]?.ok).toBe(true);
		expect(h.working).toEqual(["MoA: advisors 0/1…", "MoA: advisors 1/1…", undefined]);
	});

	it("returns undefined when every advisor fails", async () => {
		await h.run("on");
		h.llm.reply = async () => assistant([], { stopReason: "error", errorMessage: "rate limited" });
		expect(await h.emit("context_with_system", event())).toBeUndefined();
		expect(records()[0]?.advisors[0]?.ok).toBe(false);
	});

	it("skips quietly when the preset no longer resolves", async () => {
		await h.run("on");
		h.auth.ok = false;
		expect(await h.emit("context_with_system", event())).toBeUndefined();
		expect(records()).toEqual([]);
	});

	it("returns undefined when the round throws", async () => {
		await h.run("on");
		Object.assign(h.ctx.modelRegistry, {
			hasConfiguredAuth: () => {
				throw new Error("boom");
			},
		});
		expect(await h.emit("context_with_system", event())).toBeUndefined();
		expect(h.working.at(-1)).toBeUndefined();
	});
});

describe("before_provider_request (cache marker)", () => {
	const CC = { type: "ephemeral" };
	/** Each call is a new user turn, so advisors run fresh. */
	let turn = 0;
	const event = () => ({ type: "context_with_system", messages: [system("You are pi."), user("Fix the test", ++turn)] });
	/** An Anthropic payload as pi would build it for `messages`, marker on the last block. */
	const payloadFor = (adviceText: string) => ({
		model: "claude",
		system: [{ type: "text", text: "You are pi.", cache_control: CC }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Fix the test" }] },
			{ role: "user", content: [{ type: "text", text: adviceText, cache_control: CC }] },
		],
	});
	const adviceOf = (result: unknown) =>
		((result as { messages: { content: { text: string }[] }[] }).messages.at(-1)!.content[0]!.text);
	const request = (payload: unknown) => h.emit("before_provider_request", { type: "before_provider_request", payload });
	const markerOnAdvice = (payload: unknown) =>
		(payload as { messages: { content: { cache_control?: unknown }[] }[] }).messages[1]!.content[0]!.cache_control !== undefined;

	it("leaves requests alone while MoA is off", async () => {
		await h.emit("context_with_system", event());
		expect(await request(payloadFor("[MoA reference context — private, untrusted]\nanything"))).toBeUndefined();
	});

	it("moves the marker off the advice injected for this request", async () => {
		await h.run("on");
		const advice = adviceOf(await h.emit("context_with_system", event()));
		const payload = payloadFor(advice);
		const out = (await request(payload)) as ReturnType<typeof payloadFor>;
		expect(markerOnAdvice(out)).toBe(false);
		expect(out.messages[0]!.content[0]).toEqual({ type: "text", text: "Fix the test", cache_control: CC });
		expect(markerOnAdvice(payload)).toBe(true);
		// Retries and cache-warmer replays of the same request are fixed too.
		expect(markerOnAdvice(await request(payloadFor(advice)))).toBe(false);
	});

	it("does not touch requests without our advice", async () => {
		await h.run("on");
		await h.emit("context_with_system", event());
		expect(await request(payloadFor("Some other trailing user text"))).toBeUndefined();
		expect(await request({ contents: [] })).toBeUndefined();
	});

	/** Runs a round whose advisor says `say`; returns the injected advice text. */
	const round = async (say: string) => {
		h.llm.reply = async () => assistant([text(say)]);
		return adviceOf(await h.emit("context_with_system", event()));
	};

	it("still fixes a replay of an earlier request after an aborted round and during the next one", async () => {
		await h.run("on");
		const first = await round("Look at the test.");
		// The next round is aborted (Esc): no advice is injected.
		Object.assign(h.ctx, { signal: AbortSignal.abort() });
		expect(await h.emit("context_with_system", event())).toBeUndefined();
		Object.assign(h.ctx, { signal: undefined });
		const second = await round("Now the config.");
		// A cache-warmer replay of the first request (fired while later rounds ran) is still fixed.
		expect(markerOnAdvice(await request(payloadFor(first)))).toBe(false);
		expect(markerOnAdvice(await request(payloadFor(second)))).toBe(false);
	});

	it("recognises the last three injected advice texts", async () => {
		await h.run("on");
		const advice = [await round("one"), await round("two"), await round("three"), await round("four")];
		expect(await request(payloadFor(advice[0]!))).toBeUndefined();
		for (const text of advice.slice(1)) expect(markerOnAdvice(await request(payloadFor(text)))).toBe(false);
		// Rounds without advice (off, failures) do not evict anything.
		await h.run("off");
		await h.emit("context_with_system", event());
		expect(markerOnAdvice(await request(payloadFor(advice[3]!)))).toBe(false);
	});

	it("forgets advice on session change", async () => {
		await h.run("on");
		const advice = await round("Fresh advice.");
		await h.emit("session_start");
		expect(await request(payloadFor(advice))).toBeUndefined();
		await h.emit("context_with_system", event());
		const again = await round("Again.");
		await h.emit("session_tree");
		expect(await request(payloadFor(again))).toBeUndefined();
	});

	it("gives native advisors the actor's session id, text advisors a per-slot one, and the payload hook", async () => {
		await h.run("on");
		await h.emit("context_with_system", event());
		const native = h.llm.options.at(-1) as { sessionId?: string; onPayload?: unknown };
		expect(native.sessionId).toBe("session-1");
		expect(native.onPayload).toBeTypeOf("function");
		await writeGlobal(h, { presets: { solo: { context: { view: "text" } } } });
		await h.run("reload");
		await h.emit("context_with_system", event());
		expect((h.llm.options.at(-1) as { sessionId?: string }).sessionId).toBe("moa0-session-1");
	});
});

describe("triggers and the advice cache", () => {
	type Out = { messages: { role: string; content: { text: string }[] }[] } | undefined;
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY).map((e) => e.data as MoaRecord);
	const calls = () => h.llm.options.length;
	const adviceOf = (out: unknown) => (out as Out)?.messages.at(-1)?.content[0]?.text;
	/** The transcript after `results.length` tool steps of the turn started by `prompt`; true = errored. */
	const transcript = (results: boolean[], prompt = "Fix the test", ts = 100) => [
		system("You are pi."),
		user(prompt, ts),
		...results.flatMap((isError, i) => [
			assistant([{ type: "toolCall" as const, id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }], { stopReason: "toolUse" }),
			{ ...toolResult("bash", isError ? "failed" : "ok", isError), toolCallId: `c${i}` },
		]),
	];
	const step = async (messages: unknown[]) => adviceOf(await h.emit("context_with_system", { type: "context_with_system", messages }));
	const usePreset = async (preset: Record<string, unknown>) => {
		await writeGlobal(h, { presets: { solo: preset } });
		await h.run("reload");
		await h.run("on");
	};
	let n = 0;
	beforeEach(() => {
		n = 0;
		h.llm.reply = async () => assistant([text(`advice ${++n}`)]);
	});

	it("user_turn runs once, then reuses the advice with the stale note after tool activity", async () => {
		await h.run("on");
		const first = await step(transcript([]));
		expect(first).toContain("advice 1");
		expect(first).not.toContain(STALE_NOTE);
		const later = await step(transcript([false, false]));
		expect(later).toContain("advice 1");
		expect(later).toContain(STALE_NOTE);
		expect(calls()).toBe(1);
		expect(records().map((r) => [r.reason, r.step])).toEqual([["user_turn", 0]]);
	});

	it("every_n runs at step 0 and every Nth step and reuses in between", async () => {
		await usePreset({ triggers: [{ every_n: 2 }] });
		const texts = [];
		for (let i = 0; i <= 4; i++) texts.push(await step(transcript(Array(i).fill(false))));
		expect(calls()).toBe(3);
		expect(records().map((r) => [r.reason, r.step])).toEqual([["every_n", 0], ["every_n", 2], ["every_n", 4]]);
		expect(texts[1]).toContain("advice 1");
		expect(texts[3]).toContain("advice 2");
		expect(texts[3]).toContain(STALE_NOTE);
		expect(texts[4]).not.toContain(STALE_NOTE);
	});

	it("with only on_failure, gives no advice until N errors in a row", async () => {
		await usePreset({ triggers: ["on_failure"], onFailure: { consecutiveErrors: 2, repeatedCalls: 3 } });
		expect(await step(transcript([]))).toBeUndefined();
		expect(await step(transcript([true]))).toBeUndefined();
		expect(calls()).toBe(0);
		expect(await step(transcript([true, true]))).toContain("advice 1");
		expect(records().map((r) => [r.reason, r.step])).toEqual([["on_failure", 2]]);
		const after = await step(transcript([true, true, false]));
		expect(after).toContain("advice 1");
		expect(after).toContain(STALE_NOTE);
		expect(calls()).toBe(1);
	});

	it("an interrupted on_failure round fires again on the next step", async () => {
		await usePreset({ triggers: ["on_failure"], onFailure: { consecutiveErrors: 2, repeatedCalls: 9 } });
		const controller = new AbortController();
		Object.assign(h.ctx, { signal: controller.signal });
		h.llm.reply = async () => {
			controller.abort();
			return assistant([text("too late")]);
		};
		expect(await step(transcript([true, true]))).toBeUndefined();
		Object.assign(h.ctx, { signal: undefined });
		h.llm.reply = async () => assistant([text("fresh")]);
		expect(await step(transcript([true, true, true]))).toContain("fresh");
		expect(await step(transcript([true, true, true, true]))).toContain(STALE_NOTE);
		expect(records().map((r) => [r.step, r.interrupted ?? false])).toEqual([[2, true], [3, false]]);
	});

	it("keeps the turn's advice, marked stale, after compaction removes the user message", async () => {
		await h.run("on");
		expect(await step(transcript([]))).toContain("advice 1");
		const compacted = [
			system("You are pi."),
			{ role: "compactionSummary", summary: "Fixing the test.", tokensBefore: 5000, timestamp: 150 },
			...transcript([false]).slice(2),
		];
		const out = await step(compacted);
		expect(out).toContain("advice 1");
		expect(out).toContain(STALE_NOTE);
		expect(calls()).toBe(1);
	});

	it("falls back to the turn's advice when a round cannot run", async () => {
		await usePreset({ triggers: ["user_turn", "every_step"] });
		await step(transcript([]));
		h.auth.ok = false;
		const out = await step(transcript([false]));
		expect(out).toContain("advice 1");
		expect(out).toContain(STALE_NOTE);
	});

	it("on_failure fires on repeated identical calls", async () => {
		await usePreset({ triggers: ["on_failure"], onFailure: { consecutiveErrors: 9, repeatedCalls: 2 } });
		const same = assistant([{ type: "toolCall", id: "x", name: "read", arguments: { path: "a", limit: 5 } }], { stopReason: "toolUse" });
		const reordered = assistant([{ type: "toolCall", id: "y", name: "read", arguments: { limit: 5, path: "a" } }], { stopReason: "toolUse" });
		expect(await step([...transcript([]), same, toolResult("read", "ok")])).toBeUndefined();
		expect(await step([...transcript([]), same, toolResult("read", "ok"), reordered, toolResult("read", "ok")])).toContain("advice 1");
		expect(records()[0]).toMatchObject({ reason: "on_failure", step: 2 });
	});

	it("a retried request for the same step reuses the advice without calling advisors", async () => {
		await h.run("on");
		const first = await step(transcript([]));
		expect(await step(transcript([]))).toBe(first);
		// A retry after an error response (pi omits it; skipped even when present).
		const failed = assistant([text("partial")], { stopReason: "error", errorMessage: "overloaded" });
		expect(await step([...transcript([]), failed])).toBe(first);
		expect(calls()).toBe(1);
		expect(records()).toHaveLength(1);
	});

	it("a retried step that produced no advice is not re-run", async () => {
		await h.run("on");
		h.llm.reply = async () => assistant([], { stopReason: "error", errorMessage: "rate limited" });
		expect(await step(transcript([]))).toBeUndefined();
		expect(await step(transcript([]))).toBeUndefined();
		expect(calls()).toBe(1);
	});

	it("never caches an interrupted round", async () => {
		await h.run("on");
		const controller = new AbortController();
		Object.assign(h.ctx, { signal: controller.signal });
		h.llm.reply = async () => {
			controller.abort();
			return assistant([text("too late")]);
		};
		expect(await step(transcript([]))).toBeUndefined();
		expect(records()[0]).toMatchObject({ reason: "user_turn", interrupted: true });
		Object.assign(h.ctx, { signal: undefined });
		h.llm.reply = async () => assistant([text("fresh")]);
		expect(await step(transcript([]))).toContain("fresh");
		expect(calls()).toBe(2);
		expect(records()).toHaveLength(2);
	});

	it("a new user message (including steering) starts a fresh round", async () => {
		await h.run("on");
		await step(transcript([]));
		expect(calls()).toBe(1);
		const steered = [...transcript([false]), user("Actually, use the other file", 200)];
		const out = await step(steered);
		expect(out).toContain("advice 2");
		expect(out).not.toContain(STALE_NOTE);
		expect(await step(transcript([], "Next task", 300))).toContain("advice 3");
		expect(records().map((r) => r.turn)).toEqual([expect.stringMatching(/^100:/), expect.stringMatching(/^200:/), expect.stringMatching(/^300:/)]);
	});

	it("clears the cache on session change", async () => {
		await h.run("on");
		await step(transcript([]));
		expect(await step(transcript([false]))).toContain("advice 1");
		await h.emit("session_tree");
		expect(await step(transcript([false]))).toBeUndefined();
		expect(calls()).toBe(1);
	});

	it("tracks reused advice text for the cache-marker fix", async () => {
		await h.run("on");
		await step(transcript([]));
		const stale = (await step(transcript([false])))!;
		const payload = {
			model: "claude",
			messages: [
				{ role: "user", content: [{ type: "text", text: "Fix the test" }] },
				{ role: "user", content: [{ type: "text", text: stale, cache_control: { type: "ephemeral" } }] },
			],
		};
		const out = (await h.emit("before_provider_request", { type: "before_provider_request", payload })) as typeof payload;
		expect(out.messages[1]!.content[0]).not.toHaveProperty("cache_control");
		expect(out.messages[0]!.content[0]).toHaveProperty("cache_control");
	});
});

describe("advisor views", () => {
	const messages = (prompt = "Fix the test", ts = 100) => [system("You are pi."), user(prompt, ts)];
	const step = (m: unknown[]) => h.emit("context_with_system", { type: "context_with_system", messages: m });
	const agentStart = (contextFiles: { path: string; content: string }[]) => {
		const systemPromptOptions = { contextFiles };
		return { event: { type: "before_agent_start", systemPromptOptions }, systemPromptOptions };
	};

	it("gives a \"current\" advisor the actor's own request (native view) by default", async () => {
		await h.run("on");
		await step(messages());
		const context = h.llm.contexts.at(-1)!;
		expect(context.systemPrompt).toBeUndefined();
		expect(context.messages[0]).toEqual(system("You are pi."));
		expect(context.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
	});

	it("projects the native view as pi does and uses the actor's thinking level", async () => {
		await h.run("on");
		h.piState.blockImages = true;
		h.piState.thinking = "low";
		await h.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: { contextFiles: [], forceSystemPrompt: "FORCED" } });
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		await step([system("You are pi."), { role: "user", content: [text("see"), image], timestamp: 100 }]);
		const context = h.llm.contexts.at(-1)!;
		expect(context.messages[0]).toMatchObject({ role: "system", content: "FORCED" });
		expect(context.messages[1]!.content).toEqual([text("see"), text("Image reading is disabled.")]);
		expect(h.llm.options.at(-1)).toMatchObject({ reasoning: "low", thinkingBudgets: { low: 3000 } });
		expect(h.llm.options.at(-1)).not.toHaveProperty("toolChoice");
	});

	it("adds the run's project context files to text views, read at request time and stable across steps", async () => {
		await writeGlobal(h, { presets: { solo: { context: { view: "text" } } } });
		await h.run("reload");
		await h.run("on");
		const start = agentStart([{ path: "/repo/AGENTS.md", content: "Use tabs." }]);
		await h.emit("before_agent_start", start.event);
		// A later before_agent_start handler adds a file; pi builds the run's prompt from the same object.
		start.systemPromptOptions.contextFiles.push({ path: "/repo/CLAUDE.md", content: "Run npm test." });
		await step(messages());
		const prompt = h.llm.contexts.at(-1)!.systemPrompt!;
		expect(prompt).toContain("# Project instructions\n\n## /repo/AGENTS.md\n\nUse tabs.\n\n## /repo/CLAUDE.md\n\nRun npm test.");
		await step(messages("Next task", 200));
		expect(h.llm.contexts.at(-1)!.systemPrompt).toBe(prompt);
		await h.emit("session_start");
		await step(messages("Third task", 300));
		expect(h.llm.contexts.at(-1)!.systemPrompt).not.toContain("Project instructions");
	});

	it("leaves project instructions out when disabled", async () => {
		await writeGlobal(h, { presets: { solo: { context: { view: "text", projectInstructions: false } } } });
		await h.run("reload");
		await h.run("on");
		await h.emit("before_agent_start", agentStart([{ path: "/repo/AGENTS.md", content: "Use tabs." }]).event);
		await step(messages());
		expect(h.llm.contexts.at(-1)!.systemPrompt).not.toContain("Use tabs.");
	});
});

describe("toggling clears the turn's advice", () => {
	const transcript = (results: number) => [
		system("You are pi."),
		user("Fix the test", 100),
		...Array.from({ length: results }, (_, i) => [
			assistant([{ type: "toolCall" as const, id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }], { stopReason: "toolUse" }),
			{ ...toolResult("bash", "ok"), toolCallId: `c${i}` },
		]).flat(),
	];
	const advice = async (results: number) =>
		((await h.emit("context_with_system", { type: "context_with_system", messages: transcript(results) })) as { messages: { content: { text: string }[] }[] } | undefined)
			?.messages.at(-1)?.content[0]?.text;

	it.each([
		["off and on", ["off", "on"]],
		["a preset switch", ["on other"]],
	])("after %s, earlier advice is not reused", async (_name, commands) => {
		await writeGlobal(h, { presets: { other: {} } });
		await h.run("reload");
		await h.run("on");
		expect(await advice(0)).toContain("Check the failing test first.");
		expect(await advice(1)).toContain("Check the failing test first.");
		for (const command of commands) await h.run(command);
		expect(await advice(2)).toBeUndefined();
	});
});

describe("consult tool", () => {
	const BASE = ["read", "bash", "edit", "write"];
	const consult = () => h.tools.registered.get("consult")!;
	const transcript = (prompt = "Fix the test", ts = 100) => [system("You are pi."), user(prompt, ts)];
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY);
	const call = (params: { question?: string } = {}, signal?: AbortSignal, onUpdate?: (u: unknown) => void) =>
		consult().execute("t1", params, signal, onUpdate, h.ctx as never);
	const usePresets = async (presets: Record<string, unknown>) => {
		await writeGlobal(h, { presets });
		await h.run("reload");
	};
	const lastText = (c: Context) => (c.messages.at(-1)!.content as { text: string }[]).at(-1)!.text;

	it("is registered inactive and not activated while off", () => {
		expect(consult()).toMatchObject({ name: "consult", defaultActive: false });
		expect(consult().description).toContain("verify");
		expect(h.tools.active).toEqual(BASE);
		expect(h.tools.sets).toEqual([]);
	});

	it("is active only while on with a preset that allows it, leaving other tools alone", async () => {
		await usePresets({ shy: { consult: { enabled: false } }, capped: { consult: { maxPerTurn: 0 } } });
		h.tools.active = ["read", "mcp_docs"];
		await h.run("on");
		expect(h.tools.active).toEqual(["read", "mcp_docs", "consult"]);
		await h.run("on shy");
		expect(h.tools.active).toEqual(["read", "mcp_docs"]);
		await h.run("on capped");
		expect(h.tools.active).toEqual(["read", "mcp_docs"]);
		await h.run("on solo");
		expect(h.tools.active).toEqual(["read", "mcp_docs", "consult"]);
		await h.run("off");
		expect(h.tools.active).toEqual(["read", "mcp_docs"]);
		// No change to the active set when consult stays inactive (shy → capped).
		expect(h.tools.sets).toHaveLength(4);
	});

	it("follows /moa reload when the preset's consult setting changes", async () => {
		await h.run("on");
		expect(h.tools.active).toContain("consult");
		await usePresets({ solo: { consult: { enabled: false } } });
		expect(h.tools.active).toEqual(BASE);
	});

	it("is added on restore, and removed at the next run start rather than during restore", async () => {
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "solo" } });
		await h.emit("session_start");
		expect(h.tools.active).toEqual([...BASE, "consult"]);
		// Restored as off: removing now would drop pi's pending restored tools.
		h.auth.ok = false;
		const sets = h.tools.sets.length;
		await h.emit("session_start");
		expect(h.tools.sets).toHaveLength(sets);
		await h.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} });
		expect(h.tools.active).toEqual(BASE);
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: false } });
		h.tools.active = [...BASE, "consult"];
		await h.emit("session_tree");
		expect(h.tools.active).toContain("consult");
		await h.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} });
		expect(h.tools.active).toEqual(BASE);
	});

	it("runs the advisors on the latest request before advice, with the question, as a tool result", async () => {
		let n = 0;
		h.llm.reply = async () => assistant([text(`advice ${++n}`)], { usage: usage(0.02) });
		await h.run("on");
		const request = transcript();
		await h.emit("context_with_system", { type: "context_with_system", messages: request });
		// pi persists the calling response before running its tools.
		const caller = assistant([text("I think the fixture is stale."), { type: "toolCall" as const, id: "t1", name: "consult", arguments: {} }], { stopReason: "toolUse" });
		h.entries.push({ type: "message", message: caller } as EntryLike);
		const before = h.entries.length;
		const updates: unknown[] = [];
		const out = await call({ question: "Is the fixture wrong?" }, undefined, (u) => updates.push(u));

		const context = h.llm.contexts.at(-1)!;
		expect(context.messages.slice(0, -1)).toEqual([...request, caller]);
		expect(lastText(context).endsWith(`${ADVICE_REQUEST}\n\nThe acting agent asks: Is the fixture wrong?`)).toBe(true);
		expect(out.isError).toBeUndefined();
		expect(out.content).toEqual([text(expect.stringContaining("Advisor A (advisor):\nadvice 2"))]);
		expect(out.details).toMatchObject({ preset: "solo", reason: "consult", question: "Is the fixture wrong?", step: 0, advisors: [{ ok: true, text: "advice 2" }] });
		expect(out.usage?.cost.total).toBeCloseTo(0.02);
		expect(updates).toHaveLength(1);
		expect(h.entries).toHaveLength(before);
	});

	it("uses the text view for other models, as rounds do", async () => {
		await usePresets({ solo: { context: { view: "text" } } });
		await h.run("on");
		await h.emit("context_with_system", { type: "context_with_system", messages: transcript() });
		await call({ question: "Why?" });
		const context = h.llm.contexts.at(-1)!;
		expect(context.systemPrompt).toBeDefined();
		// consult runs one level above the preset's medium, so the text request carries the high length line.
		expect(lastText(context)).toBe(`\n\n${ADVICE_REQUEST}\n\nThe acting agent asks: Why? ${EFFORT_PROFILES.high.lengthLine}`);
	});

	it("leaves the turn's advice cache alone", async () => {
		let n = 0;
		h.llm.reply = async () => assistant([text(`advice ${++n}`)]);
		await h.run("on");
		const request = transcript();
		await h.emit("context_with_system", { type: "context_with_system", messages: request });
		await call();
		const after = [
			...request,
			assistant([{ type: "toolCall" as const, id: "k1", name: "consult", arguments: {} }], { stopReason: "toolUse" }),
			{ ...toolResult("consult", "advice 2"), toolCallId: "k1" },
		];
		const out = (await h.emit("context_with_system", { type: "context_with_system", messages: after })) as { messages: { content: { text: string }[] }[] };
		expect(out.messages.at(-1)!.content[0]!.text).toContain("advice 1");
		expect(out.messages.at(-1)!.content[0]!.text).not.toContain(STALE_NOTE);
		expect(h.llm.options).toHaveLength(2);
	});

	it("does not advance the step, so every_step reuses the step's advice right after a consult", async () => {
		let n = 0;
		h.llm.reply = async () => assistant([text(`advice ${++n}`)]);
		await usePresets({ solo: { triggers: ["every_step"] } });
		await h.run("on");
		const request = transcript();
		await h.emit("context_with_system", { type: "context_with_system", messages: request });
		await call();
		const after = [
			...request,
			assistant([text("Asking."), { type: "toolCall" as const, id: "k1", name: "consult", arguments: {} }], { stopReason: "toolUse" }),
			{ ...toolResult("consult", "advice 2"), toolCallId: "k1" },
		];
		const out = (await h.emit("context_with_system", { type: "context_with_system", messages: after })) as { messages: { content: { text: string }[] }[] };
		const advice = out.messages.at(-1)!.content[0]!.text;
		expect(advice).toContain("advice 1");
		expect(advice).not.toContain(STALE_NOTE);
		expect(h.llm.options).toHaveLength(2);
	});

	it("caps calls per turn and starts over with a new user message", async () => {
		await usePresets({ solo: { consult: { maxPerTurn: 1 } } });
		await h.run("on");
		await h.emit("context_with_system", { type: "context_with_system", messages: transcript() });
		await call();
		const limited = await call();
		expect(limited).toMatchObject({ content: [text("consult limit reached for this turn (1).")] });
		expect(limited.isError).toBeUndefined();
		await h.emit("context_with_system", { type: "context_with_system", messages: transcript("Next", 200) });
		expect((await call()).content[0]).toMatchObject({ text: expect.stringContaining("Check the failing test first.") });
	});

	it("errors when every advisor fails or the call is aborted, and without a request", async () => {
		await h.run("on");
		expect(await call()).toMatchObject({ isError: true, content: [text("consult is unavailable: no request context.")] });
		await h.emit("context_with_system", { type: "context_with_system", messages: transcript() });
		h.llm.reply = async () => assistant([], { stopReason: "error", errorMessage: "rate limited" });
		expect(await call()).toMatchObject({ isError: true, content: [text("consult failed: no advisor answered (rate limited).")] });
		const controller = new AbortController();
		controller.abort();
		expect(await call({}, controller.signal)).toMatchObject({ isError: true, content: [text("consult aborted.")] });
	});
});

describe("advisor budget", () => {
	type Out = { messages: { content: { text: string }[] }[] } | undefined;
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY).map((e) => e.data as MoaRecord);
	const calls = () => h.llm.options.length;
	const transcript = (steps: number, prompt = "Fix the test", ts = 100) => [
		system("You are pi."),
		user(prompt, ts),
		...Array.from({ length: steps }, (_, i) => [
			assistant([{ type: "toolCall" as const, id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }], { stopReason: "toolUse" }),
			{ ...toolResult("bash", "ok"), toolCallId: `c${i}` },
		]).flat(),
	];
	const step = async (steps: number) =>
		((await h.emit("context_with_system", { type: "context_with_system", messages: transcript(steps) })) as Out)?.messages.at(-1)?.content[0]?.text;
	const consult = (signal?: AbortSignal) => h.tools.registered.get("consult")!.execute("t1", {}, signal, undefined, h.ctx as never);
	const budgetNotes = () => h.notes.filter((n) => n.message.includes("budget reached"));
	const status = async () => {
		await h.run("");
		return h.lastNote()!.message;
	};
	const useBudget = async (onExceed: string, sessionUsd = 0.03) => {
		await writeGlobal(h, { budget: { sessionUsd, onExceed }, presets: { solo: { triggers: ["every_step"] } } });
		await h.run("reload");
		await h.run("on");
	};
	let n = 0;
	beforeEach(() => {
		n = 0;
		h.llm.reply = async () => assistant([text(`advice ${++n}`)], { usage: usage(0.02) });
	});

	it("rebuilds spend from this branch's round records and consult results on session start and tree changes", async () => {
		const round = (cost?: number) => ({ type: "custom", customType: RECORD_ENTRY, data: { advisors: [{ ok: true, ...(cost !== undefined && { costUsd: cost }) }] } });
		h.entries.push(round(0.25), round(), {
			type: "message",
			message: { role: "toolResult", toolName: "consult", toolCallId: "c", content: [], isError: false, timestamp: 1, details: { advisors: [{ ok: true, costUsd: 0.5 }] } },
		} as EntryLike);
		await h.emit("session_start");
		expect(await status()).toContain("advisor spend this session: $0.7500 of $5.00 (warn when reached); some advisor costs unknown (1 call)");
		const other = [round(0.1)];
		Object.assign(h.ctx.sessionManager, { getBranch: () => other });
		await h.emit("session_tree");
		expect(await status()).toContain("advisor spend this session: $0.1000 of $5.00");
	});

	it("adds rounds and consults live, including interrupted rounds' partial cost", async () => {
		await h.run("on");
		await step(0);
		await consult();
		expect(await status()).toContain("$0.0400");
		const controller = new AbortController();
		Object.assign(h.ctx, { signal: controller.signal });
		h.llm.reply = async () => {
			controller.abort();
			return assistant([], { stopReason: "aborted", usage: usage(0.005) });
		};
		await h.emit("context_with_system", { type: "context_with_system", messages: transcript(0, "Next", 200) });
		expect(records().at(-1)).toMatchObject({ interrupted: true, advisors: [{ ok: false, costUsd: 0.005 }] });
		expect(await status()).toContain("$0.0450");
	});

	it("warn: keeps running and notifies once when the limit is reached", async () => {
		await useBudget("warn");
		for (let i = 0; i < 4; i++) expect(await step(i)).toContain(`advice ${i + 1}`);
		expect(calls()).toBe(4);
		expect(budgetNotes()).toHaveLength(1);
		expect(budgetNotes()[0]).toMatchObject({ type: "warning", message: expect.stringContaining("advisors keep running") });
		expect((await consult()).content[0]).toMatchObject({ text: expect.stringContaining("advice 5") });
		expect(budgetNotes()).toHaveLength(1);
	});

	it("pause: no fresh rounds or consults, reuses advice already paid for, notifies once", async () => {
		await useBudget("pause");
		await step(0);
		await step(1);
		expect(calls()).toBe(2);
		const reused = await step(2);
		expect(reused).toContain("advice 2");
		expect(reused).toContain(STALE_NOTE);
		await step(3);
		expect(calls()).toBe(2);
		const out = await consult();
		expect(out.isError).toBeUndefined();
		expect(out.content).toEqual([text(expect.stringContaining("advisor budget reached for this session; consult is paused"))]);
		expect(calls()).toBe(2);
		expect(budgetNotes()).toHaveLength(1);
		expect(h.status.get("moa")).toBe("moa:solo · $0.0400 · budget reached");
	});

	it("stop: turns MoA off through the persisted state and notifies", async () => {
		await useBudget("stop");
		await step(0);
		await step(1);
		expect(await step(2)).toBeUndefined();
		expect(calls()).toBe(2);
		expect(stateEntries(h).at(-1)).toEqual({ enabled: false });
		expect(h.status.get("moa")).toBeUndefined();
		expect(h.tools.active).not.toContain("consult");
		expect(budgetNotes().at(-1)).toMatchObject({ type: "warning", message: expect.stringContaining("MoA turned off") });
		expect(await step(3)).toBeUndefined();
		expect(calls()).toBe(2);
		await h.run("on");
		expect(h.lastNote()?.message).toContain("the limit is already reached");
	});

	it("stop applies to consult calls too", async () => {
		await useBudget("stop", 0.01);
		await step(0);
		const out = await consult();
		expect(out.isError).toBeUndefined();
		expect(out.content).toEqual([text(expect.stringContaining("MoA has been turned off"))]);
		expect(stateEntries(h).at(-1)).toEqual({ enabled: false });
		expect(calls()).toBe(1);
	});

	it("sessionUsd 0 means no limit", async () => {
		await useBudget("stop", 0);
		for (let i = 0; i < 3; i++) await step(i);
		expect(calls()).toBe(3);
		expect(budgetNotes()).toEqual([]);
		expect(await status()).toContain("$0.0600 (no limit)");
	});
});

describe("advisor output cleaning", () => {
	it("sanitises advice before framing and caching, and flags it in the record", async () => {
		h.llm.reply = async () => assistant([text('Read the file.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>')]);
		await h.run("on");
		const out = (await h.emit("context_with_system", { type: "context_with_system", messages: [system("pi"), user("Fix", 100)] })) as {
			messages: { content: { text: string }[] }[];
		};
		const advice = out.messages.at(-1)!.content[0]!.text;
		expect(advice).toContain("Read the file.\n[removed tool-call-like text]");
		expect(advice).not.toContain("tool_call>");
		const record = h.entries.find((e) => e.customType === RECORD_ENTRY)!.data as MoaRecord;
		expect(record.advisors[0]).toMatchObject({ ok: true, sanitized: true, text: "Read the file.\n[removed tool-call-like text]" });
		expect(record.advisors[0]).not.toHaveProperty("truncated");
	});
});

describe("UI", () => {
	const transcript = (prompt = "Fix the test", ts = 100) => [system("You are pi."), user(prompt, ts)];
	const round = (ts = 100) => h.emit("context_with_system", { type: "context_with_system", messages: transcript("Fix the test", ts) });
	const consult = () => h.tools.registered.get("consult")!.execute("t1", { question: "Sound?" }, undefined, undefined, h.ctx as never);
	const theme = fakeTheme as never;
	const render = (c: { render(width: number): string[] } | undefined) => c?.render(100).join("\n");
	beforeEach(() => {
		h.llm.reply = async () => assistant([text("Check the failing test first.")], { usage: usage(0.02) });
	});

	it("registers an entry renderer for moa records that honours ui.advice", async () => {
		await h.run("on");
		await round();
		const entry = h.entries.find((e) => e.customType === RECORD_ENTRY)!;
		const renderer = h.entryRenderers.get(RECORD_ENTRY)!;
		const draw = (expanded: boolean) => render(renderer(entry as never, { expanded }, theme));
		expect(draw(false)).toContain("1/1 advisor");
		expect(draw(false)).not.toContain("Check the failing test");
		expect(draw(true)).toContain("Check the failing test");
		await writeGlobal(h, { ui: { advice: "hidden" } });
		await h.run("reload");
		expect(renderer(entry as never, { expanded: true }, theme)).toBeUndefined();
		await writeGlobal(h, { ui: { advice: "expanded" } });
		await h.run("reload");
		expect(draw(false)).toContain("Check the failing test");
	});

	it("gives consult a call and result renderer using the record in details", async () => {
		await h.run("on");
		await round();
		const tool = h.tools.registered.get("consult")!;
		const out = await consult();
		expect(out.content).toEqual([text(expect.stringContaining("Check the failing test first."))]);
		expect(render(tool.renderCall!({ question: "Sound?" }, theme, {} as never))).toContain('"Sound?"');
		const card = render(tool.renderResult!(out, { expanded: false, isPartial: false }, theme, { isError: false } as never));
		expect(card).toContain("consult");
		expect(card).not.toContain("Check the failing test");
	});

	it("shows spend in the status line after rounds and consults, and on restore", async () => {
		await h.run("on");
		expect(h.status.get("moa")).toBe("moa:solo");
		await round();
		expect(h.status.get("moa")).toBe("moa:solo · $0.0200");
		await consult();
		expect(h.status.get("moa")).toBe("moa:solo · $0.0400");
		await h.emit("session_start");
		expect(h.status.get("moa")).toBe("moa:solo · $0.0200");
		await writeGlobal(h, { ui: { status: false } });
		await h.run("reload");
		expect(h.status.get("moa")).toBeUndefined();
	});

	it("shows consult progress and restores the working message", async () => {
		await h.run("on");
		await round();
		h.working.length = 0;
		await consult();
		expect(h.working).toEqual(["MoA: advisors 0/1…", "MoA: advisors 1/1…", undefined]);
	});

	it("restores the working message only when the last of overlapping consults ends", async () => {
		await writeGlobal(h, { presets: { solo: { consult: { maxPerTurn: 5 } } } });
		await h.run("reload");
		await h.run("on");
		await round();
		const gates: (() => void)[] = [];
		h.llm.reply = () => new Promise((resolve) => gates.push(() => resolve(assistant([text("ok")], { usage: usage(0.02) }))));
		h.working.length = 0;
		const first = consult();
		const second = consult();
		await vi.waitFor(() => expect(gates).toHaveLength(2));
		gates[0]!();
		await first;
		expect(h.working).toEqual(["MoA: advisors 0/1…", "MoA: advisors 0/1…", "MoA: advisors 1/1…"]);
		gates[1]!();
		await second;
		expect(h.working.slice(3)).toEqual(["MoA: advisors 1/1…", undefined]);
	});

	it("never fails a round or consult when the UI is missing or throws", async () => {
		await h.run("on");
		Object.assign(h.ctx.ui, {
			setWorkingMessage: () => {
				throw new Error("stale ctx");
			},
			setStatus: () => {
				throw new Error("stale ctx");
			},
		});
		expect(await round()).toBeDefined();
		expect((await consult()).isError).toBeUndefined();
		Object.assign(h.ctx, { hasUI: false });
		expect(await round(200)).toBeDefined();
	});
});

describe("moa/<preset> virtual models", () => {
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY).map((e) => e.data as MoaRecord);
	const turnEvent = (t = 1) => ({ type: "context_with_system", messages: [system("You are pi."), user("Fix the test", t)] });
	const config = { virtualModels: true, presets: { council: { actor: "openai/gpt" } } };
	const route = (id: string, request: Record<string, unknown> = {}) =>
		h.virtual.get(id)!.route({ model: virtualModel(id), thinkingLevel: "high", reason: "user", messages: [], ...request } as never, h.ctx as never);

	it("registers none while virtualModels is false", async () => {
		expect(h.virtual.size).toBe(0);
		await writeGlobal(h, { presets: { council: {} } });
		await h.run("reload");
		expect(h.virtual.size).toBe(0);
	});

	it("registers one model per valid preset at load, before any session starts", async () => {
		h = await setup(config);
		expect([...h.virtual.keys()]).toEqual(["solo", "council"]);
		expect(h.virtual.get("council")).toMatchObject({ provider: "moa", id: "council", name: "MoA: council" });
		expect(h.virtual.get("solo")?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("re-syncs on reload and reports presets that cannot be models", async () => {
		await writeGlobal(h, { ...config, presets: { council: { actor: "openai/gpt" }, "two words": {} } });
		await h.run("reload");
		expect([...h.virtual.keys()]).toEqual(["solo", "council"]);
		expect(h.notes.some((n) => n.type === "warning" && n.message.includes("two words: not usable as a model id"))).toBe(true);
		await writeGlobal(h, { virtualModels: true });
		await h.run("reload");
		expect([...h.virtual.keys()]).toEqual(["solo"]);
		await writeGlobal(h, {});
		await h.run("reload");
		expect(h.virtual.size).toBe(0);
	});

	it("removes moa models left registered by an earlier instance (pi /reload)", async () => {
		h.virtual.set("stale", { provider: "moa", id: "stale" } as ExtensionVirtualModel<unknown>);
		await h.emit("session_start");
		expect(h.virtual.has("stale")).toBe(false);
	});

	it("does not re-register unchanged models on session start or tree navigation", async () => {
		h = await setup(config);
		await h.emit("session_start");
		const count = h.registrations.length;
		await h.emit("session_tree");
		await h.emit("session_start");
		expect(h.registrations.length).toBe(count);
	});

	it("warns on reload when the selected moa model is gone", async () => {
		h = await setup(config);
		await h.emit("session_start");
		await h.select(virtualModel("council"));
		await writeGlobal(h, { virtualModels: true });
		await h.run("reload");
		expect(h.lastNote()?.message ?? "").not.toBe("");
		expect(h.notes.some((n) => n.message.includes("moa/council is no longer available"))).toBe(true);
	});

	describe("route()", () => {
		beforeEach(async () => {
			h = await setup(config);
			await h.emit("session_start");
		});

		it("routes a concrete actor", async () => {
			expect(await route("council")).toEqual({ model: gpt, thinkingLevel: "high" });
		});

		it('routes "current" to the model selected before switching, and stores it as state', async () => {
			await h.select(gpt);
			await h.select(virtualModel("solo"));
			expect(await route("solo")).toEqual({ model: gpt, thinkingLevel: "high", state: { actor: "openai/gpt" } });
			expect(await route("solo", { state: { actor: "openai/gpt" } })).toEqual({ model: gpt, thinkingLevel: "high" });
		});

		/** A runtime started with `moa/solo` already selected (a resume): nothing tracked. */
		const resumed = async () => {
			h = await setup(config);
			h.sel.model = virtualModel("solo");
			await h.emit("session_start");
		};

		it("uses the branch state after a resume and falls back to request.previous", async () => {
			await resumed();
			expect((await route("solo", { state: { actor: "openai/gpt" } })).model).toBe(gpt);
			expect((await route("solo", { previous: { model, thinkingLevel: "low" } })).model).toBe(model);
		});

		it("prefers the branch state over a selection carried over from another session", async () => {
			await h.select(virtualModel("solo"));
			await h.emit("session_start");
			expect((await route("solo", { state: { actor: "openai/gpt" } })).model).toBe(gpt);
			expect((await route("solo")).model).toBe(model);
		});

		it("fails with a clear error when no physical model is known", async () => {
			await resumed();
			await expect(async () => route("solo")).rejects.toThrow(/no physical model known yet/);
		});

		it("throws for a preset removed from the config", async () => {
			await writeGlobal(h, { virtualModels: true });
			const definition = h.virtual.get("council")!;
			await h.run("reload");
			expect(() => definition.route({ model: virtualModel("council"), thinkingLevel: "high", reason: "user", messages: [] } as never, h.ctx as never)).toThrow(
				/preset "council" is not configured/,
			);
		});
	});

	describe("activation by the selected model", () => {
		beforeEach(async () => {
			h = await setup(config);
			await h.emit("session_start");
		});

		it("is active with the model's preset, status and consult, without /moa on", async () => {
			await h.select(virtualModel("solo"));
			expect(h.status.get("moa")).toBe("moa/solo");
			expect(h.tools.active).toContain("consult");
			expect(stateEntries(h)).toEqual([]);
			const result = (await h.emit("context_with_system", turnEvent())) as { messages: unknown[] } | undefined;
			expect(result?.messages).toHaveLength(3);
			expect(records()[0]?.preset).toBe("solo");
			await h.select(gpt);
			expect(h.status.get("moa")).toBeUndefined();
			expect(h.tools.active).not.toContain("consult");
		});

		it("resolves advisors against the routed physical actor, not the virtual model", async () => {
			const asked: string[] = [];
			h.llm.reply = async (m) => {
				asked.push(`${(m as TestModel).provider}/${m.id}`);
				return assistant([text("advice")]);
			};
			await h.select(gpt);
			await h.select(virtualModel("solo"));
			await h.emit("context_with_system", turnEvent());
			expect(asked).toEqual(["openai/gpt"]);
			expect(records()[0]?.advisors[0]).toMatchObject({ model: "openai/gpt", ok: true });
			// "current" equals the routed actor, so the advisor gets the native view (the actor's own prompt).
			expect(h.llm.contexts[0]?.systemPrompt).toBeUndefined();
			expect(JSON.stringify(h.llm.contexts[0]?.messages[0])).toContain("You are pi.");
		});

		it("falls back to the model that answered last when the actor cannot be resolved, as route() does", async () => {
			h = await setup({ virtualModels: true, presets: { gone: { actor: "openai/missing" } } });
			await h.emit("session_start");
			await h.select(virtualModel("gone"));
			const answered = assistant([text("done")], { provider: "openai", model: "gpt" });
			await h.emit("context_with_system", { type: "context_with_system", messages: [system("You are pi."), user("Fix", 1), answered, user("More", 3)] });
			expect(records()[0]?.advisors[0]).toMatchObject({ model: "openai/gpt", ok: true });
		});

		it("gives native advisors the routed thinking level, clamped to the actor", async () => {
			await h.select(gpt);
			await h.select(virtualModel("solo"));
			h.piState.thinking = "max";
			await h.emit("context_with_system", turnEvent(1));
			expect(h.llm.options.at(-1)).toMatchObject({ reasoning: "high" });
			await route("solo", { thinkingLevel: "low" });
			await h.emit("context_with_system", turnEvent(2));
			expect(h.llm.options.at(-1)).toMatchObject({ reasoning: "low" });
		});

		it("takes precedence over /moa on, which resumes when a physical model is selected again", async () => {
			await writeGlobal(h, { ...config, presets: { ...config.presets, other: {} } });
			await h.run("reload");
			await h.run("on other");
			await h.select(virtualModel("council"));
			expect(h.status.get("moa")).toBe("moa/council");
			await h.emit("context_with_system", turnEvent());
			expect(records().at(-1)?.preset).toBe("council");
			await h.run("");
			expect(h.lastNote()?.message).toMatch(/^MoA on via model moa\/council · preset council/);
			expect(h.lastNote()?.message).toContain("actor: openai/gpt");
			await h.select(model);
			expect(h.status.get("moa")).toBe("moa:other");
		});

		it("keeps a restored /moa on while a moa model with an unknown actor is selected", async () => {
			h = await setup(config);
			h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { enabled: true, preset: "solo" } });
			h.sel.model = virtualModel("solo");
			await h.emit("session_start");
			expect(h.notes.some((n) => n.message.includes("restored as off"))).toBe(false);
			await h.select(gpt);
			expect(h.status.get("moa")).toBe("moa:solo");
		});

		it("warns when the selected preset cannot run advisors", async () => {
			h.sel.model = virtualModel("solo");
			await h.emit("session_start");
			await h.select(virtualModel("council"));
			expect(h.notes.some((n) => n.type === "warning" && n.message.includes("moa/council cannot run advisors with this model"))).toBe(false);
			h.auth.ok = false;
			await h.select(virtualModel("solo"));
			expect(h.lastNote()).toMatchObject({ type: "warning" });
			expect(h.lastNote()?.message).toContain("moa/solo cannot run advisors with this model");
		});
	});
});

describe("/moa <prompt> one-shot", () => {
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY);
	const turn = (prompt: string, t: number, ...rest: AgentMessage[]) => ({
		type: "context_with_system",
		messages: [system("You are pi."), user(prompt, t), ...rest],
	});
	const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { cmd: "ls" } };

	it("sends the prompt and runs MoA for every step of that turn only", async () => {
		await h.run("fix the bug");
		expect(h.sent).toEqual([{ content: "fix the bug", options: undefined }]);
		expect(h.lastNote()?.message).toBe("MoA for this turn (preset solo): prompt sent");
		expect(await h.emit("context_with_system", turn("fix the bug", 5))).toBeDefined();
		const step = await h.emit("context_with_system", turn("fix the bug", 5, assistant([call]), toolResult("bash", "ok")));
		expect(step).toBeDefined();
		expect(records()).toHaveLength(1);
		expect(await h.emit("context_with_system", turn("next", 9))).toBeUndefined();
		// The same text later is a normal message.
		expect(await h.emit("context_with_system", turn("fix the bug", 12))).toBeUndefined();
		expect(records()).toHaveLength(1);
		expect(stateEntries(h)).toEqual([]);
		expect(h.status.get("moa")).toBeUndefined();
		expect(h.sel.model).toBe(model);
	});

	it("is cleared when the agent settles or the session changes before its turn", async () => {
		await h.run("fix the bug");
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		expect(await h.emit("context_with_system", turn("fix the bug", 5))).toBeUndefined();
		await h.run("fix the bug");
		await h.emit("session_start");
		expect(await h.emit("context_with_system", turn("fix the bug", 6))).toBeUndefined();
	});

	it("does not bind to the turn that was current when it was sent", async () => {
		await h.emit("context_with_system", turn("again", 3));
		await h.run("again");
		expect(await h.emit("context_with_system", turn("again", 3, assistant([call]), toolResult("bash", "ok")))).toBeUndefined();
		expect(await h.emit("context_with_system", turn("again", 7))).toBeDefined();
	});

	it("queues as a follow-up while the agent is busy", async () => {
		h.sel.idle = false;
		await h.run("then add tests");
		expect(h.sent).toEqual([{ content: "then add tests", options: { deliverAs: "followUp" } }]);
		expect(h.lastNote()?.message).toContain("prompt queued as a follow-up");
	});

	it("is refused while a manual compaction runs", async () => {
		await h.emit("session_before_compact", { type: "session_before_compact", reason: "manual" });
		await h.run("fix the bug");
		expect(h.lastNote()).toMatchObject({ type: "error" });
		expect(h.lastNote()?.message).toContain("compaction is running");
		expect(h.sent).toEqual([]);
		await h.emit("session_compact_failed", { type: "session_compact_failed", reason: "manual" });
		await h.run("fix the bug");
		expect(h.sent).toHaveLength(1);
	});

	it("is refused in print and JSON modes", async () => {
		Object.assign(h.ctx, { mode: "print" });
		await h.run("fix the bug");
		expect(h.lastNote()?.message).toContain("interactive and RPC modes only");
		expect(h.sent).toEqual([]);
	});

	it("refuses an unusable preset without sending", async () => {
		h.auth.ok = false;
		await h.run("fix the bug");
		expect(h.lastNote()).toMatchObject({ type: "error" });
		expect(h.lastNote()?.message).toContain('cannot run /moa <prompt> with preset "solo"');
		expect(h.sent).toEqual([]);
	});

	it("is a normal message while MoA is already on", async () => {
		await h.run("on");
		await h.run("fix the bug");
		expect(h.lastNote()?.message).toBe("MoA already on (preset solo): prompt sent");
		expect(h.sent).toHaveLength(1);
		expect(stateEntries(h)).toEqual([{ enabled: true, preset: "solo" }]);
	});

	it("uses the selected moa model's preset and routed actor", async () => {
		h = await setup({ virtualModels: true, presets: { council: { actor: "openai/gpt" } } });
		await h.emit("session_start");
		await h.select(virtualModel("council"));
		await h.run("fix the bug");
		expect(h.lastNote()?.message).toBe("MoA already on (preset council): prompt sent");
		expect(h.sel.model).toEqual(virtualModel("council"));
	});
});

describe("before_done review", () => {
	const records = () => h.entries.filter((e) => e.customType === RECORD_ENTRY).map((e) => e.data as MoaRecord);
	const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "npm test" } };
	const transcript = (final: AgentMessage, prompt = "Fix the test", ts = 100) => [system("You are pi."), user(prompt, ts), assistant([call], { stopReason: "toolUse" }), toolResult("bash", "ok"), final];
	const done = (t = "Done.") => assistant([text(t)]);
	const turnEnd = (messages: AgentMessage[], extra: Record<string, unknown> = {}) =>
		h.emit("turn_end", { type: "turn_end", outcome: "completed", message: messages.at(-1), toolResults: [], entries: [], context: { contextMessages: messages, canContinue: false }, ...extra });
	const usePreset = async (preset: Record<string, unknown>) => {
		await writeGlobal(h, { presets: { solo: preset } });
		await h.run("reload");
		await h.run("on");
	};
	type Boundary = { entries: { type: string; customType?: string; content?: string; display?: boolean; details?: unknown }[]; continue: boolean } | undefined;
	beforeEach(() => {
		h.llm.reply = async () => assistant([text("Verdict: revise\nThe tests were not run after the edit.")], { usage: usage(0.02) });
	});

	it("runs a review when a reply ends the turn and sends the actor back to work on revise", async () => {
		await usePreset({ triggers: ["user_turn", "before_done"] });
		const messages = transcript(done());
		const out = (await turnEnd(messages)) as Boundary;
		expect(out?.continue).toBe(true);
		expect(out?.entries).toHaveLength(1);
		const entry = out!.entries[0]!;
		expect(entry).toMatchObject({ type: "custom_message", customType: "moa-review", display: true });
		expect(entry.content).toContain("[MoA before-done review]");
		expect(entry.content).toContain("Advisor A (advisor):\nVerdict: revise\nThe tests were not run after the edit.");
		expect(records().map((r) => [r.reason, r.step, r.advisors[0]?.verdict, r.advisors[0]?.effort])).toEqual([["before_done", 2, "revise", "high"]]);
		// The round is the `moa` entry; the message carries no second copy.
		expect(entry.details).toBeUndefined();
		// The advisors were asked to review a finished turn, at one effort level above the preset's.
		const request = (h.llm.contexts.at(-1)!.messages.at(-1)!.content as { text: string }[])[0]!.text;
		expect(request).toContain("The agent's last reply ends its turn");
		expect(h.llm.options.at(-1)).toMatchObject({ maxTokens: 4096 });
		expect(h.status.get("moa")).toBe("moa:solo · $0.0200");
		expect(h.messageRenderers.has("moa-review")).toBe(true);
	});

	it("lets the turn end on on-track or blocked, still recording the round", async () => {
		await usePreset({ triggers: ["before_done"] });
		for (const verdict of ["on-track", "blocked"]) {
			h.llm.reply = async () => assistant([text(`Verdict: ${verdict}\nFine.`)]);
			expect(await turnEnd(transcript(done(), "Fix", 100 + verdict.length))).toBeUndefined();
		}
		expect(records().map((r) => r.advisors[0]?.verdict)).toEqual(["on-track", "blocked"]);
	});

	it("reviews at most once per turn, and not when the reply calls tools, failed, or MoA is off", async () => {
		await usePreset({ triggers: ["before_done"] });
		const messages = transcript(done());
		expect(((await turnEnd(messages)) as Boundary)?.continue).toBe(true);
		expect(await turnEnd([...messages, assistant([text("Still done.")])])).toBeUndefined();
		expect(await turnEnd(transcript(assistant([call], { stopReason: "toolUse" }), "Fix", 101))).toBeUndefined();
		expect(await turnEnd(transcript(done(), "Fix", 102), { outcome: "aborted" })).toBeUndefined();
		await h.run("off");
		expect(await turnEnd(transcript(done(), "Fix", 103))).toBeUndefined();
		expect(records()).toHaveLength(1);
	});

	it("keeps drafts earlier handlers proposed, and skips the review when the user has queued a message", async () => {
		await usePreset({ triggers: ["before_done"] });
		const earlier = { type: "custom", customType: "other-ext", data: 1 };
		const out = (await turnEnd(transcript(done()), { entries: [earlier] })) as Boundary;
		expect(out?.entries.map((e) => e.customType)).toEqual(["other-ext", "moa-review"]);
		h.sel.pending = true;
		expect(await turnEnd(transcript(done(), "Fix", 101))).toBeUndefined();
		h.sel.pending = false;
		expect(records()).toHaveLength(1);
	});

	it("does nothing without the trigger", async () => {
		await h.run("on");
		expect(await turnEnd(transcript(done()))).toBeUndefined();
		expect(records()).toHaveLength(0);
	});

	it("drops the turn's cached advice so the next request carries only the review", async () => {
		await usePreset({ triggers: ["user_turn", "before_done"] });
		const messages = transcript(done());
		const step = (m: unknown[]) => h.emit("context_with_system", { type: "context_with_system", messages: m });
		await step(messages.slice(0, 2));
		expect(records().map((r) => r.reason)).toEqual(["user_turn"]);
		const out = (await turnEnd(messages)) as Boundary;
		const review = { role: "custom", customType: "moa-review", content: out!.entries[0]!.content, display: true, timestamp: 200 };
		expect(await step([...messages, review])).toBeUndefined();
	});

	it("counts as the continuation step's round, so every_step does not run again on top of the review", async () => {
		await usePreset({ triggers: ["every_step", "before_done"] });
		const messages = transcript(done());
		const step = (m: unknown[]) => h.emit("context_with_system", { type: "context_with_system", messages: m });
		const out = (await turnEnd(messages)) as Boundary;
		expect(out?.continue).toBe(true);
		const review = { role: "custom", customType: "moa-review", content: out!.entries[0]!.content, display: true, timestamp: 200 };
		expect(await step([...messages, review])).toBeUndefined();
		expect(records().map((r) => r.reason)).toEqual(["before_done"]);
		// The next real step runs as usual.
		expect(await step([...messages, review, assistant([call], { stopReason: "toolUse" }), toolResult("bash", "ok")])).toBeDefined();
		expect(records().map((r) => r.reason)).toEqual(["before_done", "every_step"]);
	});

	it("is paused by the advisor budget", async () => {
		await writeGlobal(h, { budget: { sessionUsd: 0.01, onExceed: "pause" }, presets: { solo: { triggers: ["before_done"] } } });
		await h.run("reload");
		await h.run("on");
		h.entries.push({ type: "custom", customType: RECORD_ENTRY, data: { preset: "solo", reason: "user_turn", turn: "t", step: 0, advisors: [{ label: "A", ok: true, costUsd: 0.02 }] } });
		await h.emit("session_start");
		await h.run("on");
		expect(await turnEnd(transcript(done()))).toBeUndefined();
		expect(records().map((r) => r.reason)).toEqual(["user_turn"]);
	});

	it("consult passes the actor's effort through to the round", async () => {
		await h.run("on");
		await h.emit("context_with_system", { type: "context_with_system", messages: [system("You are pi."), user("Fix", 100)] });
		const out = await h.tools.registered.get("consult")!.execute("t1", { effort: "low" }, undefined, undefined, h.ctx as never);
		expect((out.details as MoaRecord).advisors[0]?.effort).toBe("low");
		expect(h.llm.options.at(-1)).toMatchObject({ maxTokens: 1024 });
		expect(await h.run("")).toBeUndefined();
		expect(h.lastNote()?.message).toContain("effort: medium (max max)");
	});
});
