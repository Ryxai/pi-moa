export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const BUILTIN_ROLES = ["advisor", "planner", "reviewer", "critic"] as const;
export const STANCES = ["for", "against", "neutral"] as const;
export const NAMED_TRIGGERS = ["user_turn", "every_step", "on_failure"] as const;
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
	thinking?: ThinkingLevel;
	maxTokens?: number;
}

export interface PresetConfig {
	actor: ModelRef;
	advisors: AdvisorConfig[];
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
	advisors: [{ model: "current", role: "advisor", maxTokens: 2048 }],
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
