import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_PRESET, deepMerge, getPreset, issuesFor, mergeLayers, parseConfig, type MoaConfig } from "../src/config.ts";

const merged = (...layers: unknown[]) => mergeLayers(layers) as MoaConfig;

describe("deepMerge", () => {
	it("merges objects recursively, replaces arrays and scalars, and does not mutate inputs", () => {
		const base = { a: { b: 1, c: [1, 2] }, d: "x" };
		const out = deepMerge(base, { a: { c: [3] }, d: "y" });
		expect(out).toEqual({ a: { b: 1, c: [3] }, d: "y" });
		expect(base).toEqual({ a: { b: 1, c: [1, 2] }, d: "x" });
	});

	it("drops prototype-polluting keys", () => {
		const out = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "a": {"prototype": 1}}'));
		expect(out).toEqual({ a: {} });
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("mergeLayers", () => {
	it("returns the defaults with no layers", () => {
		expect(merged()).toEqual(DEFAULT_CONFIG);
	});

	it("applies project over global over defaults", () => {
		const global = { budget: { sessionUsd: 2 }, ui: { status: false } };
		const project = { budget: { sessionUsd: 1 } };
		const config = merged(global, project);
		expect(config.budget).toEqual({ sessionUsd: 1, onExceed: "warn" });
		expect(config.ui).toEqual({ advice: "collapsed", status: false });
	});

	it("expands each preset over the default preset values", () => {
		const config = merged({
			presets: { council: { advisors: [{ model: "openai/gpt-5.6", role: "planner" }], timeoutMs: 5000 } },
		});
		const council = config.presets.council!;
		expect(council.timeoutMs).toBe(5000);
		expect(council.triggers).toEqual(DEFAULT_PRESET.triggers);
		expect(council.context).toEqual(DEFAULT_PRESET.context);
		expect(council.advisors).toEqual([{ model: "openai/gpt-5.6", role: "planner" }]);
		expect(config.presets.solo).toEqual(DEFAULT_PRESET);
	});

	it("merges nested preset objects field by field", () => {
		const config = merged({ presets: { solo: { context: { toolResultChars: 100 } } } });
		expect(config.presets.solo!.context).toEqual({ ...DEFAULT_PRESET.context, toolResultChars: 100 });
	});

	it("replaces arrays rather than concatenating them", () => {
		const config = merged(
			{ presets: { solo: { triggers: ["every_step"] } } },
			{ presets: { solo: { context: { pin: ["task"] } } } },
		);
		expect(config.presets.solo!.triggers).toEqual(["every_step"]);
		expect(config.presets.solo!.context.pin).toEqual(["task"]);
	});

	it("lets a later layer's role replace the earlier definition wholesale", () => {
		const { config, issues } = parseConfig([
			{ roles: { reviewer: { promptFile: "/g/reviewer.md" }, security: { prompt: "global" } } },
			{ roles: { reviewer: { prompt: "project" } } },
		]);
		expect(issues).toEqual([]);
		expect(config.roles).toEqual({ reviewer: { prompt: "project" }, security: { prompt: "global" } });
	});

	it("does not share state with the defaults between calls", () => {
		const first = merged();
		first.presets.solo!.advisors.push({ model: "current" });
		expect(merged().presets.solo!.advisors).toHaveLength(1);
		expect(DEFAULT_PRESET.advisors).toHaveLength(1);
	});
});

describe("getPreset", () => {
	it("only finds own presets, never prototype members", () => {
		const config = merged();
		expect(getPreset(config, "solo")).toEqual(DEFAULT_PRESET);
		for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			expect(getPreset(config, name)).toBeUndefined();
		}
	});
});

describe("parseConfig", () => {
	it("defaults are valid", () => {
		expect(parseConfig([]).issues).toEqual([]);
	});

	it("scopes preset issues so other presets stay usable", () => {
		const { issues } = parseConfig([{ presets: { bad: { timeoutMs: -1 } } }]);
		expect(issuesFor(issues, "solo")).toEqual([]);
		expect(issuesFor(issues, "bad")).toHaveLength(1);
	});

	it("global issues block every preset", () => {
		const { issues } = parseConfig([{ budget: { onExceed: "explode" } }]);
		expect(issuesFor(issues, "solo")).toHaveLength(1);
	});
});
