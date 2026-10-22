import { RESERVED_NAMES, reservedNameIssues, validateConfig, type ConfigIssue } from "./config-validate.ts";
import { DEFAULT_CONFIG, DEFAULT_PRESET, isPlainObject, type MoaConfig, type PlainObject, type PresetConfig } from "./schema.ts";

export * from "./schema.ts";

/**
 * Objects merge recursively; arrays and scalars from `override` replace `base`. Inputs are not
 * mutated, and prototype-polluting keys are dropped.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return clone(base);
	if (!isPlainObject(override)) return clone(override);
	const baseObj = isPlainObject(base) ? base : {};
	const out = clone(baseObj) as PlainObject;
	for (const [key, value] of Object.entries(override)) {
		if (RESERVED_NAMES.has(key)) continue;
		out[key] = deepMerge(ownValue(baseObj, key), value);
	}
	return out;
}

export function ownValue(obj: PlainObject, key: string): unknown {
	return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function clone(value: unknown): unknown {
	return value === undefined ? undefined : structuredClone(value);
}

/** Like `deepMerge`, but each role in `layer` replaces the earlier definition wholesale. */
function mergeLayer(acc: unknown, layer: unknown): unknown {
	const merged = deepMerge(acc, layer);
	if (!isPlainObject(merged) || !isPlainObject(layer) || !isPlainObject(layer.roles)) return merged;
	if (!isPlainObject(merged.roles)) return merged;
	for (const [name, role] of Object.entries(layer.roles)) {
		if (!RESERVED_NAMES.has(name)) merged.roles[name] = clone(role);
	}
	return merged;
}

/**
 * Merges config layers (lowest precedence first) over the defaults, then expands every preset
 * over `DEFAULT_PRESET` so presets only need to list what differs.
 */
export function mergeLayers(layers: readonly unknown[]): unknown {
	const merged = layers.reduce<unknown>(mergeLayer, DEFAULT_CONFIG);
	if (!isPlainObject(merged) || !isPlainObject(merged.presets)) return merged;
	const presets: PlainObject = {};
	for (const [name, preset] of Object.entries(merged.presets)) {
		presets[name] = isPlainObject(preset) ? deepMerge(DEFAULT_PRESET, preset) : preset;
	}
	return { ...merged, presets };
}

export interface ParsedConfig {
	config: MoaConfig;
	issues: ConfigIssue[];
}

/** `config` is only trustworthy for parts without issues; see `issuesFor`. */
export function parseConfig(layers: readonly unknown[]): ParsedConfig {
	const merged = mergeLayers(layers);
	const issues = [...layers.flatMap(reservedNameIssues), ...validateConfig(merged)];
	return { config: merged as MoaConfig, issues };
}

/** Issues that block using `preset`: global issues plus that preset's own. */
export function issuesFor(issues: readonly ConfigIssue[], preset: string): ConfigIssue[] {
	return issues.filter((issue) => issue.preset === undefined || issue.preset === preset);
}

/** Own-property lookup, so names like "constructor" or "toString" are not presets. */
export function getPreset(config: MoaConfig, name: string): PresetConfig | undefined {
	return isPlainObject(config.presets) ? (ownValue(config.presets, name) as PresetConfig | undefined) : undefined;
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
	return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

export type { ConfigIssue };
