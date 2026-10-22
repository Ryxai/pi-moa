import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisors.ts";
import { adviceText, cacheForTurn, decideRound, storeRound } from "../src/advice-cache.ts";
import { FRAMING_HEADER, STALE_NOTE } from "../src/framing.ts";
import type { Trigger } from "../src/schema.ts";
import { analyzeTurn, callFingerprint, shouldRun, stableJson, type TurnAnalysis } from "../src/triggers.ts";
import type { AgentMessage } from "../src/view.ts";
import { assistant, system, text, toolResult, user } from "./fixtures.ts";

let seq = 0;
const call = (name: string, args: JsonObject, id = `k${++seq}`): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const calls = (...blocks: ToolCall[]) => assistant(blocks, { stopReason: "toolUse" });
const result = (isError: boolean, id = `r${++seq}`): AgentMessage => ({ ...toolResult("bash", isError ? "boom" : "ok", isError), toolCallId: id });
const ok = (id?: string) => result(false, id);
const err = (id?: string) => result(true, id);
const custom = (content: string): AgentMessage => ({ role: "custom", customType: "other-ext", content, display: true, timestamp: 50 });
const bash: AgentMessage = {
	role: "bashExecution",
	command: "ls",
	output: "",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 51,
};
const summary: AgentMessage = { role: "compactionSummary", summary: "earlier", tokensBefore: 10, timestamp: 52 };
const advice = (): AgentMessage => ({ role: "user", content: [text(`${FRAMING_HEADER}\nAdvice…`)], timestamp: 53 });

describe("analyzeTurn and consult", () => {
	const consultResult = (isError = false, id?: string): AgentMessage => ({ ...toolResult("consult", "advice", isError), toolCallId: id ?? `q${++seq}` });

	it("does not count a response whose tool calls are all consult as a step", () => {
		const base = [user("Fix it", 10), calls(call("bash", {})), ok()];
		const consulted = [...base, assistant([text("Let me ask."), call("consult", { question: "?" })], { stopReason: "toolUse" }), consultResult()];
		expect(analyzeTurn(consulted)).toMatchObject({ step: 1, lastToolResultStep: 1 });
		expect(analyzeTurn(consulted).step).toBe(analyzeTurn(base).step);
		// A mixed response is a step.
		expect(analyzeTurn([...base, calls(call("consult", {}), call("read", { path: "a" })), consultResult(), ok()]).step).toBe(2);
	});

	it("does not let consult results make advice stale", () => {
		const a = analyzeTurn([user("Fix it", 10), calls(call("consult", {})), consultResult()]);
		expect(a).toMatchObject({ step: 0, lastToolResultStep: 0 });
	});

	it("skips consult results in the error streak, successful or failed", () => {
		const messages = [user("Fix it", 10), calls(call("bash", {})), err("e1"), calls(call("consult", {})), consultResult(false), calls(call("bash", { x: 1 })), err("e2")];
		expect(analyzeTurn(messages)).toMatchObject({ consecutiveErrors: 2, errorStreakId: "e1" });
		expect(analyzeTurn([user("Fix it", 10), calls(call("bash", {})), ok(), calls(call("consult", {})), consultResult(true)]).consecutiveErrors).toBe(0);
	});

	it("skips consult calls when fingerprinting repeats", () => {
		const same = () => call("bash", { command: "npm test" });
		const first = same();
		const messages = [user("Fix it", 10), calls(first), err(), calls(call("consult", {})), consultResult(), calls(same()), err(), calls(same()), err()];
		expect(analyzeTurn(messages)).toMatchObject({ repeatedCalls: 3, repeatStreakId: first.id });
		const consults = [user("Fix it", 10), calls(call("consult", { question: "a" })), consultResult(), calls(call("consult", { question: "a" })), consultResult()];
		expect(analyzeTurn(consults).repeatedCalls).toBe(0);
	});
});

