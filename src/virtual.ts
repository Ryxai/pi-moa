import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import { issuesFor, type ConfigIssue, type MoaConfig, type PresetConfig } from "./config.ts";
import { resolveModel, type ModelLike, type ModelLookup } from "./config-resolve.ts";
import type { EntryLike } from "./state.ts";
import type { AgentMessage } from "./view.ts";

/** Provider the `moa/<preset>` virtual models are listed under. */
export const VIRTUAL_PROVIDER = "moa";
/** pi's api id for virtual catalog entries (`VIRTUAL_MODEL_API`, not exported by the package). */
const VIRTUAL_API = "pi-virtual";

/** Letters, digits, `.`, `_`, `-`: no `/` (provider separator), `:` (thinking suffix) or spaces. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Router state stored on the session branch: the physical actor `"current"` resolved to. */
export interface RouteState {
	actor: string;
}

export interface VirtualPlan {
	valid: string[];
	invalid: { name: string; reason: string }[];
}

/** Which presets get a `moa/<preset>` model: none unless `virtualModels`, then those with a usable id and no config issues. */
export function planVirtualModels(config: MoaConfig, issues: readonly ConfigIssue[]): VirtualPlan {
	const plan: VirtualPlan = { valid: [], invalid: [] };
	if (config.virtualModels !== true) return plan;
	for (const name of Object.keys(config.presets ?? {})) {
		if (!MODEL_ID.test(name)) plan.invalid.push({ name, reason: "not usable as a model id (use letters, digits, '.', '_', '-')" });
		else if (issuesFor(issues, name).length > 0) plan.invalid.push({ name, reason: "has config issues" });
		else plan.valid.push(name);
	}
	return plan;
}

export function isVirtual(model: { provider: string; api?: string } | undefined): boolean {
	return model !== undefined && (model.api === VIRTUAL_API || model.provider === VIRTUAL_PROVIDER);
}

/** The preset a selected `moa/<preset>` model stands for. */
export function presetOfModel(model: { provider: string; id: string } | undefined): string | undefined {
	return model?.provider === VIRTUAL_PROVIDER ? model.id : undefined;
}

export const modelKey = (model: ModelLike): string => `${model.provider}/${model.id}`;

const sameModel = (a: ModelLike, b: ModelLike): boolean => a.provider === b.provider && a.id === b.id;

/**
 * The last physical model the user selected. `fresh` marks a selection made since the session
 * started, which beats the branch's stored route state; a model carried over from an earlier
 * session only fills in when the branch has none.
 */
export interface Tracked<M> {
	model: M;
	fresh: boolean;
}

/** Updates the tracked physical model on `model_select`. */
export function trackSelection<M extends ModelLike & { api?: string }>(
	tracked: Tracked<M> | undefined,
	event: { model: M; previousModel: M | undefined; source: string },
): Tracked<M> | undefined {
	if (!isVirtual(event.model)) return { model: event.model, fresh: true };
	const previous = event.previousModel;
	if (presetOfModel(event.model) !== undefined && event.source !== "restore" && previous && !isVirtual(previous)) {
		return { model: previous, fresh: true };
	}
	return tracked;
}

/** At session start or tree navigation: a physical selection is fresh, otherwise keep the old one as a fallback. */
export function trackSession<M extends ModelLike & { api?: string }>(tracked: Tracked<M> | undefined, model: M | undefined): Tracked<M> | undefined {
	if (model && !isVirtual(model)) return { model, fresh: true };
	return tracked && { model: tracked.model, fresh: false };
}

export interface ActorInputs<M> {
	tracked?: Tracked<M>;
	state?: RouteState;
	/** Physical model of the latest successful response (`request.previous`). */
	previous?: M;
}

export type ActorResult<M> = { ok: true; model: M; state?: RouteState } | { ok: false; error: string };

/**
 * The physical actor of `moa/<preset>`: a concrete `actor`, or for `"current"` the freshly
 * selected model, then the branch's route state, then a carried-over selection, then the model
 * that answered last. `state` is set for `"current"` so the choice survives resume and branches.
 */
