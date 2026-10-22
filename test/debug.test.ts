import { describe, expect, it } from "vitest";
import { debugLogPath } from "../src/debug.ts";

describe("debugLogPath", () => {
	it("is off unless set", () => {
		expect(debugLogPath(undefined, "/a")).toBeUndefined();
		expect(debugLogPath("0", "/a")).toBeUndefined();
	});

	it("uses the agent dir for 1 and a custom path otherwise", () => {
		expect(debugLogPath("1", "/a")).toBe("/a/moa-debug.log");
		expect(debugLogPath("/tmp/x.log", "/a")).toBe("/tmp/x.log");
	});
});
