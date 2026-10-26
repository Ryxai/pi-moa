import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel, type ThinkingBudgets } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { branchSpend, budgetAction, BudgetTracker, formatUsd, spendText, type BudgetAction, type Spend } from "./budget.ts";
import { adviceText, cacheForTurn, decideRound, dropAdvice, storeRound, type TurnCache } from "./advice-cache.ts";
import { moveCacheMarker } from "./cache.ts";
import { completeMoaArgs, parseMoaArgs } from "./commands.ts";
import { CONSULT_DESCRIPTION, CONSULT_TOOL, ConsultCounter, consultParameters, consultWanted, executeConsult, syncConsultTool } from "./consult.ts";
import { CONFIG_FILE, loadConfig, writeDefaultConfig, type LoadedConfig } from "./config-io.ts";
import { resolvePreset } from "./config-resolve.ts";
import { formatIssues, getPreset, issuesFor, type MoaConfig, type PresetConfig } from "./config.ts";
import { createDebugLog, debugLogPath } from "./debug.ts";
import { progressText, renderConsultResult, renderEntry, consultCallText, reviewMessageText, statusLine, type AdviceDisplay } from "./render.ts";
import { endsTurn, REVIEW_MESSAGE, REVIEW_PREAMBLE, REVIEW_REQUEST, shouldContinue } from "./review.ts";
import { frameAdvice } from "./framing.ts";
import { projectInstructions, type PromptOptionsLike } from "./roles.ts";
import { appendAdvice, RECORD_ENTRY, runRound, type RoundDeps, type RoundInput } from "./round.ts";
import { OFF, reconstructState, STATE_ENTRY, type MoaState } from "./state.ts";
import { ADVICE_DISPLAY, THINKING_LEVELS, type ThinkingLevel } from "./schema.ts";
import { matchOneShot, type OneShot } from "./oneshot.ts";
import { analyzeTurn } from "./triggers.ts";
import type { AgentMessage, RequestProjection } from "./view.ts";
import {
	branchRouteState,
	isVirtual,
	latestResponseModel,
	modelKey,
	planVirtualModels,
	presetOfModel,
	resolveActor,
	routeRequest,
	trackSelection,
	trackSession,
	VIRTUAL_PROVIDER,
	type RouteState,
	type Tracked,
	type VirtualPlan,
} from "./virtual.ts";

/** How many recent advice texts the cache-marker hook recognises. */
const TRACKED_ADVICE = 3;

type Model = NonNullable<ExtensionContext["model"]>;

/** How MoA is active for a request: a selected `moa/<preset>` model, a one-shot turn, or `/moa on`. */
type Source = "model" | "oneshot" | "session";

interface Active {
	preset: string;
	source: Source;
}

