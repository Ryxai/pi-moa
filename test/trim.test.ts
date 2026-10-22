import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { budgetChars, isFileMutation, MIN_BLOCK_CHARS, omittedMarker, trimEntries } from "../src/trim.ts";
import { ADVICE_REQUEST, buildTextView, renderEntries, type AgentMessage } from "../src/view.ts";
import { assistant, system, text, user } from "./fixtures.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args as never });

const result = (id: string, name: string, body: string, isError = false): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [text(body)],
	isError,
	timestamp: 3,
});

/** One tool step: an assistant call and its result, each about `size` characters. */
function step(i: number, size: number, options: { name?: string; args?: Record<string, unknown>; error?: boolean } = {}): AgentMessage[] {
	const id = `c${i}`;
	const name = options.name ?? "bash";
	return [
		assistant([text(`step ${i} ${"a".repeat(size)}`), call(id, name, options.args ?? { command: `cmd ${i}` })], { stopReason: "toolUse" }),
		result(id, name, `out ${i} ${"r".repeat(size)}`, options.error),
	];
}

const allText = (view: { systemPrompt?: string; messages: Message[] }) =>
	(view.systemPrompt ?? "") + view.messages.flatMap((m) => (m.content as { text: string }[]).map((b) => b.text)).join("");

const options = { systemPrompt: "rules", toolResultChars: 100_000, pin: ["task", "latestError", "latestDiff"] as const };

describe("budgetChars", () => {
	it("is (window × 0.9 − maxTokens, default 8192, − thinking budget) × 3 characters", () => {
		expect(budgetChars(100_000, 2000)).toBe((90_000 - 2000) * 3);
		expect(budgetChars(100_000, undefined)).toBe((90_000 - 8192) * 3);
		expect(budgetChars(100_000, 2000, "high")).toBe((90_000 - 2000 - 16384) * 3);
		expect(budgetChars(100_000, 2000, "off")).toBe((90_000 - 2000) * 3);
	});

	it("caps the reserve at half the window, so small windows are still trimmed", () => {
		expect(budgetChars(8000, 8192)).toBe((7200 - 4000) * 3);
		expect(budgetChars(16_000, undefined, "medium")).toBe((14_400 - 8000) * 3);
	});

	it("is undefined (no trimming) for unknown windows", () => {
		expect(budgetChars(undefined, 100)).toBeUndefined();
		expect(budgetChars(0, 100)).toBeUndefined();
	});
});

describe("isFileMutation", () => {
	it.each([
		["edit", { path: "a.ts", edits: [] }, true],
		["write", { path: "a.ts", content: "x" }, true],
		["MultiEdit", { file_path: "a.ts" }, true],
		["mcp__fs__write_file", { path: "a.ts" }, true],
		["apply-patch", { input: "*** Begin Patch" }, true],
		["custom_saver", { filePath: "a.ts", content: "x" }, true],
		["replace_content", { relative_path: "a.ts", needle: "x", repl: "y" }, true],
		["read", { path: "a.ts", offset: 1 }, false],
		["bash", { command: "sed -i s/a/b/ a.ts" }, false],
		["grep", { path: "src", pattern: "x" }, false],
	])("%s(%o) → %s", (name, args, expected) => {
		expect(isFileMutation({ name, arguments: args })).toBe(expected);
	});
});

