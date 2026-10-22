import { runAdvisors, type AdvisorRequest, type AdvisorResult, type CompleteFn } from "./advisors.ts";
import { resolvePreset, type ModelLike, type ModelLookup } from "./config-resolve.ts";
import { getPreset, type MoaConfig } from "./config.ts";
import { arrangeAdvisors } from "./framing.ts";
import { assemblePrompt, DEFAULT_ROLE, type PromptFileReader } from "./roles.ts";
import { moveCacheMarker } from "./cache.ts";
import type { TriggerReason } from "./triggers.ts";
import { ADVICE_REQUEST_BLOCKS, buildTextView, type AgentMessage } from "./view.ts";

export const RECORD_ENTRY = "moa";

export interface MoaRecord {
	preset: string;
	/** Which trigger started the round. */
	reason: TriggerReason;
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
	/** pi session id; advisors get their own per-slot provider session id derived from it. */
	sessionId?: string;
	reason: TriggerReason;
	turn: string;
	step: number;
}

export interface RoundOutput {
	/** In display order. */
	results: AdvisorResult[];
	/** `signal` was aborted during the round: never cache or inject its advice. */
	interrupted: boolean;
}

/**
 * Provider session id for an advisor slot: stable across steps (so OpenAI-style `prompt_cache_key`
 * routing keeps hitting the same cache) and distinct from the actor's. The slot prefix comes first
 * because providers may truncate long keys (OpenAI clamps to 64 characters).
 */
export function advisorSessionId(sessionId: string | undefined, slot: number): string | undefined {
	return sessionId ? `moa${slot}-${sessionId}` : undefined;
}

/** Advisor payload hook: keeps the cache marker off the advice-request block. */
const advisorPayload = (payload: unknown): unknown => moveCacheMarker(payload, ADVICE_REQUEST_BLOCKS);

export interface RoundDeps<M> {
	complete: CompleteFn<M>;
	appendEntry: (customType: string, data: MoaRecord) => void;
	readPromptFile?: PromptFileReader;
	debug?: (line: string) => void;
	rng?: () => number;
	now?: () => number;
}

/** The request's messages with `text` appended as a trailing user message; `messages` is not modified. */
export function appendAdvice(messages: readonly AgentMessage[], text: string, timestamp: number): AgentMessage[] {
	return [...messages, { role: "user", content: [{ type: "text", text }], timestamp }];
}

/** Runs and records one advisor round; undefined when the preset has no usable advisors. */
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
	const requests: AdvisorRequest<M>[] = arranged.map(({ item, label }) => ({
		label,
		model: item.model,
		role: item.config.role ?? DEFAULT_ROLE,
		context: buildTextView(input.messages, {
			systemPrompt: assemblePrompt(item.config.role, item.config, input.config.roles, deps.readPromptFile),
			toolResultChars: preset.context.toolResultChars,
		}),
		thinking: item.config.thinking,
		maxTokens: item.config.maxTokens,
		sessionId: advisorSessionId(input.sessionId, item.slot),
		onPayload: advisorPayload,
	}));
	const results = await runAdvisors(requests, { complete: deps.complete, signal: input.signal, timeoutMs: preset.timeoutMs, now });

	const interrupted = input.signal?.aborted === true;
	const record: MoaRecord = { preset: input.presetName, reason: input.reason, turn: input.turn, step: input.step, advisors: results };
	if (interrupted) record.interrupted = true;
	try {
		deps.appendEntry(RECORD_ENTRY, record);
	} catch (error) {
		debug(`record failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	debug(`round ${input.presetName} (${input.reason}, step ${input.step}): ${results.map((r) => `${r.label}=${r.ok ? "ok" : r.error}`).join(" ")}`);
	return { results, interrupted };
}
