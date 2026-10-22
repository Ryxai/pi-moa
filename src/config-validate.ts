import {
	ADVICE_DISPLAY,
	BUDGET_ACTIONS,
	BUILTIN_ROLES,
	CONTEXT_VIEWS,
	isPlainObject,
	NAMED_TRIGGERS,
	PIN_ITEMS,
	type PlainObject,
	STANCES,
	THINKING_LEVELS,
} from "./schema.ts";

export interface ConfigIssue {
	path: string;
	message: string;
	/** Set when the issue only affects one preset. */
	preset?: string;
}

export const MAX_ADVISORS = 3;

/** Names dropped by the merge because they could pollute prototypes. */
export const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

type Report = (path: string, message: string) => void;

const TOP_KEYS = ["defaultPreset", "roles", "presets", "budget", "ui", "virtualModels"];
const PRESET_KEYS = ["actor", "advisors", "triggers", "onFailure", "consult", "context", "framing", "timeoutMs"];
const ADVISOR_KEYS = ["model", "role", "prompt", "stance", "thinking", "maxTokens"];
const ROLE_KEYS = ["prompt", "promptFile", "replaceBase"];

/** Merging drops reserved keys, so they're checked on the raw layers. */
export function reservedNameIssues(layer: unknown): ConfigIssue[] {
	if (!isPlainObject(layer)) return [];
	const issues: ConfigIssue[] = [];
	for (const section of ["presets", "roles"] as const) {
		const names = layer[section];
		if (!isPlainObject(names)) continue;
		for (const name of Object.keys(names)) {
			if (RESERVED_NAMES.has(name)) issues.push({ path: `${section}.${name}`, message: "reserved name; choose another" });
		}
	}
	return issues;
}

export function validateConfig(config: unknown): ConfigIssue[] {
	const issues: ConfigIssue[] = [];
	const global: Report = (path, message) => issues.push({ path, message });
	if (!isPlainObject(config)) {
		global("config", "must be an object");
		return issues;
	}
	checkKeys(config, TOP_KEYS, "", global);
	const roles = validateRoles(config.roles, global);
	validatePresets(config.presets, roles, issues);
	if (typeof config.defaultPreset !== "string") global("defaultPreset", "must be a string");
	else if (isPlainObject(config.presets) && !Object.hasOwn(config.presets, config.defaultPreset)) {
		global("defaultPreset", `unknown preset "${config.defaultPreset}"`);
	}
	validateBudget(config.budget, global);
	validateUi(config.ui, global);
	checkBoolean(config.virtualModels, "virtualModels", global);
	return issues;
}

/** Returns every known role name (built in plus configured). */
function validateRoles(roles: unknown, report: Report): Set<string> {
	const names = new Set<string>(BUILTIN_ROLES);
	if (!isPlainObject(roles)) {
		report("roles", "must be an object");
		return names;
	}
	for (const [name, role] of Object.entries(roles)) {
		names.add(name);
		const path = `roles.${name}`;
		if (!isPlainObject(role)) {
			report(path, "must be an object");
			continue;
		}
		checkKeys(role, ROLE_KEYS, path, report);
		const hasPrompt = role.prompt !== undefined;
		const hasFile = role.promptFile !== undefined;
		if (hasPrompt && hasFile) report(path, 'use either "prompt" or "promptFile", not both');
		const builtin = (BUILTIN_ROLES as readonly string[]).includes(name);
		if (!hasPrompt && !hasFile && !builtin) report(path, 'a new role needs "prompt" or "promptFile"');
		if (hasPrompt) checkString(role.prompt, `${path}.prompt`, report);
		if (hasFile) checkString(role.promptFile, `${path}.promptFile`, report);
		if (role.replaceBase !== undefined) checkBoolean(role.replaceBase, `${path}.replaceBase`, report);
	}
	return names;
}

function validatePresets(presets: unknown, roles: Set<string>, issues: ConfigIssue[]): void {
	if (!isPlainObject(presets)) {
		issues.push({ path: "presets", message: "must be an object" });
		return;
	}
	for (const [name, preset] of Object.entries(presets)) {
		const report: Report = (path, message) => issues.push({ path, message, preset: name });
		validatePreset(preset, `presets.${name}`, roles, report);
	}
}

function validatePreset(preset: unknown, path: string, roles: Set<string>, report: Report): void {
	if (!isPlainObject(preset)) {
		report(path, "must be an object");
		return;
	}
	checkKeys(preset, PRESET_KEYS, path, report);
	checkModelRef(preset.actor, `${path}.actor`, report);
	validateAdvisors(preset.advisors, `${path}.advisors`, roles, report);
	validateTriggers(preset.triggers, `${path}.triggers`, report);
	const { onFailure, consult, context, framing } = preset;
	if (asObject(onFailure, `${path}.onFailure`, report)) {
		checkInt(onFailure.consecutiveErrors, `${path}.onFailure.consecutiveErrors`, 1, 100, report);
		checkInt(onFailure.repeatedCalls, `${path}.onFailure.repeatedCalls`, 2, 100, report);
	}
	if (asObject(consult, `${path}.consult`, report)) {
		checkBoolean(consult.enabled, `${path}.consult.enabled`, report);
		checkInt(consult.maxPerTurn, `${path}.consult.maxPerTurn`, 0, 100, report);
	}
	if (asObject(context, `${path}.context`, report)) validateContext(context, `${path}.context`, report);
	if (asObject(framing, `${path}.framing`, report)) {
		checkBoolean(framing.anonymize, `${path}.framing.anonymize`, report);
		checkBoolean(framing.shuffle, `${path}.framing.shuffle`, report);
	}
	checkInt(preset.timeoutMs, `${path}.timeoutMs`, 1000, 3_600_000, report);
}

