import { describe, expect, it } from "vitest";
import { matchOneShot } from "../src/oneshot.ts";

describe("matchOneShot", () => {
	const pending = { preset: "solo", text: "fix it", exclude: "1:old" };

	it("does nothing without a pending one-shot", () => {
		expect(matchOneShot(undefined, { turnKey: "2:a", userText: "fix it" })).toEqual({ pending: undefined });
	});

	it("binds to the first turn whose user message is the text", () => {
		expect(matchOneShot(pending, { turnKey: "2:a", userText: "other" })).toEqual({ pending });
		const bound = matchOneShot(pending, { turnKey: "2:a", userText: "fix it" });
		expect(bound).toEqual({ pending: { ...pending, turn: "2:a" }, preset: "solo" });
	});

	it("never binds to the turn current when the command ran, or to a compacted turn", () => {
		expect(matchOneShot(pending, { turnKey: "1:old", userText: "fix it" })).toEqual({ pending });
		expect(matchOneShot(pending, { turnKey: "", userText: "fix it" })).toEqual({ pending });
	});

	it("applies to every step of the bound turn and ends at the next turn", () => {
		const bound = { ...pending, turn: "2:a" };
		expect(matchOneShot(bound, { turnKey: "2:a", userText: "fix it" }).preset).toBe("solo");
		expect(matchOneShot(bound, { turnKey: "3:b", userText: "fix it" })).toEqual({ pending: undefined });
	});
});
