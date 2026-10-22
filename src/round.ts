import { runAdvisors, type AdvisorRequest, type AdvisorResult, type CompleteFn } from "./advisors.ts";
import { resolvePreset, type ModelLike, type ModelLookup } from "./config-resolve.ts";
import { getPreset, type MoaConfig } from "./config.ts";
import { arrangeAdvisors, frameAdvice } from "./framing.ts";
import { assemblePrompt, DEFAULT_ROLE, type PromptFileReader } from "./roles.ts";
import { turnPosition, type TurnPosition } from "./state.ts";
import { moveCacheMarker } from "./cache.ts";
import { ADVICE_REQUEST_BLOCKS, buildTextView, type AgentMessage } from "./view.ts";

export const RECORD_ENTRY = "moa";

export interface MoaRecord extends TurnPosition {
	preset: string;
	advisors: AdvisorResult[];
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
}

export interface RoundOutput {
	/** The request's messages with the advice appended. */
	messages: AgentMessage[];
	/** The exact advice text injected (the trailing user message's only text block). */
	advice: string;
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

/**
 * Runs one advisor round and returns the request's messages with the advice appended as a
 * trailing user message (plus the advice text), or undefined when there is no advice. `input.messages` is not modified.
 */
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

	const record: MoaRecord = { preset: input.presetName, ...turnPosition(input.messages), advisors: results };
	try {
		deps.appendEntry(RECORD_ENTRY, record);
	} catch (error) {
		debug(`record failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	debug(`round ${input.presetName}: ${results.map((r) => `${r.label}=${r.ok ? "ok" : r.error}`).join(" ")}`);

	const text = frameAdvice(results);
	if (!text) return undefined;
	const advice: AgentMessage = { role: "user", content: [{ type: "text", text }], timestamp: now() };
	return { messages: [...input.messages, advice], advice: text };
}
