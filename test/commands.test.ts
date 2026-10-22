import { describe, expect, it } from "vitest";
import { completeMoaArgs, parseMoaArgs } from "../src/commands.ts";

describe("parseMoaArgs", () => {
	it.each([
		["", { kind: "status" }],
		["   ", { kind: "status" }],
		["on", { kind: "on" }],
		["on council", { kind: "on", preset: "council" }],
		["  on   council ", { kind: "on", preset: "council" }],
		["off", { kind: "off" }],
		["reload", { kind: "reload" }],
		["init", { kind: "init" }],
	])("parses %j", (input, expected) => {
		expect(parseMoaArgs(input)).toEqual(expected);
	});

	it.each(["fix the failing test", "on second thought, refactor this", "off the top of your head?", "init the repo", "ON"])(
		"treats %j as a one-shot prompt",
		(input) => {
			expect(parseMoaArgs(input)).toEqual({ kind: "prompt", text: input.trim() });
		},
	);
});

describe("completeMoaArgs", () => {
	it("completes subcommands and preset names", () => {
		expect(completeMoaArgs("o", ["solo"])?.map((c) => c.value)).toEqual(["on", "off"]);
		expect(completeMoaArgs("on c", ["solo", "council"])?.map((c) => c.value)).toEqual(["on council"]);
		expect(completeMoaArgs("fix it", ["solo"])).toBeNull();
	});
});
