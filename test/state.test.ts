import { describe, expect, it } from "vitest";
import { OFF, reconstructState, STATE_ENTRY, type EntryLike } from "../src/state.ts";

const stateEntry = (data: unknown): EntryLike => ({ type: "custom", customType: STATE_ENTRY, data });
const message: EntryLike = { type: "message" };

describe("reconstructState", () => {
	it("is off with no entries", () => {
		expect(reconstructState([message])).toEqual(OFF);
	});

	it("takes the latest entry on the branch", () => {
		const branch = [stateEntry({ enabled: true, preset: "solo" }), message, stateEntry({ enabled: true, preset: "council" })];
		expect(reconstructState(branch)).toEqual({ enabled: true, preset: "council" });
		expect(reconstructState([...branch, stateEntry({ enabled: false })])).toEqual(OFF);
	});

	it("only sees the given branch", () => {
		const trunk = [stateEntry({ enabled: true, preset: "solo" })];
		const branchA = [...trunk, stateEntry({ enabled: false })];
		const branchB = [...trunk, message];
		expect(reconstructState(branchA)).toEqual(OFF);
		expect(reconstructState(branchB)).toEqual({ enabled: true, preset: "solo" });
	});

	it("ignores other custom entries and malformed data", () => {
		const branch = [
			stateEntry({ enabled: true, preset: "solo" }),
			{ type: "custom", customType: "moa", data: { enabled: false } },
			stateEntry({ enabled: true }),
			stateEntry("garbage"),
		];
		expect(reconstructState(branch)).toEqual({ enabled: true, preset: "solo" });
	});
});