export default async function moa(pi: ExtensionAPI): Promise<void> {
	const globalConfigPath = join(getAgentDir(), CONFIG_FILE);
	const debug = createDebugLog(debugLogPath(process.env.PI_MOA_DEBUG, getAgentDir()));
	let loaded: LoadedConfig | undefined;
	let state: MoaState = OFF;
	/** What the branch says; can differ from `state` when a restore is forced off without persisting. */
	let persisted: MoaState = OFF;
	let contextCalls = 0;
	/**
	 * The last few advice texts injected into actor requests, newest last. `before_provider_request`
	 * has no request id, so payloads are matched by exact advice text, which only a replay of one of
	 * our requests can contain (advice is never persisted). Older entries are kept because pi's
	 * cache warmer replays an earlier request (with its advice) while later rounds run or after
	 * rounds that produced no advice or were aborted.
	 */
	let injected: string[] = [];
	/** Advice for the current turn, reused on steps where no trigger fires and on retries. */
	let turnCache: TurnCache | undefined;
	/**
	 * The current run's prompt options from `before_agent_start` (the object pi then builds the
	 * run's system prompt from, so mutations by later handlers are seen); source of the project
	 * context files for text views.
	 */
	let promptOptions: PromptOptionsLike | undefined;
	/** The latest actor request's messages before our advice: what a `consult` call's advisors see. */
	let lastRequest: readonly AgentMessage[] | undefined;
	let consults = new ConsultCounter();
	const budget = new BudgetTracker();
	/** The preset `turnCache` belongs to; switching presets (e.g. between `moa/*` models) starts over. */
	let cachePreset: string | undefined;
	/** The last physical model the user selected; `actor: "current"` of `moa/<preset>` routes to it. */
	let tracked: Tracked<Model> | undefined;
	/** `moa/<preset>` models this instance registered, with a signature of their definition. */
	const registered = new Map<string, string>();
	/** The latest `route()` decision per preset: rounds use its thinking level for the actor. */
	const lastRoutes = new Map<string, { actor: string; thinkingLevel: ModelThinkingLevel }>();
	/** A manual `/compact` is running; pi refuses new prompts until it ends. */
	let compacting = false;
	/** Global config read at load, so `moa/*` models exist before pi restores a session's selection. */
	let bootConfig: LoadedConfig | undefined;
	let oneShot: OneShot | undefined;
	/** Turn key of the latest request; a one-shot never binds to the turn current when it was sent. */
	let lastTurnKey: string | undefined;
	/** Turn key of the last `before_done` review, which runs at most once per turn. */
	let reviewedTurn: string | undefined;
	/** The preset a one-shot turn bound to, for the turn's `before_done` review (the hook's own match has passed by then). */
	let oneShotTurn: { turn: string; preset: string } | undefined;

	async function reload(ctx: ExtensionContext): Promise<LoadedConfig> {
		loaded = await loadConfig({
			global: globalConfigPath,
			project: join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE),
			projectTrusted: ctx.isProjectTrusted(),
		});
		return loaded;
	}

	/** Errors that prevent using `presetName`, from config issues and model resolution against the actor. */
	function activationErrors(config: LoadedConfig, presetName: string, ctx: ExtensionContext, model = ctx.model): string[] {
		const preset = getPreset(config.config, presetName);
		if (!preset) {
			const known = Object.keys(config.config.presets).join(", ");
			return [`unknown preset "${presetName}" (available: ${known})`];
		}
		const issues = issuesFor(config.issues, presetName);
		if (issues.length > 0) return formatIssues(issues).split("\n");
		const actor = currentActor(ctx, model);
		if (actor.error) return [actor.error];
		const resolved = resolvePreset(preset, ctx.modelRegistry, actor.model);
		return resolved.ok ? [] : resolved.errors;
	}

	/**
	 * Errors that prevent the session's `/moa on` preset. While a `moa/*` model is selected the
	 * session preset is idle, so only its config is checked; models are checked when it applies.
	 */
	function sessionErrors(config: LoadedConfig, presetName: string, ctx: ExtensionContext): string[] {
		if (presetOfModel(ctx.model) === undefined || !getPreset(config.config, presetName)) return activationErrors(config, presetName, ctx);
		return formatIssues(issuesFor(config.issues, presetName)).split("\n").filter(Boolean);
	}

	/**
	 * The physical model acting for `model`: itself, or for `moa/<preset>` what its `route()`
	 * resolves to (same function and inputs: tracked selection, the branch's route state, which pi
	 * writes before the request hook runs, and the latest response's model).
	 */
	function currentActor(ctx: ExtensionContext, model = ctx.model, messages?: readonly AgentMessage[]): { model?: Model; error?: string } {
		const name = presetOfModel(model);
		if (name === undefined) return { model };
		const config = loaded ?? bootConfig;
		const preset = config && getPreset(config.config, name);
		if (!preset) return { error: `preset "${name}" is not configured` };
		const previous = latestResponseModel(messages ?? branchMessages(ctx), ctx.modelRegistry);
		const result = resolveActor(preset, ctx.modelRegistry, { tracked, state: branchRouteState(branchOf(ctx), name), previous });
		if (result.ok) return { model: result.model };
		// As route() keeps continuations on the model that answered when the actor cannot be resolved.
		return previous ? { model: previous } : { error: result.error };
	}

	/**
	 * Where MoA is active for `model`: a selected `moa/<preset>` wins (it names the preset and the
	 * actor), then a one-shot turn, then the session's `/moa on` state.
	 */
	function activeFor(model: ExtensionContext["model"], oneShotPreset?: string): Active | undefined {
		const name = presetOfModel(model);
		if (name !== undefined) return { preset: name, source: "model" };
		if (oneShotPreset) return { preset: oneShotPreset, source: "oneshot" };
		return state.enabled && state.preset ? { preset: state.preset, source: "session" } : undefined;
	}

	/** Registers one `moa/<preset>` per valid preset (when `virtualModels`) and removes the rest. */
	function syncVirtualModels(config: LoadedConfig, ctx?: ExtensionContext): VirtualPlan {
		const plan = planVirtualModels(config.config, config.issues);
		// pi's /reload keeps the model runtime, so models an earlier instance registered are still
		// listed (with routers bound to its stale context) although this instance never saw them.
		const listed = new Set(registered.keys());
		try {
			for (const model of ctx?.modelRegistry.getAll() ?? []) {
				if (model.provider === VIRTUAL_PROVIDER && isVirtual(model)) listed.add(model.id);
			}
		} catch (error) {
			debug(`listing models failed: ${errorText(error)}`);
		}
		for (const name of listed) {
			if (plan.valid.includes(name)) continue;
			registered.delete(name);
			try {
				pi.unregisterVirtualModel(VIRTUAL_PROVIDER, name);
			} catch (error) {
				debug(`unregister moa/${name} failed: ${errorText(error)}`);
			}
		}
		for (const name of plan.valid) {
			const preset = getPreset(config.config, name)!;
			const actor = preset.actor !== "current" && ctx ? ctx.modelRegistry.find(...splitRef(preset.actor)) : undefined;
			const listing = {
				provider: VIRTUAL_PROVIDER,
				id: name,
				name: `MoA: ${name}`,
				thinkingLevels: actor ? getSupportedThinkingLevels(actor) : ([...THINKING_LEVELS] as ModelThinkingLevel[]),
				...(actor && { contextWindow: actor.contextWindow, maxTokens: actor.maxTokens }),
			};
			const signature = JSON.stringify(listing);
			if (registered.get(name) === signature) continue;
			try {
				pi.registerVirtualModel<RouteState>({
					...listing,
					route: (request, routeCtx) => {
						const current = loaded ?? bootConfig;
						const routed = current && getPreset(current.config, name);
						if (!routed) throw new Error(`MoA: preset "${name}" is not configured`);
						const decision = routeRequest(routed, routeCtx.modelRegistry, request, tracked);
						lastRoutes.set(name, { actor: modelKey(decision.model), thinkingLevel: decision.thinkingLevel });
						return decision;
					},
				});
				registered.set(name, signature);
			} catch (error) {
				plan.valid = plan.valid.filter((n) => n !== name);
				plan.invalid.push({ name, reason: `registration failed: ${errorText(error)}` });
			}
		}
		return plan;
	}

	function reportVirtual(ctx: ExtensionContext, plan: VirtualPlan): void {
		if (plan.invalid.length === 0) return;
		const lines = plan.invalid.map((p) => `${p.name}: ${p.reason}`).join("\n");
		notify(ctx, `MoA: no moa/<preset> model for:\n${lines}`, "warning");
	}

	function setState(next: MoaState, ctx: ExtensionContext): void {
		if (next.enabled !== state.enabled || next.preset !== state.preset) turnCache = undefined;
		state = next;
		if (next.enabled !== persisted.enabled || next.preset !== persisted.preset) {
			pi.appendEntry(STATE_ENTRY, next);
			persisted = next;
		}
		updateStatus(ctx);
		syncTools(ctx.model);
	}

	function presetFor(active: Active | undefined): PresetConfig | undefined {
		return active && loaded ? getPreset(loaded.config, active.preset) : undefined;
	}

	/**
	 * Declares `consult` to the actor only while the active preset allows it (changes the actor's
	 * tool set). With `addOnly`, an unwanted active tool is left for the next run start: removing a
	 * tool drops pi's pending restored tools (e.g. MCP tools still connecting), which pi itself
	 * clears at run start (agent-session.js setActiveToolsByName, prompt).
	 */
	function syncTools(model: ExtensionContext["model"], addOnly = false): void {
		try {
			const want = consultWanted(presetFor(activeFor(model)));
			if (want || !addOnly) syncConsultTool(pi, want);
		} catch (error) {
			debug(`consult activation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		const active = activeFor(model);
		const show = active && (loaded?.config.ui.status ?? true);
		try {
			if (ctx.hasUI) ctx.ui.setStatus("moa", show ? statusLine(active.preset, budget.spend, loaded?.config.budget, active.source === "model") : undefined);
		} catch {
			// Display must never break a turn.
		}
	}

	function setWorking(ctx: ExtensionContext, message?: string): void {
		try {
			if (ctx.hasUI) ctx.ui.setWorkingMessage?.(message);
		} catch {
			// Display must never break a turn.
		}
	}

	/** How advice records are shown (`ui.advice`); `collapsed` for unknown values. */
	function adviceDisplay(): AdviceDisplay {
		const value = loaded?.config.ui?.advice;
		return value && (ADVICE_DISPLAY as readonly string[]).includes(value) ? value : "collapsed";
	}

	/** Rounds and consults in flight; the working message is restored when the last one ends. */
	let activeRuns = 0;

	/** Runs `run` with advisor progress in the working message (the latest run's k/n is shown). */
	async function withProgress<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> {
		activeRuns++;
		try {
			return await run();
		} finally {
			activeRuns = Math.max(0, activeRuns - 1);
			if (activeRuns === 0) setWorking(ctx);
		}
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// Non-interactive modes may not display notifications.
		}
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		contextCalls = 0;
		injected = [];
		turnCache = undefined;
		oneShot = undefined;
		lastTurnKey = undefined;
		reviewedTurn = undefined;
		oneShotTurn = undefined;
		compacting = false;
		tracked = trackSession(tracked, ctx.model);
		promptOptions = undefined;
		lastRequest = undefined;
		consults = new ConsultCounter();
		try {
			budget.reset(branchSpend(ctx.sessionManager.getBranch(), RECORD_ENTRY));
		} catch (error) {
			budget.reset({ usd: 0, unknown: 0 });
			debug(`budget rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const config = await reload(ctx);
		for (const note of config.notes) notify(ctx, `MoA: ${note}`, "warning");
		reportVirtual(ctx, syncVirtualModels(config, ctx));
		persisted = reconstructState(ctx.sessionManager.getBranch());
		state = persisted;
		if (state.enabled && state.preset) {
			const errors = sessionErrors(config, state.preset, ctx);
			if (errors.length > 0) {
				state = OFF;
				notify(ctx, `MoA restored as off: ${errors.join("; ")}`, "warning");
			}
		}
		updateStatus(ctx);
		syncTools(ctx.model, true);
	}

	/**
	 * Applies `budget.onExceed` once the session's advisor spend reaches `budget.sessionUsd`:
	 * `warn` runs anyway, `pause` skips advisors, `stop` turns MoA off (persisted). Notifies once per
	 * session (every time for `stop`).
	 */
	function checkBudget(ctx: ExtensionContext, source: Source): BudgetAction {
		const limits = loaded?.config.budget;
		if (!limits) return "run";
		const action = budgetAction(limits, budget.spend.usd);
		if (action === "run") return action;
		const spent = `${formatUsd(budget.spend.usd)} of ${formatUsd(limits.sessionUsd)}`;
		if (action === "stop" && source !== "session") {
			if (budget.firstNotice()) notify(ctx, `MoA: advisor budget reached (${spent}); advisors are stopped. Raise budget.sessionUsd and /moa reload to resume.`, "warning");
		} else if (action === "stop") {
			setState(OFF, ctx);
			notify(ctx, `MoA turned off: advisor budget reached (${spent}). Raise budget.sessionUsd to continue.`, "warning");
		} else if (budget.firstNotice()) {
			const effect = action === "warn" ? "advisors keep running" : "advisors are paused for this session; raise budget.sessionUsd and /moa reload to resume";
			notify(ctx, `MoA: advisor budget reached (${spent}); ${effect}.`, "warning");
		}
		return action;
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("model_select", (event, ctx) => {
		tracked = trackSelection(tracked, event);
		updateStatus(ctx, event.model);
		syncTools(event.model, event.source === "restore");
		const active = activeFor(event.model);
		if (!active || !loaded) return;
		const errors = activationErrors(loaded, active.preset, ctx, event.model);
		if (errors.length === 0) return;
		const what = active.source === "model" ? `moa/${active.preset}` : `preset "${active.preset}"`;
		notify(ctx, `MoA: ${what} cannot run advisors with this model:\n${errors.join("\n")}`, "warning");
	});

	pi.on("agent_settled", () => {
		oneShot = undefined;
	});

	pi.on("session_before_compact", (event) => {
		if (event.reason === "manual") compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});

	/** The settings pi applies to the actor's requests that native views mirror. */
	function actorSettings(): { projection: RequestProjection; thinkingBudgets?: ThinkingBudgets } {
		let settings: Partial<ReturnType<ExtensionAPI["getSettings"]>> = {};
		try {
			settings = pi.getSettings();
		} catch {
			// Settings unavailable: pi's defaults (images allowed, default budgets).
		}
		return {
			// `hiddenTools` is the run-start set; pi may change it on later steps of the run.
			projection: { forceSystemPrompt: promptOptions?.forceSystemPrompt, hiddenTools: promptOptions?.hiddenTools, blockImages: settings.images?.blockImages ?? false },
			thinkingBudgets: settings.thinkingBudgets,
		};
	}

	/**
	 * The actor's thinking level. Under `moa/<preset>` it is the level route() picked for the
	 * routed actor (clamped to it, as pi does), not the virtual model's selected level.
	 */
	function actorThinking(selected: ExtensionContext["model"], actor: Model | undefined): ThinkingLevel | undefined {
		let level: ThinkingLevel | undefined;
		try {
			level = pi.getThinkingLevel();
		} catch {
			return undefined;
		}
		const name = presetOfModel(selected);
		if (name === undefined || !actor) return level;
		const route = lastRoutes.get(name);
		const routed = route && route.actor === modelKey(actor) ? route.thinkingLevel : level;
		return routed && clampThinkingLevel(actor, routed);
	}

	function roundInput(
		ctx: ExtensionContext,
		config: LoadedConfig,
		presetName: string,
		actor: Model | undefined,
		messages: readonly AgentMessage[],
		signal: AbortSignal | undefined,
		round: Pick<RoundInput<Model>, "reason" | "turn" | "step" | "question" | "effort" | "request">,
	): RoundInput<Model> {
		return {
			messages,
			config: routedConfig(config.config, presetName, ctx.model),
			presetName,
			models: ctx.modelRegistry,
			actor,
			signal,
			sessionId: sessionIdOf(ctx),
			projectInstructions: projectInstructions(promptOptions),
			...actorSettings(),
			actorThinking: actorThinking(ctx.model, actor),
			...round,
		};
	}

	/** Round dependencies; `record` saves the round as a `moa` entry (not for consult, see consult.ts). */
	function roundDeps(ctx: ExtensionContext, config: LoadedConfig, record: boolean): RoundDeps<Model> {
		return {
			complete: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options).result(),
			...(record && { appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data) }),
			readPromptFile: (path) => (Object.hasOwn(config.promptFiles, path) ? config.promptFiles[path] : undefined),
			onAdvisorDone: (done, total) => setWorking(ctx, progressText(done, total)),
			debug,
		};
	}

	pi.on("before_agent_start", (event, ctx) => {
		promptOptions = event.systemPromptOptions;
		syncTools(ctx.model);
	});

	pi.on("context_with_system", async (event, ctx) => {
		contextCalls++;
		// Copied so later handlers mutating the request in place cannot change it.
		lastRequest = event.messages.map((message) => ({ ...message }));
		const last = event.messages.at(-1);
		let analysis: ReturnType<typeof analyzeTurn>;
		try {
			analysis = analyzeTurn(event.messages);
		} catch (error) {
			debug(`turn analysis failed: ${errorText(error)}`);
			return undefined;
		}
		lastTurnKey = analysis.turnKey;
		const once = matchOneShot(oneShot, analysis);
		oneShot = once.pending;
		if (once.preset) oneShotTurn = { turn: analysis.turnKey, preset: once.preset };
		const active = activeFor(ctx.model, once.preset);
		debug(
			`context_with_system #${contextCalls} enabled=${state.enabled} preset=${active?.preset ?? "-"} via=${active?.source ?? "-"} messages=${event.messages.length} last=${last?.role}`,
		);
		if (!active || !loaded) return undefined;
		const config = loaded;
		const presetName = active.preset;
		const preset = getPreset(config.config, presetName);
		if (!preset) return undefined;
		try {
			if (cachePreset !== presetName) {
				turnCache = undefined;
				cachePreset = presetName;
			}
			const cache = cacheForTurn(turnCache, analysis);
			turnCache = cache;
			const decision = decideRound(cache, preset, analysis);
			debug(
				`turn step=${analysis.step} errors=${analysis.consecutiveErrors} repeats=${analysis.repeatedCalls} run=${decision.reason ?? "no"}`,
			);
			const action = decision.reason ? checkBudget(ctx, active.source) : "run";
			if (action === "stop") return undefined;
			// Paused: no fresh round, but advice already paid for this turn is still reused.
			if (decision.reason && action !== "pause") {
				const actor = currentActor(ctx, ctx.model, event.messages);
				if (actor.error) debug(`actor unresolved: ${actor.error}`);
				const input = roundInput(ctx, config, presetName, actor.model, event.messages, ctx.signal, {
					reason: decision.reason,
					turn: analysis.turnKey,
					step: analysis.step,
				});
				const round = await withProgress(ctx, () => runRound(input, roundDeps(ctx, config, true))).catch((error: unknown) => {
					debug(`round failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
					return undefined;
				});
				// Interrupted rounds are recorded with their partial usage and count too.
				if (round) {
					budget.add(round.record);
					updateStatus(ctx);
				}
				// Without a round (preset unusable, failure) the turn's cached advice still applies.
				if (round?.interrupted) return undefined;
				if (round) storeRound(cache, analysis.step, round, decision);
			}
			const text = adviceText(cache, analysis);
			if (!text) return undefined;
			if (injected.at(-1) !== text) injected = [...injected.filter((t) => t !== text), text].slice(-TRACKED_ADVICE);
			return { messages: appendAdvice(event.messages, text, Date.now()) };
		} catch (error) {
			debug(`advice failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			return undefined;
		}
	});

	/**
	 * `before_done`: when a reply ends the turn, advisors review the work. On a `revise` verdict the
	 * framed advice is appended as a custom message (the one other case, besides `consult`, where
	 * advice stays in context) and pi runs one more model request. At most once per turn.
	 */
	pi.on("turn_end", async (event, ctx) => {
		if (event.outcome !== "completed" || !endsTurn(event.message) || !loaded) return undefined;
		let analysis: ReturnType<typeof analyzeTurn>;
		try {
			analysis = analyzeTurn(event.context.contextMessages);
		} catch (error) {
			debug(`review analysis failed: ${errorText(error)}`);
			return undefined;
		}
		const oncePreset = oneShotTurn?.turn === analysis.turnKey ? oneShotTurn.preset : undefined;
		const active = activeFor(ctx.model, oncePreset);
		const preset = presetFor(active);
		if (!active || !preset || !preset.triggers.includes("before_done")) return undefined;
		if (analysis.turnKey === "" || reviewedTurn === analysis.turnKey) return undefined;
		reviewedTurn = analysis.turnKey;
		const config = loaded;
		try {
			const action = checkBudget(ctx, active.source);
			if (action === "pause" || action === "stop") return undefined;
			const messages = event.context.contextMessages;
			const actor = currentActor(ctx, ctx.model, messages);
			if (actor.error) debug(`actor unresolved: ${actor.error}`);
			const input = roundInput(ctx, config, active.preset, actor.model, messages, ctx.signal, {
				reason: "before_done",
				request: REVIEW_REQUEST,
				turn: analysis.turnKey,
				step: analysis.step,
			});
			const round = await withProgress(ctx, () => runRound(input, roundDeps(ctx, config, true)));
			if (!round) return undefined;
			budget.add(round.record);
			updateStatus(ctx);
			if (round.interrupted || !shouldContinue(round.results, round.synthesis)) return undefined;
			const advice = frameAdvice(round.results, undefined, round.synthesis);
			if (!advice) return undefined;
			// The review carries the turn's advice now; cached advice must not be injected on top.
			if (turnCache?.turnKey === analysis.turnKey) dropAdvice(turnCache);
			debug(`before_done review at step ${analysis.step}: continuing`);
			return { entries: [{ type: "custom_message", customType: REVIEW_MESSAGE, content: `${REVIEW_PREAMBLE}\n\n${advice}`, display: true, details: round.record }], continue: true };
		} catch (error) {
			debug(`review failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			return undefined;
		}
	});

	pi.registerMessageRenderer(REVIEW_MESSAGE, (_message, _options, theme) => new Text(reviewMessageText(theme), 0, 0));

	// Keep the actor's conversation cache marker off the advice block (see cache.ts). Fires for
	// the agent's own requests, their retries and pi's cache-warmer replays; not for advisor calls,
	// which get the same fix through their own `onPayload`.
	pi.on("before_provider_request", (event) => {
		if (injected.length === 0) return undefined;
		try {
			const next = moveCacheMarker(event.payload, injected);
			if (next === event.payload) return undefined;
			debug("cache marker moved off the advice block");
			return next;
		} catch {
			return undefined;
		}
	});

	// Registered inactive; `syncTools` declares it while MoA is on with a preset that allows it.
	pi.registerTool({
		name: CONSULT_TOOL,
		label: "Consult advisors",
		description: CONSULT_DESCRIPTION,
		parameters: consultParameters,
		defaultActive: false,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const active = activeFor(ctx.model);
			const preset = presetFor(active);
			const config = loaded;
			const presetName = active?.preset;
			return executeConsult(
				params,
				{
					settings: preset?.consult,
					snapshot: lastRequest,
					caller: callingResponse(ctx, toolCallId),
					counter: consults,
					gate: () => {
						const action = checkBudget(ctx, active?.source ?? "session");
						if (action === "pause") return "advisor budget reached for this session; consult is paused. Continue without it.";
						if (action === "stop") {
							const effect = active?.source === "model" ? "advisors are stopped" : "MoA has been turned off";
							return `advisor budget reached for this session; ${effect}. Continue without consult.`;
						}
						return undefined;
					},
					run: async ({ messages, question, effort, turn, step }) => {
						if (!config || !presetName) return undefined;
						const input = roundInput(ctx, config, presetName, currentActor(ctx, ctx.model, messages).model, messages, signal ?? ctx.signal, {
							reason: "consult",
							question,
							effort,
							turn,
							step,
						});
						const round = await withProgress(ctx, () => runRound(input, roundDeps(ctx, config, false)));
						if (round) {
							budget.add(round.record);
							updateStatus(ctx);
						}
						return round;
					},
				},
				onUpdate,
			);
		},
		renderCall: (args, theme) => new Text(consultCallText(args.question, theme), 0, 0),
		renderResult: (result, options, theme, context) => renderConsultResult(result, { ...options, isError: context?.isError }, adviceDisplay(), theme),
	});

	// Interactive mode only; HTML export skips custom entries.
	pi.registerEntryRenderer(RECORD_ENTRY, (entry, options, theme) => renderEntry(entry.data, options.expanded, adviceDisplay(), theme));

	function overNote(config: LoadedConfig): string {
		const over = budgetAction(config.config.budget, budget.spend.usd) !== "run";
		return over ? `; note: ${spendText(budget.spend, config.config.budget)} — the limit is already reached` : "";
	}

	function modelNote(ctx: ExtensionContext): string {
		const name = presetOfModel(ctx.model);
		return name === undefined ? "" : `; the selected model moa/${name} takes precedence while selected`;
	}

	/**
	 * `/moa <prompt>`: sends `text` as a user message (a follow-up when the agent is busy, so the
	 * current work is not interrupted) with MoA for that turn only. Already active (selected
	 * `moa/*` model or `/moa on`): a normal message. Otherwise the default preset, validated as
	 * `/moa on` does; nothing is persisted and the model is unchanged.
	 */
	function runOneShot(text: string, config: LoadedConfig, ctx: ExtensionContext): void {
		// Print and JSON modes exit once the command returns, before a run it starts could finish.
		if (ctx.mode === "print" || ctx.mode === "json") {
			notify(ctx, "MoA: /moa <prompt> works in interactive and RPC modes only; use /moa on", "error");
			return;
		}
		if (compacting) {
			notify(ctx, "MoA: compaction is running; send /moa <prompt> when it finishes", "error");
			return;
		}
		const active = activeFor(ctx.model);
		const presetName = active?.preset ?? config.config.defaultPreset;
		if (!active) {
			const errors = activationErrors(config, presetName, ctx);
			if (errors.length > 0) {
				notify(ctx, `MoA: cannot run /moa <prompt> with preset "${presetName}":\n${errors.join("\n")}`, "error");
				return;
			}
			oneShot = { preset: presetName, text, ...(lastTurnKey !== undefined && { exclude: lastTurnKey }) };
		}
		const busy = !ctx.isIdle();
		// Fire and forget: pi reports send failures itself, and the one-shot is dropped when the agent settles.
		pi.sendUserMessage(text, busy ? { deliverAs: "followUp" } : undefined);
		const scope = active ? `already on (preset ${presetName})` : `for this turn (preset ${presetName})`;
		notify(ctx, `MoA ${scope}: prompt ${busy ? "queued as a follow-up" : "sent"}${overNote(config)}`);
	}

	pi.registerCommand("moa", {
		description: "Mixture of Models: /moa [on [preset] | off | reload | init | <prompt>]",
		getArgumentCompletions: (prefix) => completeMoaArgs(prefix, Object.keys(loaded?.config.presets ?? {})),
		handler: async (args, ctx) => {
			const command = parseMoaArgs(args);
			const config = loaded ?? (await reload(ctx));
			switch (command.kind) {
				case "status": {
					const active = activeFor(ctx.model);
					const actor = active?.source === "model" ? currentActor(ctx) : undefined;
					const actorText = actor ? (actor.model ? `${actor.model.provider}/${actor.model.id}` : `unresolved (${actor.error})`) : undefined;
					notify(ctx, statusText(config, active, state, budget.spend, actorText));
					return;
				}
				case "on": {
					const presetName = command.preset ?? config.config.defaultPreset;
					const errors = sessionErrors(config, presetName, ctx);
					if (errors.length > 0) {
						notify(ctx, `MoA: cannot use preset "${presetName}":\n${errors.join("\n")}`, "error");
						return;
					}
					setState({ enabled: true, preset: presetName }, ctx);
					notify(ctx, `MoA on (preset ${presetName})${overNote(config)}${modelNote(ctx)}`);
					return;
				}
				case "off":
					setState(OFF, ctx);
					notify(ctx, `MoA off${modelNote(ctx)}`);
					return;
				case "reload": {
					const fresh = await reload(ctx);
					budget.reset(budget.spend);
					const problems = fresh.issues.length > 0 ? `\n${formatIssues(fresh.issues)}` : "";
					notify(ctx, `MoA config reloaded (${fresh.issues.length} issue(s))${problems}`, problems ? "warning" : "info");
					reportVirtual(ctx, syncVirtualModels(fresh, ctx));
					const selected = presetOfModel(ctx.model);
					if (selected !== undefined && !registered.has(selected)) {
						notify(ctx, `MoA: the selected model moa/${selected} is no longer available; select another model`, "warning");
					}
					const active = state.enabled ? state.preset : undefined;
					const errors = active ? sessionErrors(fresh, active, ctx) : [];
					if (errors.length > 0) {
						setState(OFF, ctx);
						notify(ctx, `MoA turned off: preset "${active}" is no longer usable:\n${errors.join("\n")}`, "warning");
					} else {
						updateStatus(ctx);
						syncTools(ctx.model);
					}
					return;
				}
				case "init": {
					const written = await writeDefaultConfig(globalConfigPath);
					notify(ctx, written ? `MoA: wrote ${globalConfigPath}` : `MoA: ${globalConfigPath} already exists; left unchanged`);
					return;
				}
				case "prompt":
					runOneShot(command.text, config, ctx);
					return;
			}
		},
	});

	// pi restores a session's model selection before `session_start`, so `moa/*` models must exist
	// at load. Only the global config is known here (project trust needs a session); presets from a
	// project config are registered at session start.
	try {
		bootConfig = await loadConfig({ global: globalConfigPath, project: "", projectTrusted: false });
		for (const { name, reason } of syncVirtualModels(bootConfig).invalid) debug(`no moa/${name}: ${reason}`);
	} catch (error) {
		debug(`virtual model registration at load failed: ${errorText(error)}`);
	}
}

/**
 * The actor's response that made tool call `toolCallId`. pi persists it on `message_end`, which it
 * awaits before running the response's tools.
 */
function callingResponse(ctx: ExtensionContext, toolCallId: string): AgentMessage | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)) return entry.message;
		}
	} catch {
		// No session access: advisors see the request only.
	}
	return undefined;
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function statusText(config: LoadedConfig, active: Active | undefined, state: MoaState, spend: Spend, actor?: string): string {
	const lines: string[] = [];
	const preset = active ? getPreset(config.config, active.preset) : undefined;
	const head = active?.source === "model" ? `MoA on via model moa/${active.preset}` : "MoA on";
	if (active && !preset) {
		lines.push(`${head} · preset ${active.preset} (unavailable in current config)`);
	} else if (active && preset) {
		const triggers = preset.triggers.map((t) => (typeof t === "string" ? t : `every_n:${t.every_n}`)).join(", ");
		const advisors = preset.advisors.map((a) => `${a.model} (${a.role ?? "advisor"}${a.effort ? `, effort ${a.effort}` : ""})`).join(", ");
		lines.push(`${head} · preset ${active.preset}`, `triggers: ${triggers}`, `advisors: ${advisors}`, `effort: ${preset.effort} (max ${preset.maxEffort})`);
		if (preset.synthesis) lines.push(`synthesis: ${preset.synthesis.model}`);
		if (actor) lines.push(`actor: ${actor}`);
		if (active.source === "model" && state.enabled && state.preset) lines.push(`/moa on (preset ${state.preset}) resumes when another model is selected`);
	} else {
		lines.push(`MoA off · default preset ${config.config.defaultPreset}`);
	}
	lines.push(spendText(spend, config.config.budget));
	lines.push(`config: ${config.sources.length > 0 ? config.sources.join(", ") : "built-in defaults"}`);
	if (config.issues.length > 0) lines.push(`config issues:\n${formatIssues(config.issues)}`);
	return lines.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function branchOf(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return [];
	}
}

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
	return branchOf(ctx).flatMap((entry) => (entry.type === "message" ? [entry.message as AgentMessage] : []));
}

function splitRef(ref: string): [string, string] {
	const slash = ref.indexOf("/");
	return [ref.slice(0, slash), ref.slice(slash + 1)];
}

/**
 * Under `moa/<preset>` the actor passed to a round is the routed model (`currentActor`, which
 * already resolved the preset's `actor` or fell back as route() does), so the preset's own
 * `actor` must not be resolved again.
 */
function routedConfig(config: MoaConfig, presetName: string, selected: ExtensionContext["model"]): MoaConfig {
	const preset = presetOfModel(selected) === presetName ? getPreset(config, presetName) : undefined;
	if (!preset || preset.actor === "current") return config;
	return { ...config, presets: { ...config.presets, [presetName]: { ...preset, actor: "current" } } };
}
