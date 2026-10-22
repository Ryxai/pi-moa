import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import moa from "../src/index.ts";
import { RECORD_ENTRY } from "../src/round.ts";
import { STATE_ENTRY, type EntryLike } from "../src/state.ts";
import { assistant, system, text, user } from "./fixtures.ts";

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
	llm: { reply: (model: { id: string }) => Promise<unknown>; options: unknown[] };
	working: (string | undefined)[];
}

const model = { provider: "anthropic", id: "sonnet" };

async function setup(): Promise<Harness> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-moa-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const entries: EntryLike[] = [];
	const notes: Note[] = [];
	const status = new Map<string, string | undefined>();
	const handlers = new Map<string, Handler>();
	const auth = { ok: true };
	const llm = {
		reply: async (_model: { id: string }): Promise<unknown> => assistant([text("Check the failing test first.")]),
		options: [] as unknown[],
	};
	const working: (string | undefined)[] = [];
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (_name: string, options: typeof command) => {
			command = options;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	moa(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd: join(agentDir, "project"),
		hasUI: true,
		model,
		isProjectTrusted: () => false,
		modelRegistry: {
			find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
			hasConfiguredAuth: () => auth.ok,
			streamSimple: (m: { id: string }, _context: unknown, options: unknown) => {
				llm.options.push(options);
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
	it("reports one-shot prompts as not implemented", async () => {
		await h.run("fix the failing test");
		expect(h.lastNote()?.message).toContain("not implemented yet");
	});

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
		expect(h.working).toEqual(["MoA: advisors…", undefined]);
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
	const event = () => ({ type: "context_with_system", messages: [system("You are pi."), user("Fix the test")] });
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

	it("gives advisor calls a per-slot session id and the payload hook", async () => {
		await h.run("on");
		await h.emit("context_with_system", event());
		const options = h.llm.options.at(-1) as { sessionId?: string; onPayload?: unknown };
		expect(options.sessionId).toBe("moa0-session-1");
		expect(options.onPayload).toBeTypeOf("function");
	});
});
