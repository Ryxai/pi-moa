import { join } from "node:path";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { branchSpend, budgetAction, BudgetTracker, formatUsd, spendText, type BudgetAction, type Spend } from "./budget.ts";
import { adviceText, cacheForTurn, decideRound, storeRound, type TurnCache } from "./advice-cache.ts";
import { moveCacheMarker } from "./cache.ts";
import { completeMoaArgs, parseMoaArgs } from "./commands.ts";
import { CONSULT_DESCRIPTION, CONSULT_TOOL, ConsultCounter, consultParameters, consultWanted, executeConsult, syncConsultTool } from "./consult.ts";
import { CONFIG_FILE, loadConfig, writeDefaultConfig, type LoadedConfig } from "./config-io.ts";
import { resolvePreset } from "./config-resolve.ts";
import { formatIssues, getPreset, issuesFor, type PresetConfig } from "./config.ts";
import { createDebugLog, debugLogPath } from "./debug.ts";
import { progressText, renderConsultResult, renderEntry, consultCallText, statusLine, type AdviceDisplay } from "./render.ts";
import { projectInstructions, type PromptOptionsLike } from "./roles.ts";
import { appendAdvice, RECORD_ENTRY, runRound, type RoundDeps, type RoundInput } from "./round.ts";
import { OFF, reconstructState, STATE_ENTRY, type MoaState } from "./state.ts";
import { ADVICE_DISPLAY, type ThinkingLevel } from "./schema.ts";
import { analyzeTurn } from "./triggers.ts";
import type { AgentMessage, RequestProjection } from "./view.ts";

/** How many recent advice texts the cache-marker hook recognises. */
const TRACKED_ADVICE = 3;

