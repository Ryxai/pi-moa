import { VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
	branchRouteState,
	isVirtual,
	latestResponseModel,
	planVirtualModels,
	presetOfModel,
	resolveActor,
	routeRequest,
	trackSelection,
	trackSession,
	type RouteRequestLike,
} from "../src/virtual.ts";
import { assistant, text, user } from "./fixtures.ts";

interface M {
	provider: string;
	id: string;
	api?: string;
}

const sonnet: M = { provider: "anthropic", id: "sonnet" };
const gpt: M = { provider: "openai", id: "gpt" };
const moaSolo: M = { provider: "moa", id: "solo", api: "pi-virtual" };
const jev: M = { provider: "jev", id: "auto", api: "pi-virtual" };

const lookup = (models: M[] = [sonnet, gpt], auth = true) => ({
	find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	hasConfiguredAuth: () => auth,
});

const current = { actor: "current" };
const fixed = { actor: "openai/gpt" };
const req = (extra: Partial<RouteRequestLike<M>> = {}): RouteRequestLike<M> => ({ reason: "user", thinkingLevel: "high", ...extra });

describe("planVirtualModels", () => {
	const plan = (layer: unknown) => {
		const parsed = parseConfig([layer]);
		return planVirtualModels(parsed.config, parsed.issues);
	};

	it("registers none unless virtualModels is true", () => {
		expect(plan({ presets: { council: {} } })).toEqual({ valid: [], invalid: [] });
	});

	it("lists every valid preset", () => {
		expect(plan({ virtualModels: true, presets: { council: {}, "fast.v2": {} } }).valid).toEqual(["solo", "council", "fast.v2"]);
	});

	it("reports names unusable as model ids and presets with issues", () => {
		const result = plan({ virtualModels: true, presets: { "my preset": {}, "a:b": {}, "x/y": {}, broken: { timeoutMs: -1 } } });
		expect(result.valid).toEqual(["solo"]);
		expect(result.invalid.map((i) => i.name)).toEqual(["my preset", "a:b", "x/y", "broken"]);
		expect(result.invalid[0]?.reason).toContain("not usable as a model id");
		expect(result.invalid[3]?.reason).toBe("has config issues");
	});
});

describe("model helpers", () => {
	it("recognises moa and other virtual models", () => {
		expect(isVirtual(moaSolo)).toBe(true);
		expect(isVirtual(jev)).toBe(true);
		expect(isVirtual(sonnet)).toBe(false);
		expect(presetOfModel(moaSolo)).toBe("solo");
		expect(presetOfModel(jev)).toBeUndefined();
		expect(presetOfModel(undefined)).toBeUndefined();
	});

	it("reads the route state pi stored for the preset", () => {
		const entry = (modelId: string, state: unknown) => ({ type: "custom", customType: VIRTUAL_MODEL_STATE_ENTRY, data: { provider: "moa", modelId, state } });
		const branch = [entry("solo", { actor: "openai/gpt" }), entry("other", { actor: "x/y" }), entry("solo", { actor: "anthropic/sonnet" })];
		expect(branchRouteState(branch, "solo")).toEqual({ actor: "anthropic/sonnet" });
		expect(branchRouteState(branch, "council")).toBeUndefined();
		expect(branchRouteState([entry("solo", "junk")], "solo")).toBeUndefined();
	});

	it("finds the physical model of the latest successful response", () => {
		const reply = (provider: string, model: string, stopReason: "stop" | "error" = "stop") => assistant([text("x")], { provider, model, stopReason });
		expect(latestResponseModel([user("hi"), reply("openai", "gpt"), reply("anthropic", "sonnet", "error")], lookup())).toBe(gpt);
		expect(latestResponseModel([user("hi")], lookup())).toBeUndefined();
	});
});

describe("selection tracking", () => {
	it("tracks physical selections and the model left for a moa model", () => {
		let t = trackSelection(undefined, { model: sonnet, previousModel: undefined, source: "set" });
		expect(t).toEqual({ model: sonnet, fresh: true });
		t = trackSelection(undefined, { model: moaSolo, previousModel: gpt, source: "set" });
		expect(t).toEqual({ model: gpt, fresh: true });
	});

	it("ignores restores and switches from other virtual models", () => {
		const t = { model: sonnet, fresh: true };
		expect(trackSelection(t, { model: moaSolo, previousModel: gpt, source: "restore" })).toBe(t);
		expect(trackSelection(t, { model: moaSolo, previousModel: jev, source: "set" })).toBe(t);
		expect(trackSelection(t, { model: jev, previousModel: gpt, source: "set" })).toBe(t);
	});

	it("keeps an earlier selection as a stale fallback across sessions", () => {
		expect(trackSession({ model: sonnet, fresh: true }, moaSolo)).toEqual({ model: sonnet, fresh: false });
		expect(trackSession({ model: sonnet, fresh: false }, gpt)).toEqual({ model: gpt, fresh: true });
		expect(trackSession(undefined, moaSolo)).toBeUndefined();
	});
});

