import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { modelRefError } from "../src/config-validate.ts";

function messages(layer: unknown): string[] {
	return parseConfig([layer]).issues.map((i) => `${i.path}: ${i.message}`);
}

function expectIssue(layer: unknown, path: string, fragment: string): void {
	const found = messages(layer);
	expect(found.some((m) => m.startsWith(`${path}:`) && m.includes(fragment)), found.join("\n")).toBe(true);
}

const advisor = (model = "current") => ({ model });

describe("validateConfig", () => {
	it("allows at most 3 advisors and at least one", () => {
		expect(messages({ presets: { solo: { advisors: [advisor(), advisor(), advisor()] } } })).toEqual([]);
		expectIssue({ presets: { solo: { advisors: [advisor(), advisor(), advisor(), advisor()] } } }, "presets.solo.advisors", "at most 3");
		expectIssue({ presets: { solo: { advisors: [] } } }, "presets.solo.advisors", "at least one");
	});

	it("checks context.nativeToolChoice", () => {
		expect(messages({ presets: { solo: { context: { nativeToolChoice: "none" } } } })).toEqual([]);
		expectIssue({ presets: { solo: { context: { nativeToolChoice: "auto" } } } }, "presets.solo.context.nativeToolChoice", "must be one of");
	});

	it("rejects moa/* models in advisor and actor slots", () => {
		expectIssue({ presets: { solo: { advisors: [advisor("moa/solo")] } } }, "presets.solo.advisors[0].model", "moa/*");
		expectIssue({ presets: { solo: { actor: "moa/council" } } }, "presets.solo.actor", "moa/*");
	});

	it("requires model strings to be current or provider/id", () => {
		for (const bad of ["gpt-5", "/x", "openai/", 42]) {
			expectIssue({ presets: { solo: { advisors: [{ model: bad }] } } }, "presets.solo.advisors[0].model", "provider/id");
		}
		expect(modelRefError("openrouter/anthropic/claude-x")).toBeUndefined();
		expect(modelRefError("current")).toBeUndefined();
	});

	it("reports unknown roles and accepts configured ones", () => {
		expectIssue({ presets: { solo: { advisors: [{ model: "current", role: "security" }] } } }, "presets.solo.advisors[0].role", 'unknown role "security"');
		const ok = { roles: { security: { prompt: "Focus on auth." } }, presets: { solo: { advisors: [{ model: "current", role: "security" }] } } };
		expect(messages(ok)).toEqual([]);
	});

	it("checks role definitions", () => {
		expectIssue({ roles: { security: {} } }, "roles.security", 'needs "prompt" or "promptFile"');
		expectIssue({ roles: { x: { prompt: "a", promptFile: "b" } } }, "roles.x", "not both");
		expect(messages({ roles: { reviewer: { replaceBase: true } } })).toEqual([]);
	});

	it("validates triggers including every_n", () => {
		expect(messages({ presets: { solo: { triggers: ["user_turn", { every_n: 3 }, "on_failure", "every_step"] } } })).toEqual([]);
		expectIssue({ presets: { solo: { triggers: ["sometimes"] } } }, "presets.solo.triggers[0]", "must be one of");
		expectIssue({ presets: { solo: { triggers: [{ every_n: 0 }] } } }, "presets.solo.triggers[0].every_n", "integer from 1");
		expectIssue({ presets: { solo: { triggers: [{ every_n: 2.5 }] } } }, "presets.solo.triggers[0].every_n", "integer");
		expectIssue({ presets: { solo: { triggers: [{ every: 2 }] } } }, "presets.solo.triggers[0]", "every_n");
	});

	it("checks numeric ranges", () => {
		expectIssue({ presets: { solo: { timeoutMs: 10 } } }, "presets.solo.timeoutMs", "integer from 1000");
		expectIssue({ presets: { solo: { onFailure: { repeatedCalls: 1 } } } }, "presets.solo.onFailure.repeatedCalls", "from 2");
		expectIssue({ presets: { solo: { consult: { maxPerTurn: -1 } } } }, "presets.solo.consult.maxPerTurn", "from 0");
		expectIssue({ presets: { solo: { advisors: [{ model: "current", maxTokens: 0 }] } } }, "presets.solo.advisors[0].maxTokens", "from 1");
		expectIssue({ budget: { sessionUsd: -5 } }, "budget.sessionUsd", "≥ 0");
	});

	it("checks enums", () => {
		expectIssue({ presets: { solo: { advisors: [{ model: "current", stance: "maybe" }] } } }, "presets.solo.advisors[0].stance", "must be one of");
		expectIssue({ presets: { solo: { advisors: [{ model: "current", thinking: "huge" }] } } }, "presets.solo.advisors[0].thinking", "must be one of");
		expectIssue({ presets: { solo: { context: { view: "x" } } } }, "presets.solo.context.view", "must be one of");
		expectIssue({ presets: { solo: { context: { pin: ["everything"] } } } }, "presets.solo.context.pin[0]", "must be one of");
		expectIssue({ ui: { advice: "loud" } }, "ui.advice", "must be one of");
	});

	it("reports unknown keys (typos) and an unknown default preset", () => {
		expectIssue({ presets: { solo: { advisers: [] } } }, "presets.solo.advisers", "unknown key");
		expectIssue({ virtualModel: true }, "virtualModel", "unknown key");
		expectIssue({ defaultPreset: "nope" }, "defaultPreset", 'unknown preset "nope"');
		expectIssue({ defaultPreset: "toString" }, "defaultPreset", 'unknown preset "toString"');
		expectIssue({ defaultPreset: "constructor" }, "defaultPreset", 'unknown preset "constructor"');
	});

	it("reports reserved preset and role names", () => {
		const layer = JSON.parse('{"presets": {"constructor": {}, "__proto__": {}}, "roles": {"prototype": {"prompt": "x"}}}');
		expect(messages(layer)).toEqual([
			"presets.constructor: reserved name; choose another",
			"presets.__proto__: reserved name; choose another",
			"roles.prototype: reserved name; choose another",
		]);
	});

	it("reports wrong shapes without throwing", () => {
		expectIssue({ presets: { solo: null } }, "presets.solo", "must be an object");
		expectIssue({ presets: { solo: { advisors: "current" } } }, "presets.solo.advisors", "must be an array");
		expectIssue({ ui: { status: "yes" } }, "ui.status", "true or false");
	});
});

