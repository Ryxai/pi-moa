import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, type PresetConfig } from "../src/config.ts";
import { resolveModel, resolvePreset, type ModelLike, type ModelLookup } from "../src/config-resolve.ts";

const m = (provider: string, id: string): ModelLike => ({ provider, id });
const sonnet = m("anthropic", "claude-sonnet");
const gpt = m("openai", "gpt-5.6");
const routed = m("openrouter", "meta/llama");
const noAuth = m("local", "unauthed");

const registry: ModelLookup<ModelLike> = {
	find: (provider, id) => [sonnet, gpt, routed, noAuth].find((x) => x.provider === provider && x.id === id),
	hasConfiguredAuth: (model) => model !== noAuth,
};

const preset = (overrides: Partial<PresetConfig>): PresetConfig => ({ ...DEFAULT_PRESET, ...overrides });

describe("resolveModel", () => {
	it('resolves "current" to the actor model', () => {
		expect(resolveModel("current", registry, sonnet)).toBe(sonnet);
	});

	it('fails "current" with no selected model', () => {
		expect(resolveModel("current", registry, undefined)).toMatch(/needs a selected model/);
	});

	it("splits provider at the first slash only", () => {
		expect(resolveModel("openrouter/meta/llama", registry, undefined)).toBe(routed);
	});

	it("reports unknown models and missing credentials", () => {
		expect(resolveModel("openai/nope", registry, sonnet)).toMatch(/not found/);
		expect(resolveModel("local/unauthed", registry, sonnet)).toMatch(/no credentials/);
		expect(resolveModel("current", registry, noAuth)).toMatch(/no credentials/);
	});
});

describe("resolvePreset", () => {
	it("resolves actor and advisors", () => {
		const result = resolvePreset(preset({ advisors: [{ model: "openai/gpt-5.6" }, { model: "current" }] }), registry, sonnet);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preset.actor).toBe(sonnet);
		expect(result.preset.advisors.map((a) => a.model)).toEqual([gpt, sonnet]);
	});

	it("collects every error with its slot", () => {
		const result = resolvePreset(preset({ actor: "openai/nope", advisors: [{ model: "current" }, { model: "local/unauthed" }] }), registry, sonnet);
		expect(result).toEqual({ ok: false, errors: ['actor: model "openai/nope" not found', 'advisor 2: no credentials configured for "local/unauthed"'] });
	});
});
