import { FRAMING_HEADER } from "./framing.ts";
import type { PresetConfig, Trigger } from "./schema.ts";
import { CONSULT_TOOL } from "./tool-names.ts";
import type { AgentMessage } from "./view.ts";

export interface TurnAnalysis {
	/**
	 * Identity of the last real user message (`timestamp:contentHash`). Without one, the latest
	 * compaction summary (`compacted:timestamp`; the turn's start was compacted away), else "".
	 */
	turnKey: string;
	/** The turn's user message is gone and `turnKey` names a compaction summary. */
	compacted: boolean;
	/**
	 * Completed assistant responses since that message (error/aborted ones excluded, and those whose
	 * tool calls are all `consult`, so a consult does not advance the step).
	 */
	step: number;
	/**
	 * Most recent tool results in this turn that errored in a row; any success resets it. Within a
	 * parallel batch this follows call order, which pi keeps for results.
	 */
	consecutiveErrors: number;
	/** `toolCallId` of the earliest result in that run; identifies the streak. */
	errorStreakId?: string;
	/** How many times the latest tool call (name + args) repeats back to back at the end of this turn. */
	repeatedCalls: number;
	/** Id of the first tool call in that run; identifies the streak. */
	repeatStreakId?: string;
	/** Responses before the latest tool result of the turn (0 without one): advice from an earlier step predates it. */
	lastToolResultStep: number;
	/** Text of the turn's user message (images as placeholders); absent after compaction. */
	userText?: string;
}

/** `before_done` rounds run at `turn_end` (see review.ts), not from `shouldRun`. */
export type TriggerReason = "user_turn" | "every_step" | "every_n" | "on_failure" | "before_done";

export interface Streak {
	id: string;
	count: number;
}

/** The failure streaks a completed `on_failure` round fired on, at the size it fired. */
export interface FailureFired {
	errors?: Streak;
	repeats?: Streak;
}

export interface TriggerDecision {
	run: boolean;
	reason: TriggerReason | null;
	/** Streaks that fire now (only when `on_failure` is configured). */
	failure?: FailureFired;
}

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type User = Extract<AgentMessage, { role: "user" }>;

/**
 * Where the request is in the current turn. A turn starts at the last `user` message (typed
 * prompts, steering and follow-up messages); extension messages (`custom`, e.g. `sendMessage`),
 * `!` commands, summaries and our own advice do not start one. Error/aborted responses are
 * skipped as pi's providers skip them, so an auto-retry maps to the same step. `consult` calls and
 * results are invisible to the step count, failure streaks and staleness: they are the actor asking
 * for advice, not progress or failure.
 */
export function analyzeTurn(messages: readonly AgentMessage[]): TurnAnalysis {
	let start = messages.length;
	while (start > 0 && !isRealUser(messages[start - 1]!)) start--;
	const userMessage = start > 0 ? (messages[start - 1] as User) : undefined;
	const turn = messages.slice(start);
	const summary = userMessage ? undefined : turn.findLast((m) => m.role === "compactionSummary");

	let step = 0;
	let lastToolResultStep = 0;
	const calls: { id: string; fingerprint: string }[] = [];
	for (const message of turn) {
		if (message.role === "toolResult" && message.toolName !== CONSULT_TOOL) lastToolResultStep = step;
		if (message.role !== "assistant" || isFailedResponse(message) || isConsultOnly(message)) continue;
		step++;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name !== CONSULT_TOOL) calls.push({ id: block.id, fingerprint: callFingerprint(block.name, block.arguments) });
		}
	}

	let consecutiveErrors = 0;
	let errorStreakId: string | undefined;
	for (let i = turn.length - 1; i >= 0; i--) {
		const message = turn[i]!;
		if (message.role !== "toolResult" || message.toolName === CONSULT_TOOL) continue;
		if (!message.isError) break;
		consecutiveErrors++;
		errorStreakId = message.toolCallId;
	}

	let repeatedCalls = 0;
	let repeatStreakId: string | undefined;
	for (let i = calls.length - 1; i >= 0 && calls[i]!.fingerprint === calls.at(-1)!.fingerprint; i--) {
		repeatedCalls++;
		repeatStreakId = calls[i]!.id;
	}

	return {
		turnKey: userMessage
			? `${userMessage.timestamp}:${hashContent(userMessage.content)}`
			: summary
				? `compacted:${summary.timestamp}`
				: "",
		compacted: summary !== undefined,
		step,
		consecutiveErrors,
		errorStreakId,
		repeatedCalls,
		repeatStreakId,
		lastToolResultStep,
		...(userMessage && { userText: contentText(userMessage.content) }),
	};
}

/**
 * Whether advisors should run now; `on_failure` wins over cadence triggers as the recorded reason.
 * A failure streak fires when it first reaches its threshold, then again each time it grows by
 * another full threshold (`previous` = what completed rounds already fired on); a new streak starts over.
 */
export function shouldRun(
	triggers: readonly Trigger[],
	onFailure: PresetConfig["onFailure"],
	analysis: Pick<TurnAnalysis, "step" | "consecutiveErrors" | "errorStreakId" | "repeatedCalls" | "repeatStreakId">,
	previous: FailureFired = {},
): TriggerDecision {
	const fired = new Set<TriggerReason>();
	let failure: FailureFired | undefined;
	for (const trigger of triggers) {
		if (trigger === "on_failure") {
			const errors = streakFires(analysis.consecutiveErrors, onFailure.consecutiveErrors, analysis.errorStreakId, previous.errors);
			const repeats = streakFires(analysis.repeatedCalls, onFailure.repeatedCalls, analysis.repeatStreakId, previous.repeats);
			if (errors || repeats) {
				fired.add("on_failure");
				failure = { ...(errors && { errors }), ...(repeats && { repeats }) };
			}
		} else if (trigger === "every_step") fired.add("every_step");
		else if (trigger === "before_done") continue;
		else if (trigger === "user_turn") {
			if (analysis.step === 0) fired.add("user_turn");
		} else if (trigger.every_n > 0 && analysis.step % trigger.every_n === 0) fired.add("every_n");
	}
	const order: TriggerReason[] = ["on_failure", "user_turn", "every_n", "every_step"];
	const reason = order.find((r) => fired.has(r)) ?? null;
	return failure ? { run: reason !== null, reason, failure } : { run: reason !== null, reason };
}

function streakFires(count: number, threshold: number, id: string | undefined, previous: Streak | undefined): Streak | undefined {
	if (id === undefined || count < threshold) return undefined;
	return previous?.id !== id || count >= previous.count + threshold ? { id, count } : undefined;
}

/** `name` plus key-order-independent JSON of the arguments. */
export function callFingerprint(name: string, args: unknown): string {
	return `${name}:${stableJson(args)}`;
}

export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function isRealUser(message: AgentMessage): boolean {
	return message.role === "user" && !contentText(message.content).startsWith(FRAMING_HEADER);
}

function isConsultOnly(message: Assistant): boolean {
	const calls = message.content.filter((block) => block.type === "toolCall");
	return calls.length > 0 && calls.every((call) => call.name === CONSULT_TOOL);
}

function isFailedResponse(message: Assistant): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

function contentText(content: User["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType} ${block.data.length}]`)).join("\n");
}

/** FNV-1a (32-bit) of the message text; disambiguates user messages sharing a timestamp. */
function hashContent(content: User["content"]): string {
	let hash = 0x811c9dc5;
	for (const char of contentText(content)) {
		hash ^= char.codePointAt(0)!;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
