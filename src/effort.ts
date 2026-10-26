import { EFFORT_LEVELS, type AdvisorConfig, type EffortLevel, type PresetConfig, type ThinkingLevel } from "./schema.ts";
import type { RoundReason } from "./round.ts";

/** What one effort level sets, unless the slot overrides a field. */
export interface EffortProfile {
	thinking: ThinkingLevel;
	maxTokens: number;
	/** Soft length guidance for the prompt (about 80% of what `maxTokens` allows). */
	lengthLine: string;
}

/**
 * Effort bundles. Thinking is the reasoning depth (pi maps it to the provider's effort or budget
 * and clamps it to what the model supports); `maxTokens` caps the reply; the length line is the
 * soft target the advisor is told. `max` sets no word cap but asks for a summary first.
 */
export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
	low: {
		thinking: "low",
		maxTokens: 1024,
		lengthLine: "Keep under about 120 words: the single most important next step, then at most two risks.",
	},
	medium: {
		thinking: "medium",
		maxTokens: 2048,
		lengthLine: "Keep under about 300 words unless the problem truly needs more.",
	},
	high: {
		thinking: "high",
		maxTokens: 4096,
		lengthLine: "Keep under about 600 words; say what the agent should verify and how.",
	},
	max: {
		thinking: "max",
		maxTokens: 8192,
		lengthLine: "No length limit, but open with a summary of three to five lines before the detail.",
	},
};

/** Round reasons that run one level above the base effort. */
const BUMPED: ReadonlySet<RoundReason> = new Set<RoundReason>(["on_failure", "before_done", "consult"]);

export function effortIndex(level: EffortLevel): number {
	return EFFORT_LEVELS.indexOf(level);
}

/** The lower of two levels. */
export function minEffort(a: EffortLevel, b: EffortLevel): EffortLevel {
	return effortIndex(a) <= effortIndex(b) ? a : b;
}

/** One level up, staying within the scale. */
export function bumpEffort(level: EffortLevel): EffortLevel {
	return EFFORT_LEVELS[Math.min(effortIndex(level) + 1, EFFORT_LEVELS.length - 1)]!;
}

/**
 * The effort level a round runs a slot at: `requested` (the actor's `consult` effort) when
 * given, else the slot's or the preset's base, raised one level for `on_failure`, `before_done`
 * and `consult` rounds; never above the preset's `maxEffort`.
 */
export function roundEffort(
	preset: Pick<PresetConfig, "effort" | "maxEffort">,
	slot: Pick<AdvisorConfig, "effort">,
	reason: RoundReason,
	requested?: EffortLevel,
): EffortLevel {
	const base = slot.effort ?? preset.effort;
	const level = requested ?? (BUMPED.has(reason) ? bumpEffort(base) : base);
	return minEffort(level, preset.maxEffort);
}

export interface SlotEffort {
	level: EffortLevel;
	/** Undefined when the slot leaves thinking to the actor (native view without an explicit level). */
	thinking: ThinkingLevel | undefined;
	maxTokens: number;
	lengthLine: string;
}

/**
 * The settings a slot runs with at `level`. Explicit `thinking` and `maxTokens` on the slot win.
 * With `keepActorThinking` (native view: the call shares the actor's prompt cache, which a
 * different thinking level would invalidate on some providers), thinking comes from the level
 * only when the slot sets its own `effort`; otherwise it is left undefined for the caller to fill
 * with the actor's level.
 */
export function slotEffort(
	level: EffortLevel,
	slot: Pick<AdvisorConfig, "effort" | "thinking" | "maxTokens">,
	keepActorThinking = false,
): SlotEffort {
	const profile = EFFORT_PROFILES[level];
	const thinking = slot.thinking ?? (keepActorThinking && slot.effort === undefined ? undefined : profile.thinking);
	return { level, thinking, maxTokens: slot.maxTokens ?? profile.maxTokens, lengthLine: profile.lengthLine };
}
