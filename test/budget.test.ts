import { describe, expect, it } from "vitest";
import { branchSpend, budgetAction, BudgetTracker, recordSpend, spendText, type SpendEntry } from "../src/budget.ts";
import { RECORD_ENTRY } from "../src/round.ts";

const advisor = (costUsd?: number, extra: Record<string, unknown> = {}) => ({ label: "A", ok: true, ...(costUsd !== undefined && { costUsd }), ...extra });
const record = (...advisors: unknown[]) => ({ preset: "solo", reason: "user_turn", turn: "t", step: 0, advisors });
const roundEntry = (data: unknown): SpendEntry => ({ type: "custom", customType: RECORD_ENTRY, data });
const consultEntry = (details: unknown, toolName = "consult"): SpendEntry => ({
	type: "message",
	message: { role: "toolResult", toolName, toolCallId: "c", content: [], isError: false, timestamp: 1, details },
});

describe("recordSpend", () => {
	it("sums known costs and counts unknown ones", () => {
		expect(recordSpend(record(advisor(0.01), advisor(0.02), advisor(), advisor(undefined, { ok: false, error: "timeout" })))).toEqual({
			usd: 0.03,
			unknown: 1,
		});
		// A failed call that reported usage without a cost is unknown too.
		expect(recordSpend(record(advisor(undefined, { ok: false, usage: {} })))).toEqual({ usd: 0, unknown: 1 });
		expect(recordSpend(undefined)).toEqual({ usd: 0, unknown: 0 });
		expect(recordSpend({ advisors: "x" })).toEqual({ usd: 0, unknown: 0 });
	});
});

describe("branchSpend", () => {
	it("counts round records and consult details, interrupted ones included, and nothing else", () => {
		const branch: SpendEntry[] = [
			roundEntry(record(advisor(0.01))),
			roundEntry({ ...record(advisor(0.005, { ok: false, error: "aborted" })), interrupted: true }),
			consultEntry(record(advisor(0.1))),
			consultEntry(record(advisor(5)), "bash"),
			{ type: "custom", customType: "moa-state", data: record(advisor(7)) },
			{ type: "message", message: { role: "assistant", content: [] } },
			consultEntry(undefined),
		];
		const spend = branchSpend(branch, RECORD_ENTRY);
		expect(spend.usd).toBeCloseTo(0.115);
		expect(spend.unknown).toBe(0);
	});
});

describe("budgetAction", () => {
	it("applies onExceed at or over the limit; 0 means no limit", () => {
		expect(budgetAction({ sessionUsd: 1, onExceed: "pause" }, 0.99)).toBe("run");
		expect(budgetAction({ sessionUsd: 1, onExceed: "pause" }, 1)).toBe("pause");
		expect(budgetAction({ sessionUsd: 1, onExceed: "stop" }, 2)).toBe("stop");
		expect(budgetAction({ sessionUsd: 0, onExceed: "stop" }, 100)).toBe("run");
	});
});

describe("BudgetTracker", () => {
	it("adds records live and notifies once until reset", () => {
		const tracker = new BudgetTracker();
		tracker.add(record(advisor(0.01)));
		tracker.add(record(advisor()));
		expect(tracker.spend).toEqual({ usd: 0.01, unknown: 1 });
		expect(tracker.firstNotice()).toBe(true);
		expect(tracker.firstNotice()).toBe(false);
		tracker.reset({ usd: 2, unknown: 0 });
		expect(tracker.spend.usd).toBe(2);
		expect(tracker.firstNotice()).toBe(true);
	});
});

describe("spendText", () => {
	it("shows spend, limit and unknown costs", () => {
		expect(spendText({ usd: 0.0123, unknown: 0 }, { sessionUsd: 5, onExceed: "warn" })).toBe(
			"advisor spend this session: $0.0123 of $5.00 (warn when reached)",
		);
		expect(spendText({ usd: 1.5, unknown: 2 }, { sessionUsd: 0, onExceed: "warn" })).toBe(
			"advisor spend this session: $1.50 (no limit); some advisor costs unknown (2 calls)",
		);
	});
});

describe("recordSpend with synthesis", () => {
	it("adds the synthesis call's cost and counts it when unknown", () => {
		expect(recordSpend({ ...record(advisor(0.01)), synthesis: advisor(0.002) })).toEqual({ usd: 0.012, unknown: 0 });
		expect(recordSpend({ ...record(advisor(0.01)), synthesis: advisor() })).toEqual({ usd: 0.01, unknown: 1 });
	});
});
