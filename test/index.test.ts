import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import moa from "../src/index.ts";
import { STATE_ENTRY, type EntryLike } from "../src/state.ts";

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
		},
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
			notify: (message: string, type = "info") => notes.push({ message, type }),
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

	it("context_with_system passes through whether on or off", async () => {
		const event = { type: "context_with_system", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		expect(await h.emit("context_with_system", event)).toBeUndefined();
		await h.run("on");
		expect(await h.emit("context_with_system", event)).toBeUndefined();
	});

	it("status reports on with the preset", async () => {
		await h.run("on");
		await h.run("");
		expect(h.lastNote()?.message).toMatch(/^MoA on · preset solo/);
	});
});
