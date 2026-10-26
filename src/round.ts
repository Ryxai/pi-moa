import type { Context, ThinkingBudgets } from "@earendil-works/pi-ai";
import { runAdvisors, type AdvisorRequest, type AdvisorResult, type CompleteFn } from "./advisors.ts";
import { resolvePreset, type ModelLike, type ModelLookup, type ResolvedPreset } from "./config-resolve.ts";
import { getPreset, type MoaConfig } from "./config.ts";
import { roundEffort, slotEffort } from "./effort.ts";
import { arrangeAdvisors } from "./framing.ts";
import {
	assemblePrompt,
	BASE_RULES,
	DEFAULT_ROLE,
	NATIVE_BASE_RULES,
	NO_RECONCILIATION,
	SYNTHESIS_RULES,
	withProjectInstructions,
	type PromptFileReader,
} from "./roles.ts";
import { moveCacheMarker } from "./cache.ts";
import { sanitizeAdvice } from "./sanitize.ts";
import type { AdvisorConfig, EffortLevel, PresetConfig, ThinkingLevel } from "./schema.ts";
import { budgetChars } from "./trim.ts";
import type { TriggerReason } from "./triggers.ts";
import { parseVerdict } from "./verdict.ts";
import {
	adviceRequest,
	adviceRequestBlocks,
	buildNativeView,
	buildTextView,
	nativeInstruction,
	selectView,
	synthesisRequest,
	type AgentMessage,
	type RequestProjection,
} from "./view.ts";

export const RECORD_ENTRY = "moa";

/** A trigger, or the actor's `consult` tool call. */
export type RoundReason = TriggerReason | "consult";

export interface MoaRecord {
	preset: string;
	/** What started the round. */
	reason: RoundReason;
	/** The actor's question (consult only). */
	question?: string;
	/** Turn key (see `analyzeTurn`). */
	turn: string;
	step: number;
	advisors: AdvisorResult[];
	/** The synthesis slot's result, when the preset has one and two or more advisors answered. */
	synthesis?: AdvisorResult;
	/** Set when the request was aborted during the round; its advice is not used. */
	interrupted?: true;
}

export interface RoundInput<M extends ModelLike> {
	messages: readonly AgentMessage[];
	config: MoaConfig;
	presetName: string;
	models: ModelLookup<M>;
	/** The acting model; `"current"` resolves to it. */
	actor: M | undefined;
	signal?: AbortSignal;
	/** pi session id: native advisors use it, text advisors a per-slot id derived from it. */
	sessionId?: string;
	/** The actor's thinking level; native advisors without their own use it. */
	actorThinking?: ThinkingLevel;
	/** pi's `thinkingBudgets` setting, which the actor's requests use; native advisors get it too. */
	thinkingBudgets?: ThinkingBudgets;
	/** How pi projects the actor's request (forced prompt, hidden tools, blocked images). */
	projection?: RequestProjection;
	/** Rendered project context files, for text views (see `projectInstructions`). */
	projectInstructions?: string;
	reason: RoundReason;
	/** The actor's `consult` question, appended to the advice request. */
	question?: string;
	/** The actor's requested effort (`consult`), replacing the preset's level and bump. */
	effort?: EffortLevel;
	/** Closing request for the advisors; default `ADVICE_REQUEST` (see `adviceRequest`). */
	request?: string;
	turn: string;
	step: number;
}

export interface RoundOutput {
	/** In display order. */
	results: AdvisorResult[];
	/** See `MoaRecord.synthesis`. */
	synthesis?: AdvisorResult;
	/** `signal` was aborted during the round: never cache or inject its advice. */
	interrupted: boolean;
	record: MoaRecord;
}

/**
 * Provider session id for a text-view advisor slot: stable across steps (so OpenAI-style `prompt_cache_key`
 * routing keeps hitting the same cache) and distinct from the actor's. The slot prefix comes first
 * because providers may truncate long keys (OpenAI clamps to 64 characters).
 */
export function advisorSessionId(sessionId: string | undefined, slot: number): string | undefined {
	return sessionId ? `moa${slot}-${sessionId}` : undefined;
}

/** Advisor payload hook: keeps the cache marker off the advice-request block. */
const advisorPayload =
	(tailTexts: readonly string[]) =>
	(payload: unknown): unknown =>
		moveCacheMarker(payload, tailTexts);

export interface AdvisorCall {
	view: "native" | "text";
	context: Context;
	/** Request-local tail texts the cache marker is moved off. */
	tailTexts: readonly string[];
	effort: EffortLevel;
	thinking?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	maxTokens: number;
	sessionId?: string;
	toolChoice?: "none" | "omit";
}

/**
 * One advisor's call at the round's effort level (see effort.ts). Native: the actor's projected
 * request and session id, so the request can reuse the actor's cache, and the actor's thinking
 * level unless the slot sets `thinking` or its own `effort`. Text: the text view (with project
 * instructions, trimmed to the advisor's window), the level's thinking, and a per-slot session id.
 */
