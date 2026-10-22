import { getCurrentTools, normalizeContext, type AssistantMessage, type Context, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import type { ModelLike } from "./config-resolve.ts";
import type { ThinkingLevel } from "./schema.ts";

/** One model call; in production `ctx.modelRegistry.streamSimple(...).result()`. */
export type CompleteFn<M> = (model: M, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

export interface AdvisorRequest<M extends ModelLike> {
	label: string;
	model: M;
	role: string;
	context: Context;
	thinking?: ThinkingLevel;
	maxTokens?: number;
	/** Provider session id: stable `prompt_cache_key` / session routing for this advisor slot. */
	sessionId?: string;
	/** Provider payload hook for this call (the cache-marker fix). */
	onPayload?: SimpleStreamOptions["onPayload"];
}

export interface AdvisorResult {
	label: string;
	/** `provider/id` */
	model: string;
	role: string;
	ok: boolean;
	text?: string;
	error?: string;
	usage?: Usage;
	costUsd?: number;
	latencyMs: number;
}

export interface RunOptions<M> {
	complete: CompleteFn<M>;
	signal?: AbortSignal;
	timeoutMs: number;
	now?: () => number;
}

/** Runs every advisor in parallel. Never throws; results keep the input order. */
export async function runAdvisors<M extends ModelLike>(
	advisors: readonly AdvisorRequest<M>[],
	options: RunOptions<M>,
): Promise<AdvisorResult[]> {
	const settled = await Promise.allSettled(advisors.map((advisor) => runAdvisor(advisor, options)));
	return settled.map((outcome, i) =>
		outcome.status === "fulfilled" ? outcome.value : failure(advisors[i]!, errorText(outcome.reason), 0),
	);
}

async function runAdvisor<M extends ModelLike>(advisor: AdvisorRequest<M>, options: RunOptions<M>): Promise<AdvisorResult> {
	const now = options.now ?? Date.now;
	const start = now();
	const outer = options.signal;
	if (outer?.aborted) return failure(advisor, "aborted", 0);

	const controller = new AbortController();
	let reason: string | undefined;
	const stop = (why: string) => {
		reason ??= why;
		controller.abort();
	};
	const onOuterAbort = () => stop("aborted");
	outer?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(() => stop(`timeout after ${formatSeconds(options.timeoutMs)}`), options.timeoutMs);
	const stopped = new Promise<never>((_, reject) => {
		controller.signal.addEventListener("abort", () => reject(new Error(reason)), { once: true });
	});
	stopped.catch(() => {});

	try {
		const message = await Promise.race([options.complete(advisor.model, advisor.context, callOptions(advisor, controller.signal)), stopped]);
		const latency = now() - start;
		if (reason) return failure(advisor, reason, latency);
		const usage = message.usage;
		const extra = { usage, costUsd: usage?.cost?.total };
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return { ...failure(advisor, message.errorMessage ?? message.stopReason, latency), ...extra };
		}
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) return { ...failure(advisor, "empty response", latency), ...extra };
		return { ...base(advisor), ok: true, text, ...extra, latencyMs: latency };
	} catch (error) {
		return failure(advisor, reason ?? errorText(error), now() - start);
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuterAbort);
	}
}

function callOptions(advisor: AdvisorRequest<ModelLike>, signal: AbortSignal): SimpleStreamOptions {
	const options: SimpleStreamOptions = { signal };
	// Tools may come from `Context.tools` or system-message deltas; adapters send `tool_choice`
	// even with no tools, which providers can reject.
	if (getCurrentTools(normalizeContext(advisor.context).messages).length > 0) options.toolChoice = "none";
	if (advisor.maxTokens !== undefined) options.maxTokens = advisor.maxTokens;
	if (advisor.thinking && advisor.thinking !== "off") options.reasoning = advisor.thinking;
	if (advisor.sessionId) options.sessionId = advisor.sessionId;
	if (advisor.onPayload) options.onPayload = advisor.onPayload;
	return options;
}

function base(advisor: AdvisorRequest<ModelLike>): Pick<AdvisorResult, "label" | "model" | "role"> {
	return { label: advisor.label, model: `${advisor.model.provider}/${advisor.model.id}`, role: advisor.role };
}

function failure(advisor: AdvisorRequest<ModelLike>, error: string, latencyMs: number): AdvisorResult {
	return { ...base(advisor), ok: false, error, latencyMs };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSeconds(ms: number): string {
	return `${Math.round(ms / 100) / 10}s`;
}
