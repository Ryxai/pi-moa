import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisors.ts";
import {
	advisorLine,
	asRecord,
	cardLine,
	consultCallText,
	formatLatency,
	formatTokens,
	isExpanded,
	progressText,
	recordComponent,
	renderConsultResult,
	renderEntry,
	reviewMessageText,
	statusLine,
	type ThemeLike,
} from "../src/render.ts";
import type { MoaRecord } from "../src/round.ts";
import { fakeTheme, plainTheme, usage } from "./fixtures.ts";

const theme = fakeTheme as unknown as ThemeLike & { bg: typeof fakeTheme.bg };
const plain = plainTheme as unknown as typeof theme;

const ok = (label: string, extra: Partial<AdvisorResult> = {}): AdvisorResult => ({
	label,
	model: "openai/gpt",
	role: "advisor",
	ok: true,
	text: "**Check** the config.",
	usage: usage(0.004),
	costUsd: 0.004,
	latencyMs: 2100,
	...extra,
});
const failed = (label: string, error = "timeout after 90s"): AdvisorResult => ({ label, model: "anthropic/sonnet", role: "critic", ok: false, error, latencyMs: 4100 });
const record = (advisors: AdvisorResult[], extra: Partial<MoaRecord> = {}): MoaRecord => ({ preset: "solo", reason: "user_turn", turn: "t", step: 2, advisors, ...extra });
const lines = (component: { render(width: number): string[] }, width = 100) => component.render(width).map((l) => l.trimEnd());

describe("formatting", () => {
	it("formats latency and tokens compactly", () => {
		expect([formatLatency(850), formatLatency(4100), formatLatency(12_345)]).toEqual(["850ms", "4.1s", "12.3s"]);
		expect([formatTokens(999), formatTokens(12_300), formatTokens(2_500_000)]).toEqual(["999", "12.3k", "2.5M"]);
	});

	it("progress text", () => {
		expect(progressText(1, 3)).toBe("MoA: advisors 1/3…");
	});
});

describe("cardLine", () => {
	it("summarises reason, step, advisors, cost and the slowest latency", () => {
		expect(cardLine(record([ok("Advisor A"), ok("Advisor B", { latencyMs: 4100, costUsd: 0.008 })]), plain)).toBe(
			"◇ MoA · user_turn · step 2 · 2/2 advisors · $0.0120 · 4.1s",
		);
	});

	it("colours partial and total failure, marks interrupted rounds and unknown cost", () => {
		const partial = cardLine(record([ok("Advisor A", { costUsd: undefined }), failed("Advisor B")], { interrupted: true }), theme);
		expect(partial).toContain("<warning>1/2 advisors</warning>");
		expect(partial).toContain("<muted>cost ?</muted>");
		expect(partial).toContain("<warning>interrupted</warning>");
		expect(cardLine(record([failed("Advisor A")]), theme)).toContain("<error>0/1 advisor</error>");
		expect(cardLine(record([ok("A"), ok("B", { costUsd: undefined })]), plain)).toContain("$0.0040+?");
	});

	it("uses theme colours, not raw ANSI", () => {
		expect(cardLine(record([ok("Advisor A")]), theme)).not.toContain("\x1b");
		expect(cardLine(record([ok("Advisor A")]), theme)).toContain("<accent>◇ MoA</accent>");
	});
});

describe("advisorLine", () => {
	it("shows label, model, role, tokens, cost, latency and flags", () => {
		const line = advisorLine(ok("Advisor A", { usage: { ...usage(0.004), input: 200, cacheRead: 12_000, output: 340 }, retried: true, sanitized: true, truncated: true }), plain);
		expect(line).toBe("Advisor A · openai/gpt · advisor · 12.2k in (12.0k cached) / 340 out · $0.0040 · 2.1s · retried, sanitized, truncated");
	});

	it("adds the error on a second line for failures", () => {
		expect(advisorLine(failed("Advisor B"), theme)).toMatch(/\n<error>error: timeout after 90s<\/error>$/);
	});
});