describe("analyzeTurn", () => {
	it("is step 0 right after the user message", () => {
		const a = analyzeTurn([system("sys"), user("Fix it", 10)]);
		expect(a).toMatchObject({ step: 0, consecutiveErrors: 0, repeatedCalls: 0, lastToolResultStep: 0, compacted: false });
		expect(a.turnKey).toMatch(/^10:[0-9a-f]{8}$/);
	});

	it("has an empty turn key without a user message or compaction summary", () => {
		expect(analyzeTurn([system("sys"), assistant([text("hi")])])).toMatchObject({ turnKey: "", compacted: false, step: 1 });
	});

	it("keys a turn whose user message was compacted away on the latest summary", () => {
		const a = analyzeTurn([system("sys"), summary, calls(call("bash", {})), err()]);
		expect(a).toMatchObject({ turnKey: "compacted:52", compacted: true, step: 1, consecutiveErrors: 1 });
		expect(analyzeTurn([system("sys"), summary, user("next", 60)]).compacted).toBe(false);
	});

	it("reports the step before the latest tool result", () => {
		const base = [user("Fix it", 10), calls(call("bash", {})), ok(), calls(call("read", {})), ok()];
		expect(analyzeTurn(base).lastToolResultStep).toBe(2);
		expect(analyzeTurn([...base, assistant([text("done?")])])).toMatchObject({ step: 3, lastToolResultStep: 2 });
	});

	it("counts assistant steps since the user message", () => {
		const messages = [user("Fix it", 10), calls(call("bash", { command: "ls" })), ok(), calls(call("read", { path: "a" })), ok()];
		expect(analyzeTurn(messages)).toMatchObject({ step: 2 });
	});

	it("starts a new turn at a steering or follow-up user message", () => {
		const first = [user("Fix it", 10), calls(call("bash", { command: "x" })), err()];
		const steered = [...first, user("Use the other file", 20)];
		const a = analyzeTurn(steered);
		expect(a).toMatchObject({ step: 0, consecutiveErrors: 0, repeatedCalls: 0, lastToolResultStep: 0 });
		expect(a.turnKey).not.toBe(analyzeTurn(first).turnKey);
	});

	it("does not start a turn at custom messages, ! commands, summaries or our advice", () => {
		const base = [user("Fix it", 10), calls(call("bash", { command: "x" })), ok()];
		const key = analyzeTurn(base).turnKey;
		const a = analyzeTurn([...base, custom("ext note"), bash, summary, advice()]);
		expect(a).toMatchObject({ turnKey: key, step: 1 });
	});

	it("keys on timestamp and content", () => {
		const k = (content: string, ts: number) => analyzeTurn([user(content, ts)]).turnKey;
		expect(k("a", 1)).toBe(k("a", 1));
		expect(k("a", 1)).not.toBe(k("b", 1));
		expect(k("a", 1)).not.toBe(k("a", 2));
		const image: AgentMessage = { role: "user", content: [text("see"), { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 };
		expect(analyzeTurn([image]).turnKey).not.toBe(k("see", 1));
	});

	it("skips error and aborted responses, so a retry maps to the same step", () => {
		const before = [user("Fix it", 10), calls(call("bash", { command: "x" })), ok()];
		const failed = [
			...before,
			assistant([text("partial"), call("bash", { command: "x" })], { stopReason: "error", errorMessage: "overloaded" }),
			assistant([call("bash", { command: "x" })], { stopReason: "aborted" }),
		];
		expect(analyzeTurn(failed)).toMatchObject({ step: 1, repeatedCalls: 1 });
		expect(analyzeTurn(failed).step).toBe(analyzeTurn(before).step);
	});

	describe("consecutiveErrors", () => {
		it("counts the trailing run of errored results across steps", () => {
			const messages = [user("go", 10), calls(call("a", {})), ok(), calls(call("a", {})), err("first"), calls(call("b", {}), call("c", {})), err(), err()];
			expect(analyzeTurn(messages)).toMatchObject({ consecutiveErrors: 3, errorStreakId: "first" });
			expect(analyzeTurn(messages.slice(0, 3)).errorStreakId).toBeUndefined();
		});

		it("is reset by any success, including within a parallel batch", () => {
			const base = [user("go", 10), calls(call("a", {}), call("b", {}))];
			expect(analyzeTurn([...base, ok(), err()]).consecutiveErrors).toBe(1);
			expect(analyzeTurn([...base, err(), ok()]).consecutiveErrors).toBe(0);
			expect(analyzeTurn([...base, err(), ok(), calls(call("c", {})), err()]).consecutiveErrors).toBe(1);
		});

		it("ignores messages that are not tool results and stops at the turn start", () => {
			const messages = [user("old", 1), calls(call("a", {})), err(), user("new", 10), calls(call("b", {})), err(), custom("note")];
			expect(analyzeTurn(messages).consecutiveErrors).toBe(1);
		});
	});

	describe("repeatedCalls", () => {
		it("counts identical calls at the end regardless of argument key order", () => {
			const messages = [
				user("go", 10),
				calls(call("edit", { path: "a", text: { x: 1, y: [1, 2] } }, "start")),
				err(),
				calls(call("edit", { text: { y: [1, 2], x: 1 }, path: "a" })),
				err(),
				calls(call("edit", { path: "a", text: { x: 1, y: [1, 2] } })),
				err(),
			];
			expect(analyzeTurn(messages)).toMatchObject({ repeatedCalls: 3, repeatStreakId: "start" });
		});

		it("breaks on different arguments or names", () => {
			const messages = [user("go", 10), calls(call("read", { path: "a" })), ok(), calls(call("read", { path: "b" })), ok(), calls(call("read", { path: "b" })), ok()];
			expect(analyzeTurn(messages).repeatedCalls).toBe(2);
			expect(analyzeTurn([...messages, calls(call("grep", { path: "b" })), ok()]).repeatedCalls).toBe(1);
		});

		it("counts identical parallel calls and only looks at this turn", () => {
			const messages = [user("old", 1), calls(call("ls", {})), ok(), user("new", 10), calls(call("ls", {}), call("ls", {})), ok(), ok()];
			expect(analyzeTurn(messages).repeatedCalls).toBe(2);
		});
	});
});

describe("stableJson / callFingerprint", () => {
	it("is key-order independent and keeps array order", () => {
		expect(stableJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
		expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
		expect(callFingerprint("t", { a: 1, b: undefined })).toBe(callFingerprint("t", { a: 1 }));
		expect(callFingerprint("t", {})).not.toBe(callFingerprint("u", {}));
	});
});

describe("shouldRun", () => {
	const onFailure = { consecutiveErrors: 2, repeatedCalls: 3 };
	const at = (step: number, consecutiveErrors = 0, repeatedCalls = 0) => ({
		step,
		consecutiveErrors,
		errorStreakId: consecutiveErrors ? "e" : undefined,
		repeatedCalls,
		repeatStreakId: repeatedCalls ? "r" : undefined,
	});
	const run = (triggers: Trigger[], a: ReturnType<typeof at>) => shouldRun(triggers, onFailure, a);

	it("user_turn fires at step 0 only", () => {
		expect(run(["user_turn"], at(0))).toEqual({ run: true, reason: "user_turn" });
		expect(run(["user_turn"], at(1))).toEqual({ run: false, reason: null });
	});

	it("every_step always fires", () => {
		for (const step of [0, 1, 7]) expect(run(["every_step"], at(step))).toEqual({ run: true, reason: "every_step" });
	});

	it("every_n fires at step 0 and every Nth step", () => {
		const fired = [0, 1, 2, 3, 4, 5, 6].filter((step) => run([{ every_n: 3 }], at(step)).run);
		expect(fired).toEqual([0, 3, 6]);
		expect([0, 1, 2].every((step) => run([{ every_n: 1 }], at(step)).reason === "every_n")).toBe(true);
		expect(run([{ every_n: 0 }], at(0)).run).toBe(false);
	});

	it("on_failure fires at either threshold", () => {
		expect(run(["on_failure"], at(3, 1, 2)).run).toBe(false);
		expect(run(["on_failure"], at(3, 2, 0))).toEqual({ run: true, reason: "on_failure", failure: { errors: { id: "e", count: 2 } } });
		expect(run(["on_failure"], at(3, 0, 3))).toEqual({ run: true, reason: "on_failure", failure: { repeats: { id: "r", count: 3 } } });
		expect(run(["on_failure"], at(3, 2, 3)).failure).toEqual({ errors: { id: "e", count: 2 }, repeats: { id: "r", count: 3 } });
	});

	it("on_failure fires again on a streak only after another full threshold", () => {
		const previous = { errors: { id: "e", count: 2 } };
		expect(shouldRun(["on_failure"], onFailure, at(3, 3), previous).run).toBe(false);
		expect(shouldRun(["on_failure"], onFailure, at(3, 4), previous).failure).toEqual({ errors: { id: "e", count: 4 } });
		expect(shouldRun(["on_failure"], onFailure, { ...at(3, 2), errorStreakId: "new" }, previous).run).toBe(true);
		expect(shouldRun(["on_failure", "every_step"], onFailure, at(3, 3), previous)).toEqual({ run: true, reason: "every_step" });
	});

	it("nothing fires with no triggers", () => {
		expect(run([], at(0, 9, 9))).toEqual({ run: false, reason: null });
	});

	it("picks a deterministic reason, on_failure first", () => {
		const all: Trigger[] = ["every_step", { every_n: 2 }, "user_turn", "on_failure"];
		expect(run(all, at(0, 2)).reason).toBe("on_failure");
		expect(run(all, at(0)).reason).toBe("user_turn");
		expect(run(all, at(2)).reason).toBe("every_n");
		expect(run(all, at(3)).reason).toBe("every_step");
		expect(run([...all].reverse(), at(0)).reason).toBe("user_turn");
	});
});

describe("advice cache", () => {
	const preset = { triggers: ["user_turn", "on_failure"] as Trigger[], onFailure: { consecutiveErrors: 2, repeatedCalls: 3 } };
	const analysis = (step: number, extra: Partial<TurnAnalysis> = {}): TurnAnalysis => ({
		turnKey: "t1",
		compacted: false,
		step,
		consecutiveErrors: 0,
		repeatedCalls: 0,
		lastToolResultStep: step,
		...extra,
	});
	const advised = (t: string, okay = true): AdvisorResult => ({ label: "A", model: "x/y", role: "advisor", ok: okay, text: okay ? t : undefined, error: okay ? undefined : "down", latencyMs: 1 });
	const RAN = { run: true, reason: "user_turn" } as const;

	it("is per turn", () => {
		const cache = cacheForTurn(undefined, analysis(0));
		storeRound(cache, 0, [advised("hi")], RAN);
		expect(cacheForTurn(cache, analysis(1))).toBe(cache);
		expect(cacheForTurn(cache, analysis(0, { turnKey: "t2" }))).toEqual({ turnKey: "t2" });
	});

	it("never re-runs a step that already ran", () => {
		const cache = cacheForTurn(undefined, analysis(0));
		expect(decideRound(cache, preset, analysis(0)).reason).toBe("user_turn");
		storeRound(cache, 0, [advised("hi", false)], RAN);
		expect(decideRound(cache, preset, analysis(0)).run).toBe(false);
		expect(adviceText(cache, analysis(0))).toBeUndefined();
	});

	it("adds the stale note only when tool results arrived after the advice's step", () => {
		const cache = cacheForTurn(undefined, analysis(0));
		storeRound(cache, 0, [advised("Read the test.")], RAN);
		const fresh = adviceText(cache, analysis(0))!;
		expect(fresh).toContain("Read the test.");
		expect(fresh).not.toContain(STALE_NOTE);
		expect(adviceText(cache, analysis(2))).toContain(STALE_NOTE);
		expect(adviceText(cache, analysis(2, { lastToolResultStep: 0 }))).toBe(fresh);
		storeRound(cache, 2, [advised("Now the config.")], RAN);
		expect(adviceText(cache, analysis(2, { lastToolResultStep: 2 }))).not.toContain(STALE_NOTE);
	});

	it("keeps earlier advice when a later round produces none", () => {
		const cache = cacheForTurn(undefined, analysis(0));
		storeRound(cache, 0, [advised("Read the test.")], RAN);
		storeRound(cache, 2, [advised("", false)], RAN);
		expect(cache.lastRunStep).toBe(2);
		expect(adviceText(cache, analysis(2))).toContain("Read the test.");
	});

	it("does not reuse advice from a later step", () => {
		const cache = cacheForTurn(undefined, analysis(0));
		storeRound(cache, 3, [advised("later")], RAN);
		expect(adviceText(cache, analysis(1))).toBeUndefined();
	});

	describe("mid-turn compaction", () => {
		const compactedAt = (ts: number, results: boolean[]): AgentMessage[] => [
			system("sys"),
			{ role: "compactionSummary", summary: "earlier", tokensBefore: 10, timestamp: ts },
			...results.flatMap((isError) => [calls(call("bash", { n: ++seq })), result(isError)]),
		];

		it("keeps the turn's advice, always stale, and keeps triggering on failures", () => {
			let cache = cacheForTurn(undefined, analyzeTurn([system("sys"), user("Fix it", 10)]));
			storeRound(cache, 0, [advised("Read the test.")], RAN);
			const a = analyzeTurn(compactedAt(52, [false]));
			cache = cacheForTurn(cache, a);
			expect(cache).toMatchObject({ turnKey: "compacted:52", advice: { step: -1 } });
			expect(cache.lastRunStep).toBeUndefined();
			expect(decideRound(cache, preset, a).run).toBe(false);
			expect(adviceText(cache, a)).toContain("Read the test.");
			expect(adviceText(cache, a)).toContain(STALE_NOTE);
			const failing = analyzeTurn(compactedAt(52, [false, true, true]));
			expect(cacheForTurn(cache, failing)).toBe(cache);
			expect(decideRound(cache, preset, failing).reason).toBe("on_failure");
			// A second compaction rebases again instead of looking like a retry.
			storeRound(cache, failing.step, [advised("Different approach.")], decideRound(cache, preset, failing));
			const again = analyzeTurn(compactedAt(80, [true]));
			cache = cacheForTurn(cache, again);
			expect(cache).toMatchObject({ turnKey: "compacted:80", advice: { step: -1 } });
			expect(adviceText(cache, again)).toContain("Different approach.");
		});

		it("starts fresh without a cache or at the next user message", () => {
			expect(cacheForTurn(undefined, analyzeTurn(compactedAt(52, [false])))).toEqual({ turnKey: "compacted:52" });
			const cache = cacheForTurn(undefined, analyzeTurn(compactedAt(52, [false])));
			storeRound(cache, 1, [advised("x")], RAN);
			expect(cacheForTurn(cache, analyzeTurn([...compactedAt(52, [false]), user("next", 90)])).advice).toBeUndefined();
		});
	});

	describe("on_failure streaks", () => {
		const errorsOnly = { triggers: ["on_failure"] as Trigger[], onFailure: { consecutiveErrors: 2, repeatedCalls: 99 } };
		const repeatsOnly = { triggers: ["on_failure"] as Trigger[], onFailure: { consecutiveErrors: 99, repeatedCalls: 3 } };
		/** Requests after each batch of tool steps; returns the metric value at each fresh round. */
		function fire(p: typeof preset, batches: AgentMessage[][], metric: (a: TurnAnalysis) => number, interrupted = new Set<number>()) {
			let cache: ReturnType<typeof cacheForTurn> | undefined;
			const fired: number[] = [];
			const messages: AgentMessage[] = [system("sys"), user("go", 10)];
			batches.forEach((batch, i) => {
				messages.push(...batch);
				const a = analyzeTurn(messages);
				cache = cacheForTurn(cache, a);
				const decision = decideRound(cache, p, a);
				if (!decision.run) return;
				fired.push(metric(a));
				if (!interrupted.has(i)) storeRound(cache, a.step, [advised("x")], decision);
			});
			return fired;
		}
		const errorStep = (): AgentMessage[] => [calls(call("bash", { n: ++seq })), err()];
		const okStep = (): AgentMessage[] => [calls(call("bash", { n: ++seq })), ok()];
		const errors = (a: TurnAnalysis) => a.consecutiveErrors;

		it("fires when an error streak reaches the threshold and at each further threshold", () => {
			expect(fire(errorsOnly, Array.from({ length: 7 }, errorStep), errors)).toEqual([2, 4, 6]);
		});

		it("starts over for a new streak", () => {
			expect(fire(errorsOnly, [errorStep(), errorStep(), okStep(), errorStep(), errorStep()], errors)).toEqual([2, 2]);
		});

		it("fires again after an interrupted round", () => {
			expect(fire(errorsOnly, Array.from({ length: 5 }, errorStep), errors, new Set([1]))).toEqual([2, 3, 5]);
		});

		it("fires on repeated successful calls at the threshold and its multiples", () => {
			const poll = (): AgentMessage[] => [calls(call("status", { job: 1 })), ok()];
			expect(fire(repeatsOnly, Array.from({ length: 7 }, poll), (a) => a.repeatedCalls)).toEqual([3, 6]);
		});

		it("fires once for a parallel batch that jumps past the threshold, then after another threshold", () => {
			const batch: AgentMessage[] = [calls(...Array.from({ length: 5 }, (_, j) => call("bash", { j }))), ...Array.from({ length: 5 }, () => err())];
			expect(fire(errorsOnly, [batch, errorStep(), errorStep()], errors)).toEqual([5, 7]);
		});
	});
});
