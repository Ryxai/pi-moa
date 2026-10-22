import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisors.ts";
import { CONSULT_TOOL, ConsultCounter, consultWanted, executeConsult, syncConsultTool, type ConsultEnv } from "../src/consult.ts";
import { FRAMING_HEADER, STALE_NOTE } from "../src/framing.ts";
import type { MoaRecord, RoundOutput } from "../src/round.ts";
import { analyzeTurn } from "../src/triggers.ts";
import { assistant, system, text, toolResult, user, usage } from "./fixtures.ts";

describe("consultWanted", () => {
	it("needs a preset with consult enabled and a positive cap", () => {
		expect(consultWanted(undefined)).toBe(false);
		expect(consultWanted({ consult: { enabled: true, maxPerTurn: 3 } })).toBe(true);
		expect(consultWanted({ consult: { enabled: false, maxPerTurn: 3 } })).toBe(false);
		expect(consultWanted({ consult: { enabled: true, maxPerTurn: 0 } })).toBe(false);
	});
});

describe("syncConsultTool", () => {
	const tools = (active: string[]) => {
		const sets: string[][] = [];
		return {
			sets,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				sets.push(names);
				active = names;
			},
		};
	};

	it("adds and removes only the consult tool, keeping the others and their order", () => {
		const t = tools(["read", "bash", "mcp_x"]);
		syncConsultTool(t, true);
		syncConsultTool(t, false);
		expect(t.sets).toEqual([["read", "bash", "mcp_x", CONSULT_TOOL], ["read", "bash", "mcp_x"]]);
	});

	it("does not touch the active set when it already matches", () => {
		const t = tools(["read", CONSULT_TOOL]);
		syncConsultTool(t, true);
		syncConsultTool(tools(["read"]), false);
		expect(t.sets).toEqual([]);
	});
});

describe("ConsultCounter", () => {
	it("allows max calls per turn and starts over on a new turn", () => {
		const counter = new ConsultCounter();
		expect([1, 2, 3].map(() => counter.take("t1", 2))).toEqual([true, true, false]);
		expect(counter.take("t2", 2)).toBe(true);
		expect(counter.take("t1", 2)).toBe(true);
	});
});

const snapshot = [
	system("You are pi."),
	user("Fix the test", 10),
	assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], { stopReason: "toolUse" }),
	toolResult("bash", "1 failing", true),
];

const ok = (label: string, body: string, total = 0.01): AdvisorResult => ({
	label,
	model: "anthropic/sonnet",
	role: "advisor",
	ok: true,
	text: body,
	usage: usage(total),
	costUsd: total,
	latencyMs: 5,
});
const failed = (label: string, error: string): AdvisorResult => ({ label, model: "openai/gpt", role: "critic", ok: false, error, latencyMs: 5 });

function env(results: AdvisorResult[], overrides: Partial<ConsultEnv> & { interrupted?: boolean } = {}) {
	const runs: Parameters<ConsultEnv["run"]>[0][] = [];
	const e: ConsultEnv = {
		settings: { enabled: true, maxPerTurn: 2 },
		snapshot,
		counter: new ConsultCounter(),
		run: async (request): Promise<RoundOutput> => {
			runs.push(request);
			const record: MoaRecord = {
				preset: "solo",
				reason: "consult",
				...(request.question !== undefined && { question: request.question }),
				turn: request.turn,
				step: request.step,
				advisors: results,
			};
			if (overrides.interrupted) record.interrupted = true;
			return { results, interrupted: overrides.interrupted ?? false, record };
		},
		...overrides,
	};
	return { env: e, runs };
}

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text).join("");

