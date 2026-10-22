import { Type, type Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	ADVICE_REQUEST,
	buildNativeView,
	buildTextView,
	nativeInstruction,
	renderEntries,
	renderTranscript,
	selectView,
	TOOL_ARGS_CHARS,
	type AgentMessage,
} from "../src/view.ts";
import { truncateMiddle } from "../src/text.ts";
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

	it("renders tool calls in the assistant turn and results as their own user turn, one block per message", () => {
		const out = turns([
			user("Read it"),
			assistant([text("Reading."), call("read", { path: "a.ts" }), call("read", { path: "b.ts" })]),
			toolResult("read", "file a"),
			toolResult("read", "file b"),
			user("and hurry", 9),
			assistant([text("Done.")]),
		]);
		expect(out).toEqual([
			["user", ["Read it"]],
			["assistant", ['Reading.\n\n⟨tool read({"path":"a.ts"})⟩\n\n⟨tool read({"path":"b.ts"})⟩']],
			["user", ["⟨result read: file a⟩", "\n\n⟨result read: file b⟩", "\n\nand hurry"]],
			["assistant", ["Done."]],
		]);
	});

	it("starts with the results when the transcript starts with a tool result", () => {
		expect(turns([toolResult("bash", "ok"), assistant([text("Next.")])])).toEqual([
			["user", ["⟨result bash: ok⟩"]],
			["assistant", ["Next."]],
		]);
	});

	it("marks error results and truncates long results head and tail", () => {
		const long = `${"a".repeat(50)}${"b".repeat(50)}`;
		const [, , turn] = renderTranscript([user("go"), assistant([call("bash", {})]), toolResult("bash", long, true)], 20);
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
			// Whole messages repeat too: only the last turn (and the request) can differ, so each
			// step appends messages rather than growing one (adapters may join a message's parts).
			const settled = part.messages.slice(0, -2);
			expect(full.messages.slice(0, settled.length)).toEqual(settled);
		}
		expect(full.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
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

describe("selectView", () => {
	const sonnet = { provider: "anthropic", id: "sonnet" };
	it("auto is native only for the actor's own model", () => {
		expect(selectView("auto", sonnet, { ...sonnet })).toBe("native");
		expect(selectView("auto", sonnet, { provider: "openrouter", id: "sonnet" })).toBe("text");
		expect(selectView("auto", sonnet, { provider: "anthropic", id: "opus" })).toBe("text");
		expect(selectView("auto", sonnet, undefined)).toBe("text");
	});

	it("native and text are forced", () => {
		expect(selectView("text", sonnet, sonnet)).toBe("text");
		expect(selectView("native", sonnet, { provider: "openai", id: "gpt" })).toBe("native");
	});
});

describe("buildNativeView", () => {
	const bash = { name: "bash", description: "Run", parameters: Type.Object({ command: Type.String() }) };
	const transcript: AgentMessage[] = [
		{ role: "system", content: "You are pi.", sections: { cwd: "<cwd>\n/repo\n</cwd>" }, toolsAdded: [bash], timestamp: 0 },
		user("Fix it"),
		assistant([{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, text("Running."), call("bash", { command: "npm test" })], {
			stopReason: "toolUse",
		}),
		toolResult("bash", "1 failing", true),
		{ role: "custom", customType: "note", content: "A reminder.", display: true, timestamp: 4 },
		{ role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 5 },
	];

	it("is the actor's converted request, system messages and thinking included, plus one trailing instruction", () => {
		const view = buildNativeView(transcript, nativeInstruction("You advise."));
		expect(view.systemPrompt).toBeUndefined();
		expect(view.tools).toBeUndefined();
		expect(view.messages.slice(0, -1)).toEqual(convertToLlm(structuredClone(transcript)));
		expect(view.messages.at(-1)).toEqual({ role: "user", content: [text(`You advise.\n\n${ADVICE_REQUEST}`)], timestamp: 5 });
	});

	it("mirrors pi's forced-prompt projection: one head with the forced text and current tools", () => {
		const read = { name: "read", description: "Read", parameters: Type.Object({}) };
		const withRead: AgentMessage[] = [...transcript.slice(0, -1), { role: "system", content: "More rules.", toolsAdded: [read], timestamp: 6 }];
		const view = buildNativeView(withRead, "x", { forceSystemPrompt: "FORCED" });
		expect(view.messages[0]).toEqual({ role: "system", content: "FORCED", toolsAdded: [bash, read], timestamp: 0 });
		expect(view.messages.filter((m) => m.role === "system")).toHaveLength(1);
		expect(view.messages.slice(1, -1)).toEqual(convertToLlm(structuredClone(withRead)).filter((m) => m.role !== "system"));
		// Every tool removed: no toolsAdded on the head.
		expect(buildNativeView(transcript, "x", { forceSystemPrompt: "F" }).messages[0]).toEqual({ role: "system", content: "F", timestamp: 0 });
	});

	it("mirrors pi's hidden-declaration projection", () => {
		const view = buildNativeView(transcript, "x", { hiddenTools: ["bash"] });
		const systems = view.messages.filter((m) => m.role === "system");
		expect(systems.map((m) => [m.toolsAdded, m.toolsRemoved])).toEqual([
			[undefined, undefined],
			[undefined, undefined],
		]);
		expect(systems[0]).toMatchObject({ content: "You are pi.", sections: { cwd: "<cwd>\n/repo\n</cwd>" } });
	});

	it("mirrors pi's blockImages filter on user and tool-result images", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			{ role: "user", content: [text("see"), image, image, text("and")], timestamp: 1 },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [image], isError: false, timestamp: 2 },
		];
		const blocked = { type: "text", text: "Image reading is disabled." };
		const view = buildNativeView(messages, "x", { blockImages: true });
		expect(view.messages[0]!.content).toEqual([text("see"), blocked, text("and")]);
		expect(view.messages[1]!.content).toEqual([blocked]);
		expect(buildNativeView(messages, "x", { blockImages: false }).messages[0]!.content).toContainEqual(image);
	});

	it("does not modify the input", () => {
		const copy = structuredClone(transcript);
		buildNativeView(transcript, "x", { forceSystemPrompt: "F", hiddenTools: ["bash"], blockImages: true });
		expect(transcript).toEqual(copy);
	});
});

