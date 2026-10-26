import { describe, expect, it } from "vitest";
import { bumpEffort, EFFORT_PROFILES, minEffort, roundEffort, slotEffort } from "../src/effort.ts";
import { DEFAULT_PRESET, EFFORT_LEVELS } from "../src/schema.ts";

describe("effort profiles", () => {
	it("raise thinking and the output cap together, with length guidance below the cap", () => {
		expect(EFFORT_LEVELS.map((l) => [EFFORT_PROFILES[l].thinking, EFFORT_PROFILES[l].maxTokens])).toEqual([
			["low", 1024],
			["medium", 2048],
			["high", 4096],
			["max", 8192],
		]);
		expect(EFFORT_PROFILES.low.lengthLine).toMatch(/120 words/);
		expect(EFFORT_PROFILES.medium.lengthLine).toMatch(/300 words/);
		expect(EFFORT_PROFILES.high.lengthLine).toMatch(/600 words/);
		expect(EFFORT_PROFILES.max.lengthLine).toMatch(/No length limit/);
	});

	it("bumps one level and stops at max", () => {
		expect(EFFORT_LEVELS.map(bumpEffort)).toEqual(["medium", "high", "max", "max"]);
		expect(minEffort("high", "medium")).toBe("medium");
		expect(minEffort("low", "max")).toBe("low");
	});
});

describe("roundEffort", () => {
	const preset = { effort: "medium" as const, maxEffort: "max" as const };

	it("uses the slot's effort over the preset's", () => {
		expect(roundEffort(preset, {}, "user_turn")).toBe("medium");
		expect(roundEffort(preset, { effort: "low" }, "user_turn")).toBe("low");
	});

	it("runs on_failure, before_done and consult rounds one level higher, cadence rounds at the base", () => {
		for (const reason of ["on_failure", "before_done", "consult"] as const) expect(roundEffort(preset, {}, reason)).toBe("high");
		for (const reason of ["user_turn", "every_step", "every_n"] as const) expect(roundEffort(preset, {}, reason)).toBe("medium");
	});

	it("takes a requested level as is, and never exceeds maxEffort", () => {
		expect(roundEffort(preset, {}, "consult", "low")).toBe("low");
		expect(roundEffort(preset, {}, "user_turn", "max")).toBe("max");
		const capped = { effort: "medium" as const, maxEffort: "medium" as const };
		expect(roundEffort(capped, {}, "on_failure")).toBe("medium");
		expect(roundEffort(capped, { effort: "high" }, "user_turn")).toBe("medium");
		expect(roundEffort(capped, {}, "consult", "max")).toBe("medium");
	});

	it("the default preset is medium with no cap below max", () => {
		expect(roundEffort(DEFAULT_PRESET, DEFAULT_PRESET.advisors[0]!, "on_failure")).toBe("high");
	});
});

describe("slotEffort", () => {
	it("fills thinking, maxTokens and the length line from the level unless the slot sets them", () => {
		expect(slotEffort("high", {})).toEqual({ level: "high", thinking: "high", maxTokens: 4096, lengthLine: EFFORT_PROFILES.high.lengthLine });
		expect(slotEffort("high", { thinking: "off", maxTokens: 500 })).toMatchObject({ thinking: "off", maxTokens: 500 });
	});

	it("keeps the actor's thinking for native slots unless the slot opts in with effort or thinking", () => {
		expect(slotEffort("high", {}, true).thinking).toBeUndefined();
		expect(slotEffort("high", {}, true).maxTokens).toBe(4096);
		expect(slotEffort("high", { effort: "high" }, true).thinking).toBe("high");
		expect(slotEffort("high", { thinking: "low" }, true).thinking).toBe("low");
	});
});