export function advisorView<M extends ModelLike>(
	messages: readonly AgentMessage[],
	advisor: { model: M; config: AdvisorConfig; slot?: number },
	context: {
		input: Pick<
			RoundInput<M>,
			"actor" | "config" | "projectInstructions" | "sessionId" | "actorThinking" | "thinkingBudgets" | "projection" | "question" | "effort" | "request"
		> &
			Partial<Pick<RoundInput<M>, "reason">>;
		preset: PresetConfig;
		readPromptFile?: PromptFileReader;
	},
): AdvisorCall {
	const { input, preset } = context;
	const { config } = advisor;
	const view = selectView(preset.context.view, advisor.model, input.actor);
	const effort = slotEffort(roundEffort(preset, config, input.reason ?? "user_turn", input.effort), config, view === "native");
	const prompt = (base: string) => assemblePrompt(config.role, config, input.config.roles, context.readPromptFile, base, effort.lengthLine);
	const request = adviceRequest(input.question, input.request);
	if (view === "native") {
		const instruction = nativeInstruction(prompt(NATIVE_BASE_RULES), request);
		return {
			view,
			context: buildNativeView(messages, instruction, input.projection),
			tailTexts: [instruction],
			effort: effort.level,
			thinking: effort.thinking ?? input.actorThinking,
			thinkingBudgets: input.thinkingBudgets,
			maxTokens: effort.maxTokens,
			sessionId: input.sessionId,
			toolChoice: preset.context.nativeToolChoice,
		};
	}
	const instructions = preset.context.projectInstructions ? input.projectInstructions : undefined;
	const textView = buildTextView(messages, {
		systemPrompt: withProjectInstructions(prompt(BASE_RULES), instructions),
		toolResultChars: preset.context.toolResultChars,
		budgetChars: budgetChars(advisor.model.contextWindow, effort.maxTokens, effort.thinking),
		pin: preset.context.pin,
		request,
	});
	return {
		view,
		context: textView,
		tailTexts: adviceRequestBlocks(request),
		effort: effort.level,
		thinking: effort.thinking,
		maxTokens: effort.maxTokens,
		sessionId: advisorSessionId(input.sessionId, advisor.slot ?? 0),
	};
}

/** Output cap for the synthesis slot when it sets none. */
export const SYNTHESIS_MAX_TOKENS = 1024;

/** Appended to a reply that stopped at the output cap, so the actor knows the ending is missing. */
export const CAPPED_NOTE = "[advice cut off at the advisor's output limit; the ending is missing]";

/**
 * The synthesis slot's call: the text view (trimmed to its window) closed by the advisors' advice
 * and the reconciliation request. Its session id follows the advisor slots.
 */
export function synthesisView<M extends ModelLike>(
	messages: readonly AgentMessage[],
	synthesis: NonNullable<ResolvedPreset<M>["synthesis"]>,
	advice: readonly AdvisorResult[],
	context: { input: Pick<RoundInput<M>, "sessionId">; preset: PresetConfig; slot: number },
): AdvisorRequest<M> {
	const { config, model } = synthesis;
	const request = synthesisRequest(advice);
	const maxTokens = config.maxTokens ?? SYNTHESIS_MAX_TOKENS;
	const systemPrompt = config.prompt ? `${SYNTHESIS_RULES}\n\n${config.prompt.trim()}` : SYNTHESIS_RULES;
	const view = buildTextView(messages, {
		systemPrompt,
		toolResultChars: context.preset.context.toolResultChars,
		budgetChars: budgetChars(model.contextWindow, maxTokens, config.thinking),
		pin: context.preset.context.pin,
		request,
	});
	return {
		label: "synthesis",
		model,
		role: "synthesis",
		context: view,
		thinking: config.thinking,
		maxTokens,
		sessionId: advisorSessionId(context.input.sessionId, context.slot),
		onPayload: advisorPayload(adviceRequestBlocks(request)),
	};
}