describe("recordComponent", () => {
	const r = record([ok("Advisor A"), failed("Advisor B")], { reason: "consult", question: "Is the plan sound?" });

	it("is one line collapsed", () => {
		expect(lines(recordComponent(r, false, plain))).toEqual([cardLine(r, plain)]);
	});

	it("lists each advisor with its advice as markdown when expanded", () => {
		const out = lines(recordComponent(r, true, theme)).join("\n");
		expect(out).toContain("Question: Is the plan sound?");
		expect(out).toContain("<b>Advisor A</b>");
		expect(out).toContain("<b>Check</b> the config.");
		expect(out).not.toContain("**Check**");
		expect(out).toContain("error: timeout after 90s");
		expect(out.indexOf("Advisor A")).toBeLessThan(out.indexOf("Advisor B"));
	});

	it("renders fenced code even without pi's global theme", () => {
		const r2 = record([ok("Advisor A", { text: "```ts\nconst x = 1;\n```" })]);
		expect(lines(recordComponent(r2, true, plain)).join("\n")).toContain("const x = 1;");
	});
});

describe("renderEntry", () => {
	const r = record([ok("Advisor A")]);

	it("follows pi's expand toggle when collapsed, is always expanded in expanded mode", () => {
		expect([isExpanded("collapsed", false), isExpanded("collapsed", true), isExpanded("expanded", false), isExpanded("hidden", true)]).toEqual([false, true, true, false]);
		expect(lines(renderEntry(r, false, "collapsed", plain)!).join("\n")).not.toContain("Check");
		expect(lines(renderEntry(r, true, "collapsed", plain)!).join("\n")).toContain("Check");
		expect(lines(renderEntry(r, false, "expanded", plain)!).join("\n")).toContain("Check");
	});

	it("renders nothing in hidden mode or for malformed data", () => {
		expect(renderEntry(r, true, "hidden", plain)).toBeUndefined();
		for (const bad of [undefined, null, "x", {}, { reason: "user_turn", advisors: [1] }, { advisors: [] }, { reason: "user_turn", advisors: [{ label: "A", ok: true }] }]) {
			expect(renderEntry(bad, true, "collapsed", plain)).toBeUndefined();
			expect(asRecord(bad)).toBeUndefined();
		}
	});

	it("uses the custom message background", () => {
		expect(renderEntry(r, false, "collapsed", theme)!.render(80).join("")).toContain("<bg:customMessageBg>");
	});
});

describe("consult rendering", () => {
	it("renders the call with its question, shortened", () => {
		expect(consultCallText(undefined, plain)).toBe("consult");
		expect(consultCallText("  why\n  this? ", plain)).toBe('consult "why this?"');
		expect(consultCallText("x".repeat(300), plain)).toHaveLength('consult ""'.length + 120);
	});

	const result = (details?: MoaRecord, t = "Advisor A (advisor):\nCheck the config.") => ({ content: [{ type: "text", text: t }], details });
	const done = { expanded: false, isPartial: false };

	it("shows the card from details, advice only when expanded, never in hidden mode", () => {
		const r = record([ok("Advisor A")], { reason: "consult" });
		expect(lines(renderConsultResult(result(r), done, "collapsed", plain))).toEqual([cardLine(r, plain)]);
		expect(lines(renderConsultResult(result(r), { ...done, expanded: true }, "collapsed", plain)).join("\n")).toContain("Check the config.");
		expect(lines(renderConsultResult(result(r), done, "expanded", plain)).join("\n")).toContain("Check the config.");
		expect(lines(renderConsultResult(result(r), { ...done, expanded: true }, "hidden", plain))).toEqual([cardLine(r, plain)]);
	});

	it("shows the result text when no round ran, and progress while partial", () => {
		expect(lines(renderConsultResult(result(undefined, "consult limit reached for this turn (3)."), done, "collapsed", theme))[0]).toContain(
			"<muted>consult limit reached",
		);
		expect(lines(renderConsultResult(result(undefined, "consult failed: x"), { ...done, isError: true }, "collapsed", theme))[0]).toContain("<error>");
		expect(lines(renderConsultResult(result(undefined, "Consulting advisors…"), { ...done, isPartial: true }, "collapsed", plain))[0]).toBe("Consulting advisors…");
	});
});

