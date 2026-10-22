import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../src/view.ts";

export const usage = (total = 0): Usage => ({
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

export const system = (text: string, timestamp = 0): AgentMessage => ({ role: "system", content: text, timestamp });

export const user = (text: string, timestamp = 1): AgentMessage => ({ role: "user", content: text, timestamp });

export function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake",
		usage: usage(),
		stopReason: "stop",
		timestamp: 2,
		...extra,
	};
}

export const text = (t: string) => ({ type: "text" as const, text: t });

export function toolResult(toolName: string, body: string, isError = false, timestamp = 3): ToolResultMessage {
	return { role: "toolResult", toolCallId: "c1", toolName, content: [text(body)], isError, timestamp };
}
