import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { moveCacheMarker } from "./cache.ts";
import { completeMoaArgs, parseMoaArgs } from "./commands.ts";
import { CONFIG_FILE, loadConfig, writeDefaultConfig, type LoadedConfig } from "./config-io.ts";
import { resolvePreset } from "./config-resolve.ts";
import { formatIssues, getPreset, issuesFor } from "./config.ts";
import { createDebugLog, debugLogPath } from "./debug.ts";
import { runRound } from "./round.ts";
import { OFF, reconstructState, STATE_ENTRY, type MoaState } from "./state.ts";

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
		state = next;
		if (next.enabled !== persisted.enabled || next.preset !== persisted.preset) {
			pi.appendEntry(STATE_ENTRY, next);
			persisted = next;
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const show = state.enabled && (loaded?.config.ui.status ?? true);
		try {
			if (ctx.hasUI) ctx.ui.setStatus("moa", show ? `moa:${state.preset}` : undefined);
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
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("context_with_system", async (event, ctx) => {
		contextCalls++;
		const last = event.messages.at(-1);
		debug(
			`context_with_system #${contextCalls} enabled=${state.enabled} preset=${state.preset ?? "-"} messages=${event.messages.length} last=${last?.role}`,
		);
		if (!state.enabled || !state.preset || !loaded) return undefined;
		const config = loaded;
		setWorking(ctx, "MoA: advisors…");
		try {
			const round = await runRound(
				{
					messages: event.messages,
					config: config.config,
					presetName: state.preset,
					models: ctx.modelRegistry,
					actor: ctx.model,
					signal: ctx.signal,
					sessionId: sessionIdOf(ctx),
				},
				{
					complete: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options).result(),
					appendEntry: (type, data) => pi.appendEntry(type, data),
					readPromptFile: (path) => (Object.hasOwn(config.promptFiles, path) ? config.promptFiles[path] : undefined),
					debug,
				},
			);
			if (!round) return undefined;
			injected = [...injected, round.advice].slice(-TRACKED_ADVICE);
			return { messages: round.messages };
		} catch (error) {
			debug(`round failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			return undefined;
		} finally {
			setWorking(ctx);
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

	pi.registerCommand("moa", {
		description: "Mixture of Models: /moa [on [preset] | off | reload | init]",
		getArgumentCompletions: (prefix) => completeMoaArgs(prefix, Object.keys(loaded?.config.presets ?? {})),
		handler: async (args, ctx) => {
			const command = parseMoaArgs(args);
			const config = loaded ?? (await reload(ctx));
			switch (command.kind) {
				case "status":
					notify(ctx, statusText(config, state));
					return;
				case "on": {
					const presetName = command.preset ?? config.config.defaultPreset;
					const errors = activationErrors(config, presetName, ctx);
					if (errors.length > 0) {
						notify(ctx, `MoA: cannot use preset "${presetName}":\n${errors.join("\n")}`, "error");
						return;
					}
					setState({ enabled: true, preset: presetName }, ctx);
					notify(ctx, `MoA on (preset ${presetName})`);
					return;
				}
				case "off":
					setState(OFF, ctx);
					notify(ctx, "MoA off");
					return;
				case "reload": {
					const fresh = await reload(ctx);
					const problems = fresh.issues.length > 0 ? `\n${formatIssues(fresh.issues)}` : "";
					notify(ctx, `MoA config reloaded (${fresh.issues.length} issue(s))${problems}`, problems ? "warning" : "info");
					const active = state.enabled ? state.preset : undefined;
					const errors = active ? activationErrors(fresh, active, ctx) : [];
					if (errors.length > 0) {
						setState(OFF, ctx);
						notify(ctx, `MoA turned off: preset "${active}" is no longer usable:\n${errors.join("\n")}`, "warning");
					}
					updateStatus(ctx);
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

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function statusText(config: LoadedConfig, state: MoaState): string {
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
	lines.push(`config: ${config.sources.length > 0 ? config.sources.join(", ") : "built-in defaults"}`);
	if (config.issues.length > 0) lines.push(`config issues:\n${formatIssues(config.issues)}`);
	return lines.join("\n");
}