describe("statusLine", () => {
	const budget = { sessionUsd: 1, onExceed: "warn" as const };
	it("shows the preset, spend when non-zero, and a marker once the budget is reached", () => {
		expect(statusLine("solo", { usd: 0, unknown: 2 }, budget)).toBe("moa:solo");
		expect(statusLine("solo", { usd: 0.0123, unknown: 0 }, budget)).toBe("moa:solo · $0.0123");
		expect(statusLine("solo", { usd: 1.5, unknown: 0 }, budget)).toBe("moa:solo · $1.50 · budget reached");
		expect(statusLine("solo", { usd: 1.5, unknown: 0 }, { sessionUsd: 0, onExceed: "warn" })).toBe("moa:solo · $1.50");
		expect(statusLine("solo", { usd: 1.5, unknown: 0 }, undefined)).toBe("moa:solo · $1.50");
	});
});

describe("verdicts, effort, capped replies and synthesis", () => {
	it("cardLine shows the verdicts, most severe first, and the synthesis state", () => {
		const r = record([ok("A", { verdict: "on-track" }), ok("B", { verdict: "revise" }), ok("C", { verdict: "revise" })]);
		expect(cardLine(r, plain)).toContain("3/3 advisors · revise ×2, on-track");
		expect(cardLine(r, theme)).toContain("<warning>revise ×2, on-track</warning>");
		expect(cardLine(record([ok("A", { verdict: "blocked" })]), theme)).toContain("<error>blocked</error>");
		expect(cardLine(record([ok("A")]), plain)).not.toContain("on-track");
		const silent = { ...ok("synthesis", { silent: true, text: undefined, latencyMs: 9000 }), role: "synthesis" };
		expect(cardLine(record([ok("A"), ok("B")], { synthesis: silent }), plain)).toContain("synthesis: nothing to reconcile");
		expect(cardLine(record([ok("A"), ok("B")], { synthesis: silent }), plain)).toContain("9.0s");
		expect(cardLine(record([ok("A"), ok("B")], { synthesis: { ...ok("synthesis", { verdict: "revise" }), role: "synthesis" } }), plain)).toContain("· synthesis ·");
		expect(cardLine(record([ok("A"), ok("B")], { synthesis: failed("synthesis") }), theme)).toContain("<warning>synthesis failed</warning>");
	});

	it("advisorLine shows effort, verdict and the capped flag", () => {
		const line = advisorLine(ok("Advisor A", { effort: "high", verdict: "revise", capped: true }), theme);
		expect(line).toContain("<muted>effort high</muted>");
		expect(line).toContain("<warning>revise</warning>");
		expect(line).toContain("<warning>capped</warning>");
		expect(advisorLine({ ...ok("synthesis", { silent: true, text: undefined }), role: "synthesis" }, plain)).toContain("nothing to reconcile");
	});

	it("recordComponent lists the synthesis after the advisors when expanded", () => {
		const synthesis = { ...ok("synthesis", { text: "Reconciled: do A." }), role: "synthesis" };
		const out = lines(recordComponent(record([ok("A"), ok("B")], { synthesis }), true, plain)).join("\n");
		expect(out.indexOf("synthesis · openai/gpt")).toBeGreaterThan(out.indexOf("B · openai/gpt"));
		expect(out).toContain("Reconciled: do A.");
	});

	it("reviewMessageText is a one-line note", () => {
		expect(reviewMessageText(plain)).toBe("◇ MoA · before_done review sent to the agent; it continues working (see the round above)");
	});
});