export function resolveActor<M extends ModelLike>(preset: Pick<PresetConfig, "actor">, lookup: ModelLookup<M>, inputs: ActorInputs<M>): ActorResult<M> {
	if (preset.actor !== "current") {
		const result = resolveModel(preset.actor, lookup, undefined);
		return typeof result === "string" ? { ok: false, error: `actor: ${result}` } : { ok: true, model: result };
	}
	const fromState = inputs.state ? findRef(inputs.state.actor, lookup) : undefined;
	const tracked = inputs.tracked;
	const candidate = (tracked?.fresh ? tracked.model : undefined) ?? fromState ?? tracked?.model ?? inputs.previous;
	if (!candidate) {
		return { ok: false, error: 'actor "current": no physical model known yet; select a regular model first, then switch to the moa model' };
	}
	if (isVirtual(candidate)) return { ok: false, error: `actor "current": ${modelKey(candidate)} is a virtual model` };
	const result = resolveModel("current", lookup, candidate);
	return typeof result === "string" ? { ok: false, error: `actor: ${result}` } : { ok: true, model: result, state: { actor: modelKey(result) } };
}

function findRef<M extends ModelLike>(ref: string, lookup: ModelLookup<M>): M | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 ? lookup.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
}

export interface RouteRequestLike<M> {
	reason: "user" | "continuation" | "retry" | "direct";
	thinkingLevel: ModelThinkingLevel;
	previous?: { model: M; thinkingLevel?: ModelThinkingLevel };
	failed?: { model: M; thinkingLevel?: ModelThinkingLevel };
	state?: RouteState;
}

export interface RouteDecision<M> {
	model: M;
	thinkingLevel: ModelThinkingLevel;
	state?: RouteState;
}

/**
 * `route()` of `moa/<preset>`. Continuations and retries stay on the model that handled the turn
 * (`previous`/`failed`) when it is the resolved actor, or when the actor cannot be resolved, which
 * keeps prompt caches and thinking signatures; otherwise the actor with the selected level (pi
 * clamps it). New state is returned only when it changes. Throws when no actor can be found.
 */
export function routeRequest<M extends ModelLike>(
	preset: Pick<PresetConfig, "actor">,
	lookup: ModelLookup<M>,
	request: RouteRequestLike<M>,
	tracked: Tracked<M> | undefined,
): RouteDecision<M> {
	const resolved = resolveActor(preset, lookup, { tracked, state: validState(request.state), previous: request.previous?.model });
	const sticky = request.reason === "retry" ? request.failed : request.reason === "continuation" ? request.previous : undefined;
	const state = resolved.ok && resolved.state && resolved.state.actor !== request.state?.actor ? resolved.state : undefined;
	if (sticky && !isVirtual(sticky.model) && (!resolved.ok || sameModel(sticky.model, resolved.model))) {
		return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel, ...(state && { state }) };
	}
	if (!resolved.ok) throw new Error(`MoA: ${resolved.error}`);
	return { model: resolved.model, thinkingLevel: request.thinkingLevel, ...(state && { state }) };
}

export function validState(value: unknown): RouteState | undefined {
	return typeof value === "object" && value !== null && typeof (value as RouteState).actor === "string" ? { actor: (value as RouteState).actor } : undefined;
}

/** The route state pi stored on the branch for `moa/<preset>` (what `request.state` will be). */
export function branchRouteState(branch: readonly EntryLike[], preset: string): RouteState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as { provider?: unknown; modelId?: unknown; state?: unknown } | undefined;
		if (data?.provider === VIRTUAL_PROVIDER && data.modelId === preset) return validState(data.state);
	}
	return undefined;
}

/** Physical model of the latest successful response, as pi computes `request.previous`. */
export function latestResponseModel<M extends ModelLike>(messages: readonly AgentMessage[], lookup: ModelLookup<M>): M | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const model = lookup.find(message.provider, message.model);
		return model && !isVirtual(model) ? model : undefined;
	}
	return undefined;
}