describe("executeConsult", () => {
	it("runs the advisors on the snapshot with the trimmed question and returns the framed advice", async () => {
		const { env: e, runs } = env([ok("A", "Read the failing assertion."), failed("B", "timeout after 90s")]);
		const updates: string[] = [];
		const out = await executeConsult({ question: "  Is the fixture wrong?  " }, e, (u) => updates.push(textOf(u)));
		const analysis = analyzeTurn(snapshot);
		expect(runs).toEqual([{ messages: snapshot, question: "Is the fixture wrong?", turn: analysis.turnKey, step: 1 }]);
		expect(out.isError).toBeUndefined();
		const body = textOf(out);
		expect(body.startsWith(FRAMING_HEADER)).toBe(true);
		expect(body).toContain("Advisor A (advisor):\nRead the failing assertion.");
		expect(body).toContain("[Unavailable: 1 advisor (timeout after 90s)]");
		expect(body).not.toContain(STALE_NOTE);
		expect(out.details).toMatchObject({ reason: "consult", question: "Is the fixture wrong?", step: 1, advisors: [{ text: "Read the failing assertion." }, { error: "timeout after 90s" }] });
		expect(updates).toEqual(["Consulting advisors…"]);
	});

	it("appends the calling response to the snapshot", async () => {
		const caller = assistant([text("Plan: rewrite."), { type: "toolCall", id: "t1", name: "consult", arguments: {} }], { stopReason: "toolUse" });
		const { env: e, runs } = env([ok("A", "advice")], { caller });
		await executeConsult({}, e);
		expect(runs[0]?.messages).toEqual([...snapshot, caller]);
		expect(runs[0]?.step).toBe(1);
	});

	it("returns an error result when the round throws", async () => {
		const { env: e } = env([], {
			run: async () => {
				throw new Error("boom");
			},
		});
		expect(await executeConsult({}, e)).toMatchObject({ isError: true, content: [text("consult failed: boom")] });
	});

	it("passes no question when it is missing or blank", async () => {
		const { env: e, runs } = env([ok("A", "advice")]);
		await executeConsult({}, e);
		await executeConsult({ question: "   " }, e);
		expect(runs.map((r) => r.question)).toEqual([undefined, undefined]);
	});

	it("reports the advisors' summed usage", async () => {
		const { env: e } = env([ok("A", "one", 0.01), ok("B", "two", 0.02)]);
		const out = await executeConsult({}, e);
		expect(out.usage).toMatchObject({ input: 20, output: 10, totalTokens: 30 });
		expect(out.usage?.cost.total).toBeCloseTo(0.03);
	});

	it("caps calls per turn with a normal result and starts over on a new turn", async () => {
		const { env: e, runs } = env([ok("A", "advice")]);
		await executeConsult({}, e);
		await executeConsult({}, e);
		const limited = await executeConsult({}, e);
		expect(textOf(limited)).toBe("consult limit reached for this turn (2).");
		expect(limited.isError).toBeUndefined();
		expect(runs).toHaveLength(2);
		e.snapshot = [system("You are pi."), user("Next task", 20)];
		expect(textOf(await executeConsult({}, e))).toContain("advice");
		expect(runs).toHaveLength(3);
	});

	it("fails with the reasons when no advisor answered, keeping details and usage", async () => {
		const results = [failed("A", "rate limited"), { ...failed("B", "empty response"), usage: usage(0.01) }];
		const { env: e } = env(results);
		const out = await executeConsult({ question: "Why?" }, e);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toBe("consult failed: no advisor answered (rate limited; empty response).");
		expect(out.details?.advisors).toEqual(results);
		expect(out.usage?.cost.total).toBeCloseTo(0.01);
	});

	it("reports an aborted round as an error", async () => {
		const { env: e } = env([failed("A", "aborted")], { interrupted: true });
		const out = await executeConsult({}, e);
		expect(out).toMatchObject({ isError: true, content: [text("consult aborted.")] });
		expect(out.details?.interrupted).toBe(true);
	});

	it("errors without running when MoA is off, there is no snapshot, or no advisors are usable", async () => {
		const off = env([]);
		off.env.settings = undefined;
		expect(await executeConsult({}, off.env)).toMatchObject({ isError: true, content: [text("consult is unavailable: MoA is off.")] });
		const none = env([]);
		none.env.snapshot = undefined;
		expect(await executeConsult({}, none.env)).toMatchObject({ isError: true, content: [text("consult is unavailable: no request context.")] });
		expect([...off.runs, ...none.runs]).toEqual([]);
		const unusable = env([], { run: async () => undefined });
		expect(await executeConsult({}, unusable.env)).toMatchObject({ isError: true, content: [text("consult failed: the preset has no usable advisors.")] });
	});
});
