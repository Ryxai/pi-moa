import type { AdvisorResult } from "./advisors.ts";
import { synthesisText } from "./framing.ts";
import type { Verdict } from "./schema.ts";
import type { AgentMessage } from "./view.ts";

/** Custom message type of a `before_done` review delivered to the actor (view.ts repeats the name). */
export const REVIEW_MESSAGE = "moa-review";

/** The closing request for a `before_done` round, in place of `ADVICE_REQUEST`. */
export const REVIEW_REQUEST =
	"Above is the conversation so far between the user and the agent. The agent's last reply ends its turn: it considers the task " +
	"done, or is handing back to the user. Review the work against the user's request: is anything incomplete, unverified, wrong " +
	"or left out? Reply \"Verdict: revise\" only if the agent should continue working before handing back, and say exactly what " +
	"to do; \"Verdict: on-track\" if it is right to stop here; \"Verdict: blocked\" if only the user can move it forward.";

/** Shown to the actor above the advice when a review sends it back to work. */
export const REVIEW_PREAMBLE =
	"[MoA before-done review] Your previous reply would have ended the turn. Advisors reviewed it and think the work is not " +
	"finished. Continue working on the points below that hold up against the transcript, then reply again; if you disagree " +
	"after checking, say why in your reply and stop.";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;

/** Whether `message` ends the turn: a completed assistant reply with no tool calls. */
export function endsTurn(message: AgentMessage): message is Assistant {
	return message.role === "assistant" && message.stopReason === "stop" && !message.content.some((block) => block.type === "toolCall");
}

/**
 * The review's combined verdict: the synthesis decides when it spoke and gave one; otherwise
 * `revise` if any advisor said so, else `blocked` if any did, else `on-track` when at least one
 * advisor gave a verdict. Undefined when nobody gave one.
 */
export function reviewVerdict(results: readonly AdvisorResult[], synthesis?: AdvisorResult): Verdict | undefined {
	if (synthesisText(synthesis) && synthesis?.verdict) return synthesis.verdict;
	const verdicts = results.filter((r) => r.ok && r.text).map((r) => r.verdict).filter((v): v is Verdict => v !== undefined);
	if (verdicts.includes("revise")) return "revise";
	if (verdicts.includes("blocked")) return "blocked";
	return verdicts.length > 0 ? "on-track" : undefined;
}

/** A `before_done` review sends the actor back to work only on `revise`. */
export function shouldContinue(results: readonly AdvisorResult[], synthesis?: AdvisorResult): boolean {
	return reviewVerdict(results, synthesis) === "revise";
}
