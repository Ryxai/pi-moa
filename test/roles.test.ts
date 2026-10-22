import { describe, expect, it } from "vitest";
import { assemblePrompt, BASE_RULES, ROLE_PROMPTS, STANCE_LINES } from "../src/roles.ts";

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
		expect(BASE_RULES).toMatch(/400 words/);
	});
});