describe("resolveActor", () => {
	it("uses a concrete actor and reports a missing one", () => {
		expect(resolveActor(fixed, lookup(), {})).toEqual({ ok: true, model: gpt });
		expect(resolveActor({ actor: "openai/none" }, lookup(), {})).toEqual({ ok: false, error: 'actor: model "openai/none" not found' });
	});

	it('resolves "current" as fresh selection, then state, then stale selection, then previous', () => {
		const state = { actor: "openai/gpt" };
		expect(resolveActor(current, lookup(), { tracked: { model: sonnet, fresh: true }, state })).toMatchObject({ model: sonnet });
		expect(resolveActor(current, lookup(), { tracked: { model: sonnet, fresh: false }, state })).toMatchObject({ model: gpt });
		expect(resolveActor(current, lookup(), { tracked: { model: sonnet, fresh: false } })).toMatchObject({ model: sonnet });
		expect(resolveActor(current, lookup(), { previous: gpt })).toEqual({ ok: true, model: gpt, state: { actor: "openai/gpt" } });
	});

	it("errors when nothing is known or credentials are missing", () => {
		const unknown = resolveActor(current, lookup(), {});
		expect(unknown.ok).toBe(false);
		expect(!unknown.ok && unknown.error).toContain("no physical model known yet");
		expect(resolveActor(current, lookup([sonnet], false), { previous: sonnet })).toMatchObject({ ok: false, error: expect.stringContaining("no credentials") });
	});
});

describe("routeRequest", () => {
	it("routes a concrete actor with the selected level and no state", () => {
		expect(routeRequest(fixed, lookup(), req(), undefined)).toEqual({ model: gpt, thinkingLevel: "high" });
	});

	it('routes "current" to the tracked model and stores it as state', () => {
		expect(routeRequest(current, lookup(), req(), { model: sonnet, fresh: true })).toEqual({
			model: sonnet,
			thinkingLevel: "high",
			state: { actor: "anthropic/sonnet" },
		});
	});

	it("returns no new state when it is unchanged", () => {
		const route = routeRequest(current, lookup(), req({ state: { actor: "anthropic/sonnet" } }), { model: sonnet, fresh: true });
		expect(route).toEqual({ model: sonnet, thinkingLevel: "high" });
	});

	it("uses the stored state after a resume and falls back to request.previous", () => {
		expect(routeRequest(current, lookup(), req({ state: { actor: "openai/gpt" } }), undefined).model).toBe(gpt);
		expect(routeRequest(current, lookup(), req({ previous: { model: sonnet, thinkingLevel: "low" } }), undefined)).toEqual({
			model: sonnet,
			thinkingLevel: "high",
			state: { actor: "anthropic/sonnet" },
		});
	});

	it("throws when no actor is known", () => {
		expect(() => routeRequest(current, lookup(), req(), undefined)).toThrow(/MoA: actor "current": no physical model known yet/);
	});

	it("keeps continuations and retries on the model and level that handled the turn", () => {
		const tracked = { model: gpt, fresh: true };
		const state = { actor: "openai/gpt" };
		expect(routeRequest(current, lookup(), req({ reason: "continuation", state, previous: { model: gpt, thinkingLevel: "medium" } }), tracked)).toEqual({
			model: gpt,
			thinkingLevel: "medium",
		});
		expect(routeRequest(current, lookup(), req({ reason: "retry", state, failed: { model: gpt, thinkingLevel: "low" } }), tracked)).toEqual({
			model: gpt,
			thinkingLevel: "low",
		});
		// The previous response came from another model (before switching to moa/*): route to the actor.
		expect(routeRequest(fixed, lookup(), req({ reason: "continuation", previous: { model: sonnet } }), undefined).model).toBe(gpt);
		// Unresolvable actor: stay on the model that handled the turn rather than failing it.
		expect(routeRequest({ actor: "openai/none" }, lookup(), req({ reason: "continuation", previous: { model: sonnet } }), undefined).model).toBe(sonnet);
	});
});