describe("trimEntries", () => {
	it("does not pin a failed consult result as the latest error", () => {
		const messages = [system("pi"), user("Task"), ...step(1, 1000, { error: true }), ...step(2, 1000, { name: "consult", error: true }), ...step(3, 1000), ...step(4, 1000), ...step(5, 1000)];
		const all = allText(buildTextView(messages, { ...options, budgetChars: 5000 }));
		expect(all).toContain("out 1");
		expect(all).not.toContain("step 2");
	});

	it("leaves a view under budget untouched", () => {
		const messages = [system("pi"), user("Task"), ...step(1, 100), ...step(2, 100)];
		expect(buildTextView(messages, { ...options, budgetChars: 100_000 })).toEqual(buildTextView(messages, options));
		const entries = renderEntries(messages, 4000);
		expect(trimEntries(entries, { budget: 100_000, fixed: 0, pin: [] })).toEqual(entries);
	});

	it("drops the oldest middle messages behind a marker, keeping pins and the last two steps", () => {
		const messages = [
			system("pi"),
			user("Earlier task", 1),
			...step(0, 1000),
			user("Fix the parser", 2),
			...step(1, 1000, { name: "edit", args: { path: "parser.ts", edits: [{ oldText: "a", newText: "b" }] } }),
			...step(2, 1000),
			...step(3, 1000, { error: true }),
			...step(4, 1000),
			...step(5, 1000),
			...step(6, 1000),
			...step(7, 1000),
		];
		const budget = 9000;
		const view = buildTextView(messages, { ...options, budgetChars: budget });
		const all = allText(view);
		expect(all.length).toBeLessThanOrEqual(budget);
		// Oldest first: the earlier turn and the oldest unpinned steps are gone.
		expect(all).not.toContain("Earlier task");
		expect(all).not.toContain("step 0");
		expect(all).not.toContain("step 2");
		// Pins: the task, the latest diff and its result, the latest error and its call, the last two steps.
		for (const kept of ["Fix the parser", "step 1", "out 1", "step 3", "out 3", "step 6", "out 6", "step 7", "out 7"]) expect(all).toContain(kept);
		expect(all).toContain("earlier message");
		expect(all).toContain(omittedMarker(3)); // earlier task + step 0
		// Roles still alternate, starting with the user and ending with the request.
		const roles = view.messages.map((m) => m.role);
		roles.forEach((role, i) => expect(role).toBe(i % 2 === 0 ? "user" : "assistant"));
		expect((view.messages.at(-1)!.content as { text: string }[]).at(-1)!.text).toContain(ADVICE_REQUEST);
	});

	it("without pins, keeps only the last two steps", () => {
		const messages = [user("Task"), ...step(1, 1000, { error: true }), ...step(2, 1000), ...step(3, 1000), ...step(4, 1000)];
		const all = allText(buildTextView(messages, { ...options, pin: [], budgetChars: 5000 }));
		expect(all).not.toContain("Task");
		expect(all).not.toContain("out 1");
		expect(all).toContain("step 3");
		expect(all).toContain("out 4");
	});

	it("falls back to the compaction summary as the task", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "Was fixing the parser.", tokensBefore: 1000, timestamp: 1 },
			...[1, 2, 3, 4, 5].flatMap((i) => step(i, 1000)),
		];
		const all = allText(buildTextView(messages, { ...options, budgetChars: 6000 }));
		expect(all).toContain("Was fixing the parser.");
		expect(all).not.toContain("step 1");
	});

	it("cuts in chunks, so the trimmed prefix stays identical for several steps", () => {
		const base: AgentMessage[] = [system("pi"), user("Task", 1)];
		const budget = 20_000;
		const views = [];
		let steps: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) {
			steps = [...steps, ...step(i, 500)];
			views.push(buildTextView([...base, ...steps], { ...options, budgetChars: budget }));
		}
		let breaks = 0;
		let trimmed = 0;
		for (let i = 1; i < views.length; i++) {
			const prev = views[i - 1]!.messages.slice(0, -2);
			const next = views[i]!.messages.slice(0, prev.length);
			if (JSON.stringify(prev) !== JSON.stringify(next)) breaks++;
			if (allText(views[i]!).includes("omitted")) trimmed++;
			expect(allText(views[i]!).length).toBeLessThanOrEqual(budget);
		}
		// ~1000 chars per step against 6000-char chunks: a new cut about every 6 steps.
		expect(trimmed).toBeGreaterThan(15);
		expect(breaks).toBeGreaterThan(0);
		expect(breaks).toBeLessThanOrEqual(Math.ceil(trimmed / 5));
	});

	it("keeps the prefix mostly stable when errors and edits move the pins", () => {
		const budget = 20_000;
		const views = [];
		let messages: AgentMessage[] = [system("pi"), user("Task", 1)];
		for (let i = 0; i < 40; i++) {
			const kind = i % 7 === 3 ? { error: true } : i % 9 === 5 ? { name: "edit", args: { path: `f${i}.ts`, edits: [] } } : {};
			messages = [...messages, ...step(i, 500, kind)];
			views.push(buildTextView(messages, { ...options, budgetChars: budget }));
		}
		let breaks = 0;
		for (let i = 1; i < views.length; i++) {
			const prev = views[i - 1]!.messages.slice(0, -2);
			if (JSON.stringify(prev) !== JSON.stringify(views[i]!.messages.slice(0, prev.length))) breaks++;
			expect(allText(views[i]!).length).toBeLessThanOrEqual(budget);
		}
		// Cuts every ~6 steps plus a few pin moves (a new error or edit frees the old one).
		expect(breaks).toBeLessThanOrEqual(6);
		const last = allText(views.at(-1)!);
		expect(last).toContain("omitted");
		expect(last).toContain("out 38"); // latest error (i = 38)
		expect(last).toContain("f32.ts"); // latest edit (i = 32)
	});

	it("always keeps the last message, even with no steps or pins", () => {
		const messages = [user("old ".repeat(2000), 1), user("new question", 2)];
		const all = allText(buildTextView(messages, { ...options, pin: [], budgetChars: 3000 }));
		expect(all).toContain("new question");
		expect(all).toContain(omittedMarker(1));
	});

	it("truncates the largest kept blocks head and tail when dropping is not enough", () => {
		const messages = [user("Task"), ...step(1, 100), ...step(2, 30_000)];
		const budget = 8000;
		const all = allText(buildTextView(messages, { ...options, budgetChars: budget }));
		expect(all.length).toBeLessThanOrEqual(budget);
		expect(all).toMatch(/out 2 r+\n\[… \d+ chars omitted …\]\nr+⟩/);
		expect(all).toContain("Task");
		expect(all).toContain("step 1");
	});

	it("stops at the minimum block size when nothing fits", () => {
		const messages = [user("Task"), ...step(1, 5000), ...step(2, 5000)];
		const all = allText(buildTextView(messages, { ...options, budgetChars: 100 }));
		expect(all.length).toBeLessThan(4 * (MIN_BLOCK_CHARS + 100) + 500);
	});

	it("does not modify its input", () => {
		const entries = renderEntries([user("Task"), ...step(1, 1000), ...step(2, 1000), ...step(3, 1000)], 4000);
		const copy = structuredClone(entries);
		trimEntries(entries, { budget: 1000, fixed: 0, pin: ["task"] });
		expect(entries).toEqual(copy);
	});
});
