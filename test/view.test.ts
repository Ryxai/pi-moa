import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ADVICE_REQUEST, buildTextView, renderTranscript, TOOL_ARGS_CHARS, truncateMiddle, type AgentMessage } from "../src/view.ts";
import { assistant, system, text, toolResult, user } from "./fixtures.ts";

const turns = (messages: AgentMessage[], chars = 4000) => renderTranscript(messages, chars).map((t) => [t.role, t.blocks]);

const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id: "c1", name, arguments: args as never });

describe("renderTranscript", () => {
	it("keeps user and assistant text, drops system messages and thinking", () => {
		const out = turns([
			system("You are pi."),
			user("Fix the bug"),
			assistant([{ type: "thinking", thinking: "secret plan" }, text("Looking now.")]),
		]);
		expect(out).toEqual([
			["user", ["Fix the bug"]],
			["assistant", ["Looking now."]],
		]);
	});

	it("renders tool calls and attaches results to the assistant turn, one block per message", () => {
		const out = turns([
			user("Read it"),
			assistant([text("Reading."), call("read", { path: "a.ts" })]),
			toolResult("read", "file body"),
			assistant([text("Done.")]),
		]);
		expect(out).toEqual([
			["user", ["Read it"]],
			["assistant", ['Reading.\n\n⟨tool read({"path":"a.ts"})⟩', "\n\n⟨result read: file body⟩", "\n\nDone."]],
		]);
	});

	it("marks error results and truncates long results head and tail", () => {
		const long = `${"a".repeat(50)}${"b".repeat(50)}`;
		const [, turn] = renderTranscript([user("go"), toolResult("bash", long, true)], 20);
		expect(turn?.blocks).toEqual([`⟨result bash (error): ${"a".repeat(10)}\n[… 80 chars omitted …]\n${"b".repeat(10)}⟩`]);
	});

	it("caps tool call arguments", () => {
		const [, turn] = renderTranscript([user("go"), assistant([call("write", { content: "x".repeat(1000) })])], 4000);
		const block = turn!.blocks[0]!;
		expect(block.length).toBeLessThan(TOOL_ARGS_CHARS + 30);
		expect(block.endsWith("…)⟩")).toBe(true);
	});

	it("skips failed and aborted assistant responses", () => {
		const out = turns([
			user("go"),
			assistant([text("half an answer")], { stopReason: "aborted" }),
			assistant([text("")], { stopReason: "error", errorMessage: "overloaded" }),
			assistant([text("Real answer.")]),
		]);
		expect(out).toEqual([
			["user", ["go"]],
			["assistant", ["Real answer."]],
		]);
	});

	it("replaces images with a placeholder", () => {
		const message: AgentMessage = { role: "user", content: [text("see"), { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 };
		expect(turns([message])).toEqual([["user", ["see\n[image]"]]]);
	});

	it("renders custom, bash and summary messages as pi sends them", () => {
		const out = turns([
			{ role: "compactionSummary", summary: "Earlier work.", tokensBefore: 100, timestamp: 1 },
			{ role: "custom", customType: "note", content: "A reminder.", display: true, timestamp: 2 },
			{ role: "bashExecution", command: "ls", output: "x.ts", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
			{ role: "bashExecution", command: "secret", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 4, excludeFromContext: true },
		]);
		expect(out).toHaveLength(1);
		const blocks = out[0]![1] as string[];
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toContain("<summary>\nEarlier work.");
		expect(blocks[1]).toBe("\n\nA reminder.");
		expect(blocks[2]).toContain("Ran `ls`");
		expect(blocks.join()).not.toContain("secret");
	});

	it("merges same-role turns, drops empty ones, and starts with a user turn", () => {
		const out = renderTranscript(
			[assistant([text("Hi.")]), assistant([{ type: "thinking", thinking: "only thinking" }]), user("one", 5), user("two", 6)],
			4000,
		);
		expect(out.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
		expect(out[2]).toEqual({ role: "user", blocks: ["one", "\n\ntwo"], timestamp: 5 });
	});
});

describe("append-only rendering", () => {
	const all: AgentMessage[] = [
		system("sys"),
		user("Task"),
		assistant([text("Plan."), call("bash", { cmd: "npm test" })]),
		toolResult("bash", "1 failing", true),
		assistant([text("Fixing."), call("edit", { path: "a.ts" })]),
		toolResult("edit", "ok"),
		user("also docs", 9),
		assistant([text("Sure.")]),
	];

	/** Every content block of the view except the advice request, in order, tagged with its message index. */
	function blocks(messages: Message[]): string[] {
		return messages.flatMap((m, i) =>
			(m.content as { text: string }[]).filter((b) => b.text.trim() !== ADVICE_REQUEST).map((b) => `${i}:${m.role}:${b.text}`),
		);
	}

	it("renders every prefix of the transcript to a prefix of the full view's blocks", () => {
		const options = { systemPrompt: "rules", toolResultChars: 4000 };
		const full = buildTextView(all, options);
		for (let n = 0; n <= all.length; n++) {
			const part = buildTextView(all.slice(0, n), options);
			expect(part.systemPrompt).toBe(full.systemPrompt);
			const partBlocks = blocks(part.messages);
			expect(blocks(full.messages).slice(0, partBlocks.length)).toEqual(partBlocks);
		}
		expect(buildTextView(all, options)).toEqual(full);
	});
});

describe("buildTextView", () => {
	it("sets the system prompt and ends with the advice request as its own user message", () => {
		const view = buildTextView([user("Task"), assistant([text("Working.")])], { systemPrompt: "rules", toolResultChars: 100 });
		expect(view.systemPrompt).toBe("rules");
		expect(view.tools).toBeUndefined();
		expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(view.messages.at(-1)?.content).toEqual([text(ADVICE_REQUEST)]);
	});

	it("adds the request as a separate block after a trailing user message", () => {
		const view = buildTextView([user("Task")], { systemPrompt: "rules", toolResultChars: 100 });
		expect(view.messages).toHaveLength(1);
		expect(view.messages[0]?.content).toEqual([text("Task"), text(`\n\n${ADVICE_REQUEST}`)]);
	});

	it("handles an empty transcript", () => {
		const view = buildTextView([], { systemPrompt: "rules", toolResultChars: 100 });
		expect(view.messages).toEqual([{ role: "user", content: [text(ADVICE_REQUEST)], timestamp: 0 }]);
	});

	it("does not modify the input", () => {
		const input = [user("Task"), assistant([text("ok")])];
		const copy = structuredClone(input);
		buildTextView(input, { systemPrompt: "", toolResultChars: 10 });
		expect(input).toEqual(copy);
	});
});

describe("truncateMiddle", () => {
	it("leaves short text alone", () => {
		expect(truncateMiddle("abc", 3)).toBe("abc");
	});

	it("never splits a surrogate pair", () => {
		const emoji = "😀".repeat(10);
		const out = truncateMiddle(emoji, 5);
		expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		expect(out.startsWith("😀")).toBe(true);
		expect(out.endsWith("😀")).toBe(true);
	});
});
