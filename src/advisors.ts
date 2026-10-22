import {
	getCurrentTools,
	normalizeContext,
	type AssistantMessage,
	type Context,
	type SimpleStreamOptions,
	type ThinkingBudgets,
	type Usage,
} from "@earendil-works/pi-ai";
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
	/** Token budgets per thinking level (pi's `thinkingBudgets` setting), as the actor gets them. */
	thinkingBudgets?: ThinkingBudgets;
	maxTokens?: number;
	/** Provider session id: stable `prompt_cache_key` / session routing for this advisor slot. */
	sessionId?: string;
	/** Provider payload hook for this call (the cache-marker fix). */
	onPayload?: SimpleStreamOptions["onPayload"];
	/**
	 * With tools declared (native view): "none" (default) sends tool_choice none; "omit" sends
	 * none only on one retry when the first reply called tools and has no text.
	 */
	toolChoice?: "none" | "omit";
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
	/** The first reply had no text and the call was repeated with tool_choice none. */
	retried?: true;
	/** Tool-call-like or framing-like text was replaced (see sanitize.ts). */
	sanitized?: true;
	/** The text was cut to the advisor text cap. */
	truncated?: true;
}

export interface RunOptions<M> {
	complete: CompleteFn<M>;
	signal?: AbortSignal;
	timeoutMs: number;
	now?: () => number;
	/**
	 * After a timeout or abort, how long to wait for the aborted call to settle, so the partial
	 * usage pi reports on an aborted message is still recorded. Default 1000.
	 */
	abortGraceMs?: number;
	/** Called with 0 at the start and as each advisor finishes, with the number done so far; errors are ignored. */
	onAdvisorDone?: (done: number, total: number) => void;
}

const ABORT_GRACE_MS = 1000;

/** Runs every advisor in parallel. Never throws; results keep the input order. */
export async function runAdvisors<M extends ModelLike>(
	advisors: readonly AdvisorRequest<M>[],
	options: RunOptions<M>,
): Promise<AdvisorResult[]> {
	let done = 0;
	const report = () => {
		try {
			options.onAdvisorDone?.(done, advisors.length);
		} catch {
			// Progress display must never affect the round.
		}
	};
	report();
	const settled = await Promise.allSettled(
		advisors.map((advisor) =>
			runAdvisor(advisor, options).finally(() => {
				done++;
				report();
			}),
		),
	);
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

	/**
	 * The call's message; on timeout or abort the call's own signal is aborted (pi then ends the
	 * provider request) and its aborted message, which carries the usage so far, is awaited
	 * briefly. Undefined when it does not settle in time.
	 */
	const call = async (forceNone: boolean): Promise<AssistantMessage | undefined> => {
		const pending = options.complete(advisor.model, advisor.context, callOptions(advisor, controller.signal, forceNone));
		pending.catch(() => {});
		try {
			return await Promise.race([pending, stopped]);
		} catch (error) {
			if (!controller.signal.aborted) throw error;
			return await settleWithin(pending, options.abortGraceMs ?? ABORT_GRACE_MS);
		}
	};
	let retried = false;
	let usage: Usage | undefined;
	try {
		const tools = declaresTools(advisor);
		let message = await call(false);
		usage = message?.usage;
		// Same timeout and abort as the first call.
		// Only tool-call replies: a length-capped or thinking-only empty reply would likely be empty again.
		if (message && !reason && tools && advisor.toolChoice === "omit" && message.stopReason === "toolUse" && !textOf(message) && canForceNone(advisor)) {
			retried = true;
			message = await call(true);
			usage = addUsage(usage, message?.usage);
		}
		const latency = now() - start;
		const extra = { ...(usage && { usage, costUsd: usage.cost?.total }), ...(retried && { retried: true as const }) };
		if (reason || !message) return { ...failure(advisor, reason ?? "aborted", latency), ...extra };
		if (!isUsable(message)) return { ...failure(advisor, message.errorMessage ?? message.stopReason, latency), ...extra };
		const text = textOf(message);
		if (!text) return { ...failure(advisor, "empty response", latency), ...extra };
		return { ...base(advisor), ok: true, text, ...extra, latencyMs: latency };
	} catch (error) {
		const extra = { ...(usage && { usage, costUsd: usage.cost?.total }), ...(retried && { retried: true as const }) };
		return { ...failure(advisor, reason ?? errorText(error), now() - start), ...extra };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuterAbort);
	}
}

/** `pending`'s message if it resolves within `ms`; rejections count as no message. */
async function settleWithin<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([pending.catch(() => undefined), late]);
	} finally {
		clearTimeout(timer);
	}
}

const BEDROCK_API = "bedrock-converse-stream";

/**
 * Tools may come from `Context.tools` or system-message deltas; adapters send `tool_choice` even
 * with no tools, which providers can reject.
 */
const declaresTools = (advisor: AdvisorRequest<ModelLike>) => getCurrentTools(normalizeContext(advisor.context).messages).length > 0;

/** For `none` pi drops Bedrock's `toolConfig`, which Bedrock rejects when the history holds tool blocks. */
const canForceNone = (advisor: AdvisorRequest<ModelLike>) => advisor.model.api !== BEDROCK_API;

const isUsable = (message: AssistantMessage) => message.stopReason !== "error" && message.stopReason !== "aborted";

/** Only the reply's text counts; tool calls and thinking are ignored. */
function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
	if (!a || !b) return a ?? b;
	const cost = (key: keyof Usage["cost"]) => (a.cost?.[key] ?? 0) + (b.cost?.[key] ?? 0);
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: { input: cost("input"), output: cost("output"), cacheRead: cost("cacheRead"), cacheWrite: cost("cacheWrite"), total: cost("total") },
	};
}

function callOptions(advisor: AdvisorRequest<ModelLike>, signal: AbortSignal, forceNone: boolean): SimpleStreamOptions {
	const options: SimpleStreamOptions = { signal };
	const none = forceNone || advisor.toolChoice !== "omit";
	if (none && declaresTools(advisor) && canForceNone(advisor)) options.toolChoice = "none";
	if (advisor.maxTokens !== undefined) options.maxTokens = advisor.maxTokens;
	if (advisor.thinking && advisor.thinking !== "off") options.reasoning = advisor.thinking;
	if (advisor.thinkingBudgets) options.thinkingBudgets = advisor.thinkingBudgets;
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
