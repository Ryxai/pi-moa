import { describe, expect, it } from "vitest";
import {
	assemblePrompt,
	BASE_RULES,
	NATIVE_BASE_RULES,
	NO_RECONCILIATION,
	PROJECT_INSTRUCTIONS_CHARS,
	projectInstructions,
	ROLE_PROMPTS,
	STANCE_LINES,
	SYNTHESIS_RULES,
	withLengthLine,
	withProjectInstructions,
} from "../src/roles.ts";

describe("assemblePrompt", () => {
	it("defaults to base rules plus the advisor role", () => {
		expect(assemblePrompt(undefined, {}, {})).toBe(`${BASE_RULES}\n\n${ROLE_PROMPTS.advisor}`);
	});

	it("uses the built-in role and appends the stance line", () => {
		const prompt = assemblePrompt("critic", { stance: "against" }, {});
		expect(prompt).toBe(`${BASE_RULES}\n\n${ROLE_PROMPTS.critic}\n\n${STANCE_LINES.against}`);
	});

	it("lets config override a built-in role's prompt", () => {
		const prompt = assemblePrompt("reviewer", {}, { reviewer: { prompt: "Check the tests." } });
		expect(prompt).toBe(`${BASE_RULES}\n\nCheck the tests.`);
	});

	it("reads promptFile through the injected reader", () => {
		const read = (path: string) => (path === "/roles/sec.md" ? "Focus on security.\n" : undefined);
		const prompt = assemblePrompt("security", {}, { security: { promptFile: "/roles/sec.md" } }, read);
		expect(prompt).toBe(`${BASE_RULES}\n\nFocus on security.`);
	});

	it("falls back to the built-in prompt when a promptFile can't be read", () => {
		const prompt = assemblePrompt("planner", {}, { planner: { promptFile: "/missing.md" } });
		expect(prompt).toBe(`${BASE_RULES}\n\n${ROLE_PROMPTS.planner}`);
	});

	it("appends the slot's inline prompt after the role prompt", () => {
		const prompt = assemblePrompt("planner", { prompt: "Prefer small diffs.", stance: "neutral" }, {});
		expect(prompt).toBe(`${BASE_RULES}\n\n${ROLE_PROMPTS.planner}\n\nPrefer small diffs.\n\n${STANCE_LINES.neutral}`);
	});

	it("drops the base rules with replaceBase", () => {
		const prompt = assemblePrompt("raw", { stance: "for" }, { raw: { prompt: "Only my rules.", replaceBase: true } });
		expect(prompt).toBe(`Only my rules.\n\n${STANCE_LINES.for}`);
	});

	it("ignores inherited object keys as role names", () => {
		expect(assemblePrompt("toString", {}, {})).toBe(BASE_RULES);
	});

	it("base rules forbid tool calls and claimed actions", () => {
		expect(BASE_RULES).toMatch(/Never write a tool call/);
		expect(BASE_RULES).toMatch(/Never claim or imply/);
		expect(BASE_RULES).toMatch(/verify X/);
		// Length guidance comes from the effort level, not the base rules.
		expect(BASE_RULES).not.toMatch(/words/);
		expect(NATIVE_BASE_RULES).not.toMatch(/words/);
	});

	it("base rules ask for a verdict line first", () => {
		for (const base of [BASE_RULES, NATIVE_BASE_RULES]) {
			expect(base).toMatch(/Start with exactly one line "Verdict: on-track", "Verdict: revise" or "Verdict: blocked"/);
		}
	});

	it("appends the effort level's length line as the last base rule", () => {
		const prompt = assemblePrompt("critic", {}, {}, undefined, BASE_RULES, "Keep under about 120 words.");
		expect(prompt).toBe(`${BASE_RULES}\n- Keep under about 120 words.\n\n${ROLE_PROMPTS.critic}`);
		expect(withLengthLine(BASE_RULES, undefined)).toBe(BASE_RULES);
		// replaceBase drops the length line with the rest of the base rules.
		expect(assemblePrompt("raw", {}, { raw: { prompt: "Mine.", replaceBase: true } }, undefined, BASE_RULES, "Keep it short.")).toBe("Mine.");
	});
});

describe("SYNTHESIS_RULES", () => {
	it("tells the synthesis slot to stay silent when there is nothing to reconcile", () => {
		expect(SYNTHESIS_RULES).toContain(`reply with exactly: ${NO_RECONCILIATION}`);
		expect(SYNTHESIS_RULES).toMatch(/Never add advice of your own/);
	});
});

describe("native base rules", () => {
	it("replace the text-view rules and drop the ⟨tool⟩ notation", () => {
		expect(assemblePrompt("critic", {}, {}, undefined, NATIVE_BASE_RULES)).toBe(`${NATIVE_BASE_RULES}\n\n${ROLE_PROMPTS.critic}`);
		expect(NATIVE_BASE_RULES).not.toContain("⟨");
		expect(BASE_RULES).toContain("⟨tool");
	});

	it("are dropped by replaceBase too", () => {
		expect(assemblePrompt("x", {}, { x: { prompt: "Only me.", replaceBase: true } }, undefined, NATIVE_BASE_RULES)).toBe("Only me.");
	});
});

describe("projectInstructions", () => {
	const files = [
		{ path: "/repo/AGENTS.md", content: "Use tabs.\n" },
		{ path: "/repo/pkg/AGENTS.md", content: "  " },
		{ path: "/repo/CLAUDE.md", content: "Run npm test." },
	];

	it("renders each non-empty context file under its path", () => {
		expect(projectInstructions({ contextFiles: files })).toBe("## /repo/AGENTS.md\n\nUse tabs.\n\n## /repo/CLAUDE.md\n\nRun npm test.");
	});

	it("is undefined without files, options, or when the prompt is forced", () => {
		expect(projectInstructions(undefined)).toBeUndefined();
		expect(projectInstructions({ contextFiles: [] })).toBeUndefined();
		expect(projectInstructions({ contextFiles: files, forceSystemPrompt: "custom" })).toBeUndefined();
	});

	it("caps the size, keeping head and tail", () => {
		const text = projectInstructions({ contextFiles: [{ path: "A.md", content: `START${"x".repeat(20_000)}END` }] })!;
		expect(text.length).toBeLessThan(PROJECT_INSTRUCTIONS_CHARS + 50);
		expect(text.startsWith("## A.md\n\nSTART")).toBe(true);
		expect(text.endsWith("END")).toBe(true);
	});

	it("appends under a heading only when present", () => {
		expect(withProjectInstructions("rules", "## A.md\n\nx")).toBe("rules\n\n# Project instructions\n\n## A.md\n\nx");
		expect(withProjectInstructions("rules", undefined)).toBe("rules");
	});
});