/** Whether a synthesis reply says there was nothing to reconcile. */
export function isNoReconciliation(text: string): boolean {
	const line = text.trim().replace(/[*_`]/g, "").replace(/[.!]+$/, "").trim().toLowerCase();
	return line === NO_RECONCILIATION.replace(/\.$/, "").toLowerCase();
}

export interface RoundDeps<M> {
	complete: CompleteFn<M>;
	/** Saves the round as a session record; omitted for `consult`, whose tool result carries it. */
	appendEntry?: (customType: string, data: MoaRecord) => void;
	readPromptFile?: PromptFileReader;
	debug?: (line: string) => void;
	rng?: () => number;
	now?: () => number;
	/** See `RunOptions.abortGraceMs`. */
	abortGraceMs?: number;
	/** See `RunOptions.onAdvisorDone`. */
	onAdvisorDone?: (done: number, total: number) => void;
}

/**
 * Sanitises and caps a successful advisor's text, flagging what changed; marks a reply that
 * stopped at the output cap with `CAPPED_NOTE`, and reads the verdict line it opened with.
 */
export function cleanResult(result: AdvisorResult): AdvisorResult {
	if (!result.ok || result.text === undefined) return result;
	const clean = sanitizeAdvice(result.text);
	const text = result.capped ? `${clean.text.trimEnd()}\n\n${CAPPED_NOTE}` : clean.text;
	const verdict = parseVerdict(text);
	return {
		...result,
		text,
		...(verdict && { verdict }),
		...(clean.changed && { sanitized: true as const }),
		...(clean.truncated && { truncated: true as const }),
	};
}

/** The synthesis result, silent when it found nothing to reconcile. */
function cleanSynthesis(result: AdvisorResult): AdvisorResult {
	if (!result.ok || result.text === undefined) return result;
	if (isNoReconciliation(result.text)) return { ...result, text: undefined, silent: true };
	return cleanResult(result);
}

/** The request's messages with `text` appended as a trailing user message; `messages` is not modified. */
export function appendAdvice(messages: readonly AgentMessage[], text: string, timestamp: number): AgentMessage[] {
	return [...messages, { role: "user", content: [{ type: "text", text }], timestamp }];
}

/** Runs (and with `deps.appendEntry`, records) one advisor round; undefined when the preset has no usable advisors. */
export async function runRound<M extends ModelLike>(input: RoundInput<M>, deps: RoundDeps<M>): Promise<RoundOutput | undefined> {
	const debug = deps.debug ?? (() => {});
	const now = deps.now ?? Date.now;
	const preset = getPreset(input.config, input.presetName);
	if (!preset) {
		debug(`round skipped: unknown preset ${input.presetName}`);
		return undefined;
	}
	const resolved = resolvePreset(preset, input.models, input.actor);
	if (!resolved.ok) {
		debug(`round skipped: ${resolved.errors.join("; ")}`);
		return undefined;
	}
	if (resolved.preset.advisors.length === 0) return undefined;

	const slots = resolved.preset.advisors.map((advisor, slot) => ({ ...advisor, slot }));
	const arranged = arrangeAdvisors(slots, (a) => `${a.model.provider}/${a.model.id}`, {
		...preset.framing,
		rng: deps.rng,
	});
	const requests: AdvisorRequest<M>[] = arranged.map(({ item, label }) => {
		const call = advisorView(input.messages, item, { input, preset, readPromptFile: deps.readPromptFile });
		return {
			label,
			model: item.model,
			role: item.config.role ?? DEFAULT_ROLE,
			context: call.context,
			effort: call.effort,
			thinking: call.thinking,
			thinkingBudgets: call.thinkingBudgets,
			maxTokens: call.maxTokens,
			sessionId: call.sessionId,
			onPayload: advisorPayload(call.tailTexts),
			toolChoice: call.toolChoice,
		};
	});
	const runOptions = { complete: deps.complete, signal: input.signal, timeoutMs: preset.timeoutMs, now, abortGraceMs: deps.abortGraceMs };
	const raw = await runAdvisors(requests, { ...runOptions, onAdvisorDone: deps.onAdvisorDone });
	const results = raw.map(cleanResult);

	// Synthesis only has something to do with two or more advisors to reconcile.
	let synthesis: AdvisorResult | undefined;
	const answered = results.filter((r) => r.ok && r.text);
	if (resolved.preset.synthesis && answered.length >= 2 && input.signal?.aborted !== true) {
		const request = synthesisView(input.messages, resolved.preset.synthesis, answered, { input, preset, slot: slots.length });
		const [rawSynthesis] = await runAdvisors([request], { ...runOptions, onAdvisorDone: (done, total) => deps.onAdvisorDone?.(done, total) });
		synthesis = cleanSynthesis(rawSynthesis!);
	}

	const interrupted = input.signal?.aborted === true;
	const record: MoaRecord = {
		preset: input.presetName,
		reason: input.reason,
		...(input.question !== undefined && { question: input.question }),
		turn: input.turn,
		step: input.step,
		advisors: results,
		...(synthesis && { synthesis }),
	};
	if (interrupted) record.interrupted = true;
	try {
		deps.appendEntry?.(RECORD_ENTRY, record);
	} catch (error) {
		debug(`record failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const summary = results.map((r) => `${r.label}=${r.ok ? (r.verdict ?? "ok") : r.error}`);
	if (synthesis) summary.push(`synthesis=${synthesis.ok ? (synthesis.silent ? "silent" : (synthesis.verdict ?? "ok")) : synthesis.error}`);
	debug(`round ${input.presetName} (${input.reason}, step ${input.step}): ${summary.join(" ")}`);
	return { results, ...(synthesis && { synthesis }), interrupted, record };
}