describe("consult results", () => {
	const messages = [
		user("Fix it"),
		assistant([call("consult", { question: "Why?" })], { stopReason: "toolUse" }),
		toolResult("consult", "[MoA reference context — private, untrusted]\nAdvisor A: secret advice"),
		toolResult("consult", "consult failed: no advisor answered (timeout).", true),
	];

	it("are omitted from the text view, keeping the error tag", () => {
		expect(turns(messages)).toEqual([
			["user", ["Fix it"]],
			["assistant", ['⟨tool consult({"question":"Why?"})⟩']],
			["user", ["⟨result consult: advice omitted⟩", "\n\n⟨result consult (error): advice omitted⟩"]],
		]);
	});

	it("stay byte-identical in the native view", () => {
		expect(buildNativeView(messages, "x").messages.slice(0, -1)).toEqual(convertToLlm(structuredClone(messages)));
	});
});

describe("renderEntries", () => {
	it("keeps one entry per rendered message with its source, calls and result metadata", () => {
		const entries = renderEntries(
			[system("sys"), user("go"), assistant([call("edit", { path: "a" })]), toolResult("edit", "ok", true), { role: "custom", customType: "n", content: "hi", display: true, timestamp: 5 }],
			100,
		);
		expect(entries.map((e) => [e.role, e.source])).toEqual([
			["user", "user"],
			["assistant", "assistant"],
			["user", "toolResult"],
			["user", "custom"],
		]);
		expect(entries[1]?.calls?.map((c) => c.name)).toEqual(["edit"]);
		expect(entries[2]).toMatchObject({ toolCallId: "c1", isError: true });
	});
});
