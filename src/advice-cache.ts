import type { AdvisorResult } from "./advisors.ts";
import { frameAdvice, STALE_NOTE } from "./framing.ts";
import type { PresetConfig } from "./schema.ts";
import { shouldRun, type FailureFired, type TriggerDecision, type TurnAnalysis } from "./triggers.ts";

/** Latest advice for one turn plus the last step a round ran at. Replaced when the turn changes. */
export interface TurnCache {
	readonly turnKey: string;
	/** Step of the last completed (not interrupted) round; a request at this step again is a retry. */
	lastRunStep?: number;
	/** The latest round in this turn that produced advice; `step: -1` after a mid-turn compaction. */
	advice?: { step: number; results: readonly AdvisorResult[] };
	/** Failure streaks that completed `on_failure` rounds fired on. */
	failureFired?: FailureFired;
}

/**
 * The cache for this request's turn: `cache` itself when the turn is unchanged, else a fresh one.
 * When compaction removed the turn's user message (the turn continues), the advice is kept but
 * rebased: its step is unknown in the new transcript, so it is always reused as stale.
 */
export function cacheForTurn(cache: TurnCache | undefined, analysis: Pick<TurnAnalysis, "turnKey" | "compacted">): TurnCache {
	if (cache?.turnKey === analysis.turnKey) return cache;
	if (cache && analysis.compacted) {
		return {
			turnKey: analysis.turnKey,
			...(cache.advice && { advice: { step: -1, results: cache.advice.results } }),
			...(cache.failureFired && { failureFired: cache.failureFired }),
		};
	}
	return { turnKey: analysis.turnKey };
}

const NO_RUN: TriggerDecision = { run: false, reason: null };

/** Whether to run a fresh round; never for a step that already ran (a retried request). */
export function decideRound(cache: TurnCache, preset: Pick<PresetConfig, "triggers" | "onFailure">, analysis: TurnAnalysis): TriggerDecision {
	if (cache.lastRunStep === analysis.step) return NO_RUN;
	return shouldRun(preset.triggers, preset.onFailure, analysis, cache.failureFired);
}

/** Records a completed round started by `decision`. Interrupted rounds must not be passed here. */
export function storeRound(cache: TurnCache, step: number, results: readonly AdvisorResult[], decision: TriggerDecision): void {
	cache.lastRunStep = step;
	if (decision.failure) cache.failureFired = { ...cache.failureFired, ...decision.failure };
	if (results.some((r) => r.ok && r.text)) cache.advice = { step, results };
}

/**
 * The advice text for this request: the cached advice framed as when it was produced, plus the
 * stale note when tool results arrived after the step it was produced for.
 */
export function adviceText(cache: TurnCache, analysis: TurnAnalysis): string | undefined {
	const advice = cache.advice;
	if (!advice || advice.step > analysis.step) return undefined;
	const stale = advice.step < 0 || analysis.lastToolResultStep > advice.step;
	return frameAdvice(advice.results, stale ? STALE_NOTE : undefined);
}
