import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdvisors, type AdvisorRequest, type CompleteFn } from "../src/advisors.ts";
import type { ModelLike } from "../src/config-resolve.ts";
import { assistant, text, usage } from "./fixtures.ts";

const gpt: ModelLike = { provider: "openai", id: "gpt" };
const sonnet: ModelLike = { provider: "anthropic", id: "sonnet" };
const context: Context = { systemPrompt: "rules", messages: [] };

const request = (label: string, model = gpt, extra: Partial<AdvisorRequest<ModelLike>> = {}): AdvisorRequest<ModelLike> => ({
	label,
	model,
	role: "advisor",
	context,
	...extra,
});

const reply = (t: string, extra: Partial<AssistantMessage> = {}) => assistant([text(t)], { usage: usage(0.02), ...extra });

afterEach(() => {
	vi.useRealTimers();
});

describe("runAdvisors", () => {
	it("returns text, usage, cost and latency on success", async () => {
		let clock = 100;
		const complete: CompleteFn<ModelLike> = async () => {
			clock += 250;
			return reply("  Check the config first.  ");
		};
		const [result] = await runAdvisors([request("A")], { complete, timeoutMs: 1000, now: () => clock });
		expect(result).toEqual({
			label: "A",
			model: "openai/gpt",
			role: "advisor",
			ok: true,
			text: "Check the config first.",
			usage: usage(0.02),
			costUsd: 0.02,
			latencyMs: 250,
		});
	});

	it("passes call options; reasoning omitted when off, toolChoice only when tools are declared", async () => {
		const seen: SimpleStreamOptions[] = [];
		const hook = (payload: unknown) => payload;
		const complete: CompleteFn<ModelLike> = async (_m, _c, options) => {
			seen.push(options);
			return reply("ok");
		};
		const read = { name: "read", description: "", parameters: {} as never };
		const declared: Context = { messages: [{ role: "system", content: "rules", toolsAdded: [read], timestamp: 0 }] };
		const removed: Context = {
			messages: [...declared.messages, { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 1 }],
		};
		await runAdvisors(
			[
				request("A", gpt, { thinking: "high", maxTokens: 512, sessionId: "moa0-s", onPayload: hook }),
				request("B", gpt, { thinking: "off" }),
				request("C", gpt, { context: declared }),
				request("D", gpt, { context: { ...context, tools: [read] } }),
				request("E", gpt, { context: removed }),
			],
			{ complete, timeoutMs: 1000 },
		);
		expect(seen[0]).toMatchObject({ reasoning: "high", maxTokens: 512, sessionId: "moa0-s", onPayload: hook });
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(seen[0]).not.toHaveProperty("toolChoice");
		expect(seen[1]).not.toHaveProperty("reasoning");
		expect(seen[1]).not.toHaveProperty("maxTokens");
		expect(seen[1]).not.toHaveProperty("sessionId");
		expect(seen[1]).not.toHaveProperty("onPayload");
		expect(seen[2]).toMatchObject({ toolChoice: "none" });
		expect(seen[3]).toMatchObject({ toolChoice: "none" });
		expect(seen[4]).not.toHaveProperty("toolChoice");
	});

	it("treats error and aborted stop reasons as failures", async () => {
		const complete: CompleteFn<ModelLike> = async (model) =>
			model === gpt ? reply("", { stopReason: "error", errorMessage: "401 unauthorized" }) : reply("partial", { stopReason: "aborted" });
		const results = await runAdvisors([request("A", gpt), request("B", sonnet)], { complete, timeoutMs: 1000 });
		expect(results.map((r) => [r.ok, r.error])).toEqual([
			[false, "401 unauthorized"],
			[false, "aborted"],
		]);
		expect(results[0]?.costUsd).toBe(0.02);
	});

	it("treats empty or thinking-only text as a failure", async () => {
		const complete: CompleteFn<ModelLike> = async () => assistant([{ type: "thinking", thinking: "hmm" }, text("  ")]);
		const [result] = await runAdvisors([request("A")], { complete, timeoutMs: 1000 });
		expect(result).toMatchObject({ ok: false, error: "empty response" });
	});

	it("captures thrown and synchronous errors without throwing", async () => {
		const complete: CompleteFn<ModelLike> = (model) => {
			if (model === gpt) throw new Error("no auth");
			return Promise.reject(new Error("network down"));
		};
		const results = await runAdvisors([request("A", gpt), request("B", sonnet)], { complete, timeoutMs: 1000 });
		expect(results.map((r) => r.error)).toEqual(["no auth", "network down"]);
	});

	it("times out a slow advisor and aborts its call while others succeed", async () => {
		vi.useFakeTimers();
		let slowSignal: AbortSignal | undefined;
		const complete: CompleteFn<ModelLike> = (model, _c, options) => {
			if (model === sonnet) return Promise.resolve(reply("fast"));
			slowSignal = options.signal;
			return new Promise(() => {});
		};
		const pending = runAdvisors([request("A", gpt), request("B", sonnet)], { complete, timeoutMs: 5000 });
		await vi.advanceTimersByTimeAsync(5000);
		const results = await pending;
		expect(results[0]).toMatchObject({ ok: false, error: "timeout after 5s" });
		expect(results[1]).toMatchObject({ ok: true, text: "fast" });
		expect(slowSignal?.aborted).toBe(true);
	});

	it("reports outer aborts, before and during the call", async () => {
		const outer = new AbortController();
		const complete: CompleteFn<ModelLike> = () => new Promise(() => {});
		const pending = runAdvisors([request("A")], { complete, timeoutMs: 60_000, signal: outer.signal });
		outer.abort();
		expect((await pending)[0]).toMatchObject({ ok: false, error: "aborted" });

		const calls = vi.fn(complete);
		const again = await runAdvisors([request("A")], { complete: calls, timeoutMs: 60_000, signal: outer.signal });
		expect(again[0]).toMatchObject({ ok: false, error: "aborted" });
		expect(calls).not.toHaveBeenCalled();
	});

	it("runs advisors in parallel and keeps input order", async () => {
		let active = 0;
		let peak = 0;
		const complete: CompleteFn<ModelLike> = async (model) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, model === gpt ? 20 : 1));
			active--;
			return reply(model.id);
		};
		const results = await runAdvisors([request("A", gpt), request("B", sonnet), request("C", gpt)], { complete, timeoutMs: 1000 });
		expect(peak).toBe(3);
		expect(results.map((r) => [r.label, r.text])).toEqual([
			["A", "gpt"],
			["B", "sonnet"],
			["C", "gpt"],
		]);
	});
});
