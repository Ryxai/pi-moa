import type { Context, ThinkingBudgets } from "@earendil-works/pi-ai";
import { runAdvisors, type AdvisorRequest, type AdvisorResult, type CompleteFn } from "./advisors.ts";
import { resolvePreset, type ModelLike, type ModelLookup } from "./config-resolve.ts";
import { getPreset, type MoaConfig } from "./config.ts";
import { arrangeAdvisors } from "./framing.ts";
import { assemblePrompt, BASE_RULES, DEFAULT_ROLE, NATIVE_BASE_RULES, withProjectInstructions, type PromptFileReader } from "./roles.ts";
import { moveCacheMarker } from "./cache.ts";
import { sanitizeAdvice } from "./sanitize.ts";
import type { AdvisorConfig, PresetConfig, ThinkingLevel } from "./schema.ts";
import { budgetChars } from "./trim.ts";
import type { TriggerReason } from "./triggers.ts";
import {
	adviceRequest,
	adviceRequestBlocks,
	buildNativeView,
	buildTextView,
	nativeInstruction,
	selectView,
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
	turn: string;
	step: number;
}

export interface RoundOutput {
	/** In display order. */
	results: AdvisorResult[];
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
	thinking?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	sessionId?: string;
	toolChoice?: "none" | "omit";
}

/**
 * One advisor's call. Native: the actor's projected request, the actor's thinking level unless
 * the slot sets one, and the actor's session id, so the request can reuse the actor's cache.
 * Text: the text view (with project instructions, trimmed to the advisor's window), the slot's
 * thinking level, and a per-slot session id.
 */
export function advisorView<M extends ModelLike>(
	messages: readonly AgentMessage[],
	advisor: { model: M; config: AdvisorConfig; slot?: number },
	context: {
		input: Pick<
			RoundInput<M>,
			"actor" | "config" | "projectInstructions" | "sessionId" | "actorThinking" | "thinkingBudgets" | "projection" | "question"
		>;
		preset: PresetConfig;
		readPromptFile?: PromptFileReader;
	},
): AdvisorCall {
	const { input, preset } = context;
	const { config } = advisor;
	const view = selectView(preset.context.view, advisor.model, input.actor);
	const prompt = (base: string) => assemblePrompt(config.role, config, input.config.roles, context.readPromptFile, base);
	const request = adviceRequest(input.question);
	if (view === "native") {
		const instruction = nativeInstruction(prompt(NATIVE_BASE_RULES), request);
		return {
			view,
			context: buildNativeView(messages, instruction, input.projection),
			tailTexts: [instruction],
			thinking: config.thinking ?? input.actorThinking,
			thinkingBudgets: input.thinkingBudgets,
			sessionId: input.sessionId,
			toolChoice: preset.context.nativeToolChoice,
		};
	}
	const instructions = preset.context.projectInstructions ? input.projectInstructions : undefined;
	const textView = buildTextView(messages, {
		systemPrompt: withProjectInstructions(prompt(BASE_RULES), instructions),
		toolResultChars: preset.context.toolResultChars,
		budgetChars: budgetChars(advisor.model.contextWindow, config.maxTokens, config.thinking),
		pin: preset.context.pin,
		request,
	});
	return {
		view,
		context: textView,
		tailTexts: adviceRequestBlocks(request),
		thinking: config.thinking,
		sessionId: advisorSessionId(input.sessionId, advisor.slot ?? 0),
	};
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

/** Sanitises and caps a successful advisor's text, flagging what changed. */
function cleanResult(result: AdvisorResult): AdvisorResult {
	if (!result.ok || result.text === undefined) return result;
	const clean = sanitizeAdvice(result.text);
	return {
		...result,
		text: clean.text,
		...(clean.changed && { sanitized: true as const }),
		...(clean.truncated && { truncated: true as const }),
	};
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
			thinking: call.thinking,
			thinkingBudgets: call.thinkingBudgets,
			maxTokens: item.config.maxTokens,
			sessionId: call.sessionId,
			onPayload: advisorPayload(call.tailTexts),
			toolChoice: call.toolChoice,
		};
	});
	const raw = await runAdvisors(requests, { complete: deps.complete, signal: input.signal, timeoutMs: preset.timeoutMs, now, abortGraceMs: deps.abortGraceMs, onAdvisorDone: deps.onAdvisorDone });
	const results = raw.map(cleanResult);

	const interrupted = input.signal?.aborted === true;
	const record: MoaRecord = {
		preset: input.presetName,
		reason: input.reason,
		...(input.question !== undefined && { question: input.question }),
		turn: input.turn,
		step: input.step,
		advisors: results,
	};
	if (interrupted) record.interrupted = true;
	try {
		deps.appendEntry?.(RECORD_ENTRY, record);
	} catch (error) {
		debug(`record failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	debug(`round ${input.presetName} (${input.reason}, step ${input.step}): ${results.map((r) => `${r.label}=${r.ok ? "ok" : r.error}`).join(" ")}`);
	return { results, interrupted, record };
}
