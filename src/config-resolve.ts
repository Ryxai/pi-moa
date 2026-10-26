import type { Api, Model } from "@earendil-works/pi-ai";
import type { AdvisorConfig, PresetConfig, SynthesisConfig } from "./schema.ts";

export interface ModelLike {
	provider: string;
	id: string;
	/** pi's `Model` fields that advisor calls use when present. */
	api?: string;
	contextWindow?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}

/** The slice of pi's ModelRegistry that resolution needs. */
export interface ModelLookup<M extends ModelLike> {
	find(provider: string, modelId: string): M | undefined;
	hasConfiguredAuth(model: M): boolean;
}

export interface ResolvedAdvisor<M extends ModelLike> {
	config: AdvisorConfig;
	model: M;
}

export interface ResolvedPreset<M extends ModelLike> {
	actor: M;
	advisors: ResolvedAdvisor<M>[];
	synthesis?: { config: SynthesisConfig; model: M };
}

export type ResolveResult<M extends ModelLike> =
	| { ok: true; preset: ResolvedPreset<M> }
	| { ok: false; errors: string[] };

/**
 * Resolves every model in a preset against the registry. `"current"` means `actor`
 * (the model the user is driving). Assumes the preset already passed validation.
 */
export function resolvePreset<M extends ModelLike>(
	preset: PresetConfig,
	lookup: ModelLookup<M>,
	current: M | undefined,
): ResolveResult<M> {
	const errors: string[] = [];
	const resolve = (ref: string, label: string): M | undefined => {
		const result = resolveModel(ref, lookup, current);
		if (typeof result === "string") errors.push(`${label}: ${result}`);
		return typeof result === "string" ? undefined : result;
	};
	const actor = resolve(preset.actor, "actor");
	const advisors: ResolvedAdvisor<M>[] = [];
	preset.advisors.forEach((config, i) => {
		const model = resolve(config.model, `advisor ${i + 1}`);
		if (model) advisors.push({ config, model });
	});
	const synthesisModel = preset.synthesis ? resolve(preset.synthesis.model, "synthesis") : undefined;
	if (errors.length > 0 || !actor) return { ok: false, errors };
	return { ok: true, preset: { actor, advisors, ...(preset.synthesis && synthesisModel && { synthesis: { config: preset.synthesis, model: synthesisModel } }) } };
}

/** Returns the model, or a human-readable reason it can't be used. */
export function resolveModel<M extends ModelLike>(
	ref: string,
	lookup: ModelLookup<M>,
	current: M | undefined,
): M | string {
	let model: M | undefined;
	if (ref === "current") {
		if (!current) return '"current" needs a selected model';
		model = current;
	} else {
		const slash = ref.indexOf("/");
		model = lookup.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) return `model "${ref}" not found`;
	}
	if (!lookup.hasConfiguredAuth(model)) return `no credentials configured for "${model.provider}/${model.id}"`;
	return model;
}
