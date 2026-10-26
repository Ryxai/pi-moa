export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Advisor effort: a bundle of thinking level, output cap and length guidance (see effort.ts). */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** The one-line verdict each advisor opens with (see verdict.ts). */
export const VERDICTS = ["on-track", "revise", "blocked"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const BUILTIN_ROLES = ["advisor", "planner", "reviewer", "critic"] as const;
export const STANCES = ["for", "against", "neutral"] as const;
export const NAMED_TRIGGERS = ["user_turn", "every_step", "on_failure", "before_done"] as const;
export const CONTEXT_VIEWS = ["auto", "native", "text"] as const;
export const NATIVE_TOOL_CHOICES = ["omit", "none"] as const;
export const PIN_ITEMS = ["task", "latestError", "latestDiff"] as const;
export const BUDGET_ACTIONS = ["warn", "pause", "stop"] as const;
export const ADVICE_DISPLAY = ["collapsed", "expanded", "hidden"] as const;

export type Stance = (typeof STANCES)[number];
export type NamedTrigger = (typeof NAMED_TRIGGERS)[number];
export type Trigger = NamedTrigger | { every_n: number };
export type ContextView = (typeof CONTEXT_VIEWS)[number];
export type PinItem = (typeof PIN_ITEMS)[number];

/** `"current"` or `provider/id`. */
export type ModelRef = string;

export interface RoleConfig {
	prompt?: string;
	promptFile?: string;
	replaceBase?: boolean;
}

export interface AdvisorConfig {
	model: ModelRef;
	role?: string;
	prompt?: string;
	stance?: Stance;
	/** Base effort for this slot; defaults to the preset's `effort`. */
	effort?: EffortLevel;
	/** Explicit thinking level; overrides what the effort level sets. */
	thinking?: ThinkingLevel;
	/** Explicit output cap; overrides what the effort level sets. */
	maxTokens?: number;
}

/**
 * The optional synthesis slot: after a round with two or more advisors it reads their advice and
 * reconciles disagreements, or says nothing when there is nothing to reconcile.
 */
export interface SynthesisConfig {
	model: ModelRef;
	thinking?: ThinkingLevel;
	maxTokens?: number;
	/** Extra instructions appended to the synthesis rules. */
	prompt?: string;
}

export interface PresetConfig {
	actor: ModelRef;
	advisors: AdvisorConfig[];
	/** Absent: advice is framed as written, with a note that it is unreconciled. */
	synthesis?: SynthesisConfig;
	/** Base effort for rounds; `on_failure`, `before_done` and `consult` rounds run one level higher. */
	effort: EffortLevel;
	/** Bumps and `consult` requests never exceed this. */
	maxEffort: EffortLevel;
	triggers: Trigger[];
	onFailure: { consecutiveErrors: number; repeatedCalls: number };
	consult: { enabled: boolean; maxPerTurn: number };
	context: {
		view: ContextView;
		projectInstructions: boolean;
		toolResultChars: number;
		pin: PinItem[];
		/**
		 * Native view: "omit" sends no tool_choice (shares the actor's message cache; a reply with no
		 * text is retried once with "none"); "none" always sends tool_choice none.
		 */
		nativeToolChoice: (typeof NATIVE_TOOL_CHOICES)[number];
	};
	framing: { anonymize: boolean; shuffle: boolean };
	timeoutMs: number;
}

export interface MoaConfig {
	defaultPreset: string;
	roles: Record<string, RoleConfig>;
	presets: Record<string, PresetConfig>;
	budget: { sessionUsd: number; onExceed: (typeof BUDGET_ACTIONS)[number] };
	ui: { advice: (typeof ADVICE_DISPLAY)[number]; status: boolean };
	virtualModels: boolean;
}

export const DEFAULT_PRESET: PresetConfig = {
	actor: "current",
	advisors: [{ model: "current", role: "advisor" }],
	effort: "medium",
	maxEffort: "max",
	triggers: ["user_turn", "on_failure"],
	onFailure: { consecutiveErrors: 2, repeatedCalls: 3 },
	consult: { enabled: true, maxPerTurn: 3 },
	context: {
		view: "auto",
		projectInstructions: true,
		toolResultChars: 4000,
		pin: ["task", "latestError", "latestDiff"],
		nativeToolChoice: "omit",
	},
	framing: { anonymize: true, shuffle: true },
	timeoutMs: 90_000,
};

export const DEFAULT_CONFIG: MoaConfig = {
	defaultPreset: "solo",
	roles: {},
	presets: { solo: DEFAULT_PRESET },
	budget: { sessionUsd: 5, onExceed: "warn" },
	ui: { advice: "collapsed", status: true },
	virtualModels: false,
};

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
