import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisors.ts";
import { endsTurn, REVIEW_PREAMBLE, REVIEW_REQUEST, reviewVerdict, shouldContinue } from "../src/review.ts";
import { assistant, text, user } from "./fixtures.ts";

const ok = (verdict?: AdvisorResult["verdict"], extra: Partial<AdvisorResult> = {}): AdvisorResult => ({
	label: "A",
	model: "m/x",
	role: "reviewer",
	ok: true,
	text: "advice",
	...(verdict && { verdict }),
	latencyMs: 1,
	...extra,
});
const failed: AdvisorResult = { label: "B", model: "m/y", role: "critic", ok: false, error: "timeout", latencyMs: 1 };

describe("endsTurn", () => {
	it("is a completed assistant reply without tool calls", () => {
		expect(endsTurn(assistant([text("Done.")]))).toBe(true);
		expect(endsTurn(assistant([text("Working…"), { type: "toolCall", id: "c", name: "bash", arguments: {} }], { stopReason: "toolUse" }))).toBe(false);
		expect(endsTurn(assistant([text("Done.")], { stopReason: "length" }))).toBe(false);
		expect(endsTurn(assistant([], { stopReason: "error" }))).toBe(false);
		expect(endsTurn(user("hi"))).toBe(false);
	});
});

describe("reviewVerdict and shouldContinue", () => {
	it("revise wins over blocked wins over on-track among the advisors", () => {
		expect(reviewVerdict([ok("on-track"), ok("revise"), failed])).toBe("revise");
		expect(reviewVerdict([ok("on-track"), ok("blocked")])).toBe("blocked");
		expect(reviewVerdict([ok("on-track"), ok(undefined)])).toBe("on-track");
		expect(reviewVerdict([ok(undefined), failed])).toBeUndefined();
	});

	it("a synthesis that spoke with a verdict decides; a silent or verdict-less one does not", () => {
		const synthesis = ok("on-track", { label: "synthesis", role: "synthesis" });
		expect(reviewVerdict([ok("revise"), ok("on-track")], synthesis)).toBe("on-track");
		expect(reviewVerdict([ok("revise"), ok("on-track")], { ...synthesis, text: undefined, silent: true })).toBe("revise");
		expect(reviewVerdict([ok("revise"), ok("on-track")], ok(undefined, { label: "synthesis" }))).toBe("revise");
	});

	it("continues only on revise", () => {
		expect(shouldContinue([ok("revise")])).toBe(true);
		expect(shouldContinue([ok("blocked")])).toBe(false);
		expect(shouldContinue([ok("on-track")])).toBe(false);
		expect(shouldContinue([ok(undefined)])).toBe(false);
		expect(shouldContinue([])).toBe(false);
	});

	it("the request and preamble explain the review", () => {
		expect(REVIEW_REQUEST).toMatch(/ends its turn/);
		expect(REVIEW_REQUEST).toMatch(/"Verdict: revise" only if the agent should continue/);
		expect(REVIEW_PREAMBLE).toMatch(/would have ended the turn/);
	});
});