export default function moa(pi: ExtensionAPI): void {
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

	async function reload(ctx: ExtensionContext): Promise<LoadedConfig> {
		loaded = await loadConfig({
			global: globalConfigPath,
			project: join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE),
			projectTrusted: ctx.isProjectTrusted(),
		});
		return loaded;
	}

	/** Errors that prevent turning `presetName` on, from config issues and model resolution. */
	function activationErrors(config: LoadedConfig, presetName: string, ctx: ExtensionContext): string[] {
		const preset = getPreset(config.config, presetName);
		if (!preset) {
			const known = Object.keys(config.config.presets).join(", ");
			return [`unknown preset "${presetName}" (available: ${known})`];
		}
		const issues = issuesFor(config.issues, presetName);
		if (issues.length > 0) return formatIssues(issues).split("\n");
		const resolved = resolvePreset(preset, ctx.modelRegistry, ctx.model);
		return resolved.ok ? [] : resolved.errors;
	}

	function setState(next: MoaState, ctx: ExtensionContext): void {
		if (next.enabled !== state.enabled || next.preset !== state.preset) turnCache = undefined;
		state = next;
		if (next.enabled !== persisted.enabled || next.preset !== persisted.preset) {
			pi.appendEntry(STATE_ENTRY, next);
			persisted = next;
		}
		updateStatus(ctx);
		syncTools();
	}

	function activePreset(): PresetConfig | undefined {
		return state.enabled && state.preset && loaded ? getPreset(loaded.config, state.preset) : undefined;
	}

	/**
	 * Declares `consult` to the actor only while the active preset allows it (changes the actor's
	 * tool set). With `addOnly`, an unwanted active tool is left for the next run start: removing a
	 * tool drops pi's pending restored tools (e.g. MCP tools still connecting), which pi itself
	 * clears at run start (agent-session.js setActiveToolsByName, prompt).
	 */
	function syncTools(addOnly = false): void {
		try {
			const want = consultWanted(activePreset());
			if (want || !addOnly) syncConsultTool(pi, want);
		} catch (error) {
			debug(`consult activation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		const show = state.enabled && (loaded?.config.ui.status ?? true);
		try {
			if (ctx.hasUI) ctx.ui.setStatus("moa", show && state.preset ? statusLine(state.preset, budget.spend, loaded?.config.budget) : undefined);
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
		persisted = reconstructState(ctx.sessionManager.getBranch());
		state = persisted;
		if (state.enabled && state.preset) {
			const errors = activationErrors(config, state.preset, ctx);
			if (errors.length > 0) {
				state = OFF;
				notify(ctx, `MoA restored as off: ${errors.join("; ")}`, "warning");
			}
		}
		updateStatus(ctx);
		syncTools(true);
	}

	/**
	 * Applies `budget.onExceed` once the session's advisor spend reaches `budget.sessionUsd`:
	 * `warn` runs anyway, `pause` skips advisors, `stop` turns MoA off (persisted). Notifies once per
	 * session (every time for `stop`).
	 */
	function checkBudget(ctx: ExtensionContext): BudgetAction {
		const limits = loaded?.config.budget;
		if (!limits) return "run";
		const action = budgetAction(limits, budget.spend.usd);
		if (action === "run") return action;
		const spent = `${formatUsd(budget.spend.usd)} of ${formatUsd(limits.sessionUsd)}`;
		if (action === "stop") {
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

	function actorThinking(): ThinkingLevel | undefined {
		try {
			return pi.getThinkingLevel();
		} catch {
			return undefined;
		}
	}

	function roundInput(
		ctx: ExtensionContext,
		config: LoadedConfig,
		presetName: string,
		messages: readonly AgentMessage[],
		signal: AbortSignal | undefined,
		round: Pick<RoundInput<NonNullable<ExtensionContext["model"]>>, "reason" | "turn" | "step" | "question">,
	): RoundInput<NonNullable<ExtensionContext["model"]>> {
		return {
			messages,
			config: config.config,
			presetName,
			models: ctx.modelRegistry,
			actor: ctx.model,
			signal,
			sessionId: sessionIdOf(ctx),
			projectInstructions: projectInstructions(promptOptions),
			...actorSettings(),
			actorThinking: actorThinking(),
			...round,
		};
	}

	/** Round dependencies; `record` saves the round as a `moa` entry (not for consult, see consult.ts). */
	function roundDeps(ctx: ExtensionContext, config: LoadedConfig, record: boolean): RoundDeps<NonNullable<ExtensionContext["model"]>> {
		return {
			complete: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options).result(),
			...(record && { appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data) }),
			readPromptFile: (path) => (Object.hasOwn(config.promptFiles, path) ? config.promptFiles[path] : undefined),
			onAdvisorDone: (done, total) => setWorking(ctx, progressText(done, total)),
			debug,
		};
	}

	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
		syncTools();
	});

	pi.on("context_with_system", async (event, ctx) => {
		contextCalls++;
		// Copied so later handlers mutating the request in place cannot change it.
		lastRequest = event.messages.map((message) => ({ ...message }));
		const last = event.messages.at(-1);
		debug(
			`context_with_system #${contextCalls} enabled=${state.enabled} preset=${state.preset ?? "-"} messages=${event.messages.length} last=${last?.role}`,
		);
		if (!state.enabled || !state.preset || !loaded) return undefined;
		const config = loaded;
		const preset = getPreset(config.config, state.preset);
		if (!preset) return undefined;
		try {
			const analysis = analyzeTurn(event.messages);
			const cache = cacheForTurn(turnCache, analysis);
			turnCache = cache;
			const decision = decideRound(cache, preset, analysis);
			debug(
				`turn step=${analysis.step} errors=${analysis.consecutiveErrors} repeats=${analysis.repeatedCalls} run=${decision.reason ?? "no"}`,
			);
			const action = decision.reason ? checkBudget(ctx) : "run";
			if (action === "stop") return undefined;
			// Paused: no fresh round, but advice already paid for this turn is still reused.
			if (decision.reason && action !== "pause") {
				const input = roundInput(ctx, config, state.preset, event.messages, ctx.signal, {
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
				if (round) storeRound(cache, analysis.step, round.results, decision);
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
			const preset = activePreset();
			const config = loaded;
			const presetName = state.preset;
			return executeConsult(
				params,
				{
					settings: preset?.consult,
					snapshot: lastRequest,
					caller: callingResponse(ctx, toolCallId),
					counter: consults,
					gate: () => {
						const action = checkBudget(ctx);
						if (action === "pause") return "advisor budget reached for this session; consult is paused. Continue without it.";
						if (action === "stop") return "advisor budget reached for this session; MoA has been turned off. Continue without consult.";
						return undefined;
					},
					run: async ({ messages, question, turn, step }) => {
						if (!config || !presetName) return undefined;
						const input = roundInput(ctx, config, presetName, messages, signal ?? ctx.signal, { reason: "consult", question, turn, step });
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

	pi.registerCommand("moa", {
		description: "Mixture of Models: /moa [on [preset] | off | reload | init]",
		getArgumentCompletions: (prefix) => completeMoaArgs(prefix, Object.keys(loaded?.config.presets ?? {})),
		handler: async (args, ctx) => {
			const command = parseMoaArgs(args);
			const config = loaded ?? (await reload(ctx));
			switch (command.kind) {
				case "status":
					notify(ctx, statusText(config, state, budget.spend));
					return;
				case "on": {
					const presetName = command.preset ?? config.config.defaultPreset;
					const errors = activationErrors(config, presetName, ctx);
					if (errors.length > 0) {
						notify(ctx, `MoA: cannot use preset "${presetName}":\n${errors.join("\n")}`, "error");
						return;
					}
					setState({ enabled: true, preset: presetName }, ctx);
					const over = budgetAction(config.config.budget, budget.spend.usd) !== "run";
					notify(ctx, `MoA on (preset ${presetName})${over ? `; note: ${spendText(budget.spend, config.config.budget)} — the limit is already reached` : ""}`);
					return;
				}
				case "off":
					setState(OFF, ctx);
					notify(ctx, "MoA off");
					return;
				case "reload": {
					const fresh = await reload(ctx);
					budget.reset(budget.spend);
					const problems = fresh.issues.length > 0 ? `\n${formatIssues(fresh.issues)}` : "";
					notify(ctx, `MoA config reloaded (${fresh.issues.length} issue(s))${problems}`, problems ? "warning" : "info");
					const active = state.enabled ? state.preset : undefined;
					const errors = active ? activationErrors(fresh, active, ctx) : [];
					if (errors.length > 0) {
						setState(OFF, ctx);
						notify(ctx, `MoA turned off: preset "${active}" is no longer usable:\n${errors.join("\n")}`, "warning");
					} else {
						updateStatus(ctx);
						syncTools();
					}
					return;
				}
				case "init": {
					const written = await writeDefaultConfig(globalConfigPath);
					notify(ctx, written ? `MoA: wrote ${globalConfigPath}` : `MoA: ${globalConfigPath} already exists; left unchanged`);
					return;
				}
				case "prompt":
					notify(ctx, "MoA: one-shot /moa <prompt> is not implemented yet", "warning");
					return;
			}
		},
	});
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

function statusText(config: LoadedConfig, state: MoaState, spend: Spend): string {
	const lines: string[] = [];
	const preset = state.enabled && state.preset ? getPreset(config.config, state.preset) : undefined;
	if (state.enabled && !preset) {
		lines.push(`MoA on · preset ${state.preset} (unavailable in current config)`);
	} else if (state.enabled && preset) {
		const triggers = preset.triggers.map((t) => (typeof t === "string" ? t : `every_n:${t.every_n}`)).join(", ");
		const advisors = preset.advisors.map((a) => `${a.model} (${a.role ?? "advisor"})`).join(", ");
		lines.push(`MoA on · preset ${state.preset}`, `triggers: ${triggers}`, `advisors: ${advisors}`);
	} else {
		lines.push(`MoA off · default preset ${config.config.defaultPreset}`);
	}
	lines.push(spendText(spend, config.config.budget));
	lines.push(`config: ${config.sources.length > 0 ? config.sources.join(", ") : "built-in defaults"}`);
	if (config.issues.length > 0) lines.push(`config issues:\n${formatIssues(config.issues)}`);
	return lines.join("\n");
}