function validateAdvisors(advisors: unknown, path: string, roles: Set<string>, report: Report): void {
	if (!Array.isArray(advisors)) {
		report(path, "must be an array");
		return;
	}
	if (advisors.length === 0) report(path, "needs at least one advisor");
	if (advisors.length > MAX_ADVISORS) report(path, `at most ${MAX_ADVISORS} advisors allowed, got ${advisors.length}`);
	advisors.forEach((advisor, i) => validateAdvisor(advisor, `${path}[${i}]`, roles, report));
}

function validateAdvisor(advisor: unknown, path: string, roles: Set<string>, report: Report): void {
	if (!isPlainObject(advisor)) {
		report(path, "must be an object");
		return;
	}
	checkKeys(advisor, ADVISOR_KEYS, path, report);
	checkModelRef(advisor.model, `${path}.model`, report);
	if (advisor.role !== undefined && checkString(advisor.role, `${path}.role`, report) && !roles.has(advisor.role)) {
		report(`${path}.role`, `unknown role "${advisor.role}" (known: ${[...roles].join(", ")})`);
	}
	if (advisor.prompt !== undefined) checkString(advisor.prompt, `${path}.prompt`, report);
	if (advisor.stance !== undefined) checkEnum(advisor.stance, STANCES, `${path}.stance`, report);
	if (advisor.thinking !== undefined) checkEnum(advisor.thinking, THINKING_LEVELS, `${path}.thinking`, report);
	if (advisor.maxTokens !== undefined) checkInt(advisor.maxTokens, `${path}.maxTokens`, 1, 1_000_000, report);
}

function validateTriggers(triggers: unknown, path: string, report: Report): void {
	if (!Array.isArray(triggers)) {
		report(path, "must be an array");
		return;
	}
	triggers.forEach((trigger, i) => {
		const at = `${path}[${i}]`;
		if (typeof trigger === "string") {
			checkEnum(trigger, NAMED_TRIGGERS, at, report);
		} else if (isPlainObject(trigger) && "every_n" in trigger) {
			checkKeys(trigger, ["every_n"], at, report);
			checkInt(trigger.every_n, `${at}.every_n`, 1, 1000, report);
		} else {
			report(at, `must be one of ${NAMED_TRIGGERS.map((t) => `"${t}"`).join(", ")} or { "every_n": N }`);
		}
	});
}

function validateContext(context: PlainObject, path: string, report: Report): void {
	checkEnum(context.view, CONTEXT_VIEWS, `${path}.view`, report);
	checkBoolean(context.projectInstructions, `${path}.projectInstructions`, report);
	checkInt(context.toolResultChars, `${path}.toolResultChars`, 0, 1_000_000, report);
	if (!Array.isArray(context.pin)) report(`${path}.pin`, "must be an array");
	else context.pin.forEach((item, i) => checkEnum(item, PIN_ITEMS, `${path}.pin[${i}]`, report));
}

function validateBudget(budget: unknown, report: Report): void {
	if (!asObject(budget, "budget", report)) return;
	const usd = budget.sessionUsd;
	if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
		report("budget.sessionUsd", "must be a number ≥ 0");
	}
	checkEnum(budget.onExceed, BUDGET_ACTIONS, "budget.onExceed", report);
}

function validateUi(ui: unknown, report: Report): void {
	if (!asObject(ui, "ui", report)) return;
	checkEnum(ui.advice, ADVICE_DISPLAY, "ui.advice", report);
	checkBoolean(ui.status, "ui.status", report);
}

/** Model refs are `"current"` or `provider/id`; virtual `moa/*` models cannot be used inside a preset. */
export function modelRefError(ref: unknown): string | undefined {
	if (typeof ref !== "string") return 'must be "current" or "provider/id"';
	if (ref === "current") return undefined;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return `"${ref}" must be "current" or "provider/id"`;
	if (ref.slice(0, slash) === "moa") return `"${ref}": moa/* virtual models cannot be used inside a preset`;
	return undefined;
}

function checkModelRef(ref: unknown, path: string, report: Report): void {
	const error = modelRefError(ref);
	if (error) report(path, error);
}

function checkKeys(obj: PlainObject, allowed: readonly string[], path: string, report: Report): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) report(path ? `${path}.${key}` : key, "unknown key");
	}
}

function asObject(value: unknown, path: string, report: Report): value is PlainObject {
	if (isPlainObject(value)) return true;
	report(path, "must be an object");
	return false;
}

function checkString(value: unknown, path: string, report: Report): value is string {
	if (typeof value === "string" && value.trim() !== "") return true;
	report(path, "must be a non-empty string");
	return false;
}

function checkBoolean(value: unknown, path: string, report: Report): void {
	if (typeof value !== "boolean") report(path, "must be true or false");
}

function checkInt(value: unknown, path: string, min: number, max: number, report: Report): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		report(path, `must be an integer from ${min} to ${max}`);
	}
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, report: Report): void {
	if (typeof value !== "string" || !allowed.includes(value)) {
		report(path, `must be one of ${allowed.map((v) => `"${v}"`).join(", ")}`);
	}
}
