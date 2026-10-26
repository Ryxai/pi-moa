import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/verdict.ts";

describe("parseVerdict", () => {
	it.each([
		["Verdict: on-track\nCarry on.", "on-track"],
		["verdict: REVISE\n\nRun the tests first.", "revise"],
		["\n\n**Verdict: blocked**\nNeeds the user.", "blocked"],
		["# Verdict: on track", "on-track"],
		["- Verdict: ontrack", "on-track"],
		["Verdict: revise.", "revise"],
	])("reads %j as %s", (text, verdict) => {
		expect(parseVerdict(text)).toBe(verdict);
	});

	it.each(["Carry on.\nVerdict: on-track", "Verdict: maybe", "Verdict:", "", undefined, "The verdict: revise is wrong"])("gives undefined for %j", (text) => {
		expect(parseVerdict(text)).toBeUndefined();
	});
});
