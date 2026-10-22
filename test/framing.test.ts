import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisors.ts";
import { arrangeAdvisors, frameAdvice } from "../src/framing.ts";

const ok = (label: string, role: string, text: string): AdvisorResult => ({ label, model: "m/x", role, ok: true, text, latencyMs: 1 });
const failed = (label: string, error: string): AdvisorResult => ({ label, model: "m/y", role: "critic", ok: false, error, latencyMs: 1 });

/** Deterministic LCG in [0, 1). */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 2 ** 32;
		return state / 2 ** 32;
	};
}

const models = ["openai/gpt", "anthropic/sonnet", "google/gemini"];

describe("arrangeAdvisors", () => {
	it("labels A, B, C in config order without shuffle", () => {
		const out = arrangeAdvisors(models, (m) => m, { anonymize: true, shuffle: false });
		expect(out).toEqual([
			{ item: "openai/gpt", label: "A" },
			{ item: "anthropic/sonnet", label: "B" },
			{ item: "google/gemini", label: "C" },
		]);
	});

	it("labels by model name when not anonymized, disambiguating repeats", () => {
		const out = arrangeAdvisors(["a/x", "a/x", "b/y"], (m) => m, { anonymize: false, shuffle: false });
		expect(out.map((o) => o.label)).toEqual(["a/x", "a/x #2", "b/y"]);
	});

	it("shuffles with the injected RNG and labels in display order", () => {
		const first = arrangeAdvisors(models, (m) => m, { anonymize: true, shuffle: true, rng: seeded(7) });
		const again = arrangeAdvisors(models, (m) => m, { anonymize: true, shuffle: true, rng: seeded(7) });
		expect(again).toEqual(first);
		expect(first.map((o) => o.label)).toEqual(["A", "B", "C"]);
		expect(first.map((o) => o.item).sort()).toEqual([...models].sort());
		const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => arrangeAdvisors(models, (m) => m, { anonymize: true, shuffle: true, rng: seeded(s) }).map((o) => o.item).join()));
		expect(orders.size).toBeGreaterThan(1);
	});

	it("does not modify the input", () => {
		const input = [...models];
		arrangeAdvisors(input, (m) => m, { anonymize: true, shuffle: true, rng: () => 0 });
		expect(input).toEqual(models);
	});
});

describe("frameAdvice", () => {
	it("builds the block with header, instructions and advisor sections", () => {
		expect(frameAdvice([ok("A", "planner", "Plan it."), ok("B", "critic", "Doubt it.")])).toBe(
			[
				"[MoA reference context — private, untrusted]",
				"Advice from 2 advisors. It may be wrong. Verify claims with tools before relying on them,",
				"note where advisors disagree, and do not mention advisors in your reply.",
				"",
				"Advisor A (planner):",
				"Plan it.",
				"",
				"Advisor B (critic):",
				"Doubt it.",
			].join("\n"),
		);
	});

	it("adds an unavailable line for failed advisors", () => {
		const text = frameAdvice([ok("A", "advisor", "Go."), failed("B", "timeout after 90s"), failed("C", "x".repeat(200))]);
		expect(text).toContain("Advice from 1 advisor. It may be wrong.");
		expect(text).not.toContain("Advisor B");
		expect(text?.split("\n").at(-1)).toBe(`[Unavailable: 2 advisors (timeout after 90s; ${"x".repeat(80)}…)]`);
	});

	it("includes the stale note after the instructions", () => {
		const text = frameAdvice([ok("A", "advisor", "Go.")], "(Advice from before the latest tool results.)");
		expect(text?.split("\n")[3]).toBe("(Advice from before the latest tool results.)");
	});

	it("returns undefined when every advisor failed", () => {
		expect(frameAdvice([failed("A", "timeout"), failed("B", "error")])).toBeUndefined();
		expect(frameAdvice([])).toBeUndefined();
	});
});