describe("effort, synthesis and before_done", () => {
	it("checks effort levels on presets and advisors", () => {
		expect(messages({ presets: { solo: { effort: "high", maxEffort: "max", advisors: [{ model: "current", effort: "low" }] } } })).toEqual([]);
		expectIssue({ presets: { solo: { effort: "ultra" } } }, "presets.solo.effort", "must be one of");
		expectIssue({ presets: { solo: { maxEffort: 3 } } }, "presets.solo.maxEffort", "must be one of");
		expectIssue({ presets: { solo: { advisors: [{ model: "current", effort: "xhigh" }] } } }, "presets.solo.advisors[0].effort", "must be one of");
	});

	it("checks the synthesis slot", () => {
		expect(messages({ presets: { solo: { synthesis: { model: "openai/gpt", thinking: "low", maxTokens: 500, prompt: "Be brief." } } } })).toEqual([]);
		expectIssue({ presets: { solo: { synthesis: "openai/gpt" } } }, "presets.solo.synthesis", "must be an object");
		expectIssue({ presets: { solo: { synthesis: { model: "moa/solo" } } } }, "presets.solo.synthesis.model", "moa/*");
		expectIssue({ presets: { solo: { synthesis: { model: "openai/gpt", role: "x" } } } }, "presets.solo.synthesis.role", "unknown key");
		expectIssue({ presets: { solo: { synthesis: { model: "openai/gpt", maxTokens: 0 } } } }, "presets.solo.synthesis.maxTokens", "integer");
		expectIssue({ presets: { solo: { synthesis: { model: "openai/gpt", prompt: " " } } } }, "presets.solo.synthesis.prompt", "non-empty");
	});

	it("accepts before_done as a trigger", () => {
		expect(messages({ presets: { solo: { triggers: ["user_turn", "before_done"] } } })).toEqual([]);
	});
});
