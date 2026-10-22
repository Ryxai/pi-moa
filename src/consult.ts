import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { addUsage } from "./advisors.ts";
import { frameAdvice } from "./framing.ts";
import type { MoaRecord, RoundOutput } from "./round.ts";
import type { PresetConfig } from "./schema.ts";
import { analyzeTurn } from "./triggers.ts";
import type { AgentMessage } from "./view.ts";

import { CONSULT_TOOL } from "./tool-names.ts";

export { CONSULT_TOOL };

export const CONSULT_DESCRIPTION =
	"Ask independent advisor models for a second opinion. They see this conversation (and your question, if any), " +
	"have no tools and cannot act; their advice may be wrong, so verify its claims with tools before relying on them. " +
	"Use it before substantive work (once you have oriented yourself), when stuck or repeating failures, before " +
	"changing approach, and before declaring a task done. Do not use it for trivial or routine steps. Calls per turn are limited.";

export const consultParameters = Type.Object({
	question: Type.Optional(Type.String({ description: "What you want advice on. Omit for a general review of your next step." })),
});

export type ConsultParams = Static<typeof consultParameters>;

export type ConsultResult = AgentToolResult<MoaRecord | undefined>;

/** Whether the tool should be declared to the actor: MoA on with a preset that allows consult calls. */
export function consultWanted(preset: Pick<PresetConfig, "consult"> | undefined): boolean {
	return preset !== undefined && preset.consult.enabled && preset.consult.maxPerTurn > 0;
}

export interface ActiveTools {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

/** Adds or removes the consult tool from the active set, leaving every other tool as it is. */
export function syncConsultTool(tools: ActiveTools, want: boolean): void {
	const active = tools.getActiveTools();
	if (active.includes(CONSULT_TOOL) === want) return;
	tools.setActiveTools(want ? [...active, CONSULT_TOOL] : active.filter((name) => name !== CONSULT_TOOL));
}

/** Consult calls in the current turn; a new turn key starts over. */
export class ConsultCounter {
	private turnKey?: string;
	private count = 0;

	/** Counts a call in `turnKey`; false when `max` calls already ran in that turn. */
	take(turnKey: string, max: number): boolean {
		if (turnKey !== this.turnKey) {
			this.turnKey = turnKey;
			this.count = 0;
		}
		if (this.count >= max) return false;
		this.count++;
		return true;
	}
}

export interface ConsultEnv {
	/** The active preset's consult settings; undefined while MoA is off. */
	settings: PresetConfig["consult"] | undefined;
	/** The messages of the actor request that produced the call, before any advice was added. */
	snapshot: readonly AgentMessage[] | undefined;
	/** The actor's response that made the call, appended to what advisors see when found. */
	caller?: AgentMessage;
	counter: ConsultCounter;
	/** A non-error reply that replaces the call (advisor budget reached), or undefined to run. */
	gate?: () => string | undefined;
	run(request: { messages: readonly AgentMessage[]; question?: string; turn: string; step: number }): Promise<RoundOutput | undefined>;
}

const result = (text: string, details?: MoaRecord, extra: Partial<ConsultResult> = {}): ConsultResult => ({
	content: [{ type: "text", text }],
	details,
	...extra,
});

/**
 * Runs the preset's advisors on the actor's latest request (plus the calling response) and the
 * question, within the per-turn cap. Every call counts toward the cap, including failed and aborted ones.
 */
export async function executeConsult(
	params: ConsultParams,
	env: ConsultEnv,
	onUpdate?: AgentToolUpdateCallback<MoaRecord | undefined>,
): Promise<ConsultResult> {
	if (!env.settings || !consultWanted({ consult: env.settings })) return result("consult is unavailable: MoA is off.", undefined, { isError: true });
	if (!env.snapshot) return result("consult is unavailable: no request context.", undefined, { isError: true });
	const blocked = env.gate?.();
	if (blocked) return result(blocked);
	const analysis = analyzeTurn(env.snapshot);
	const max = env.settings.maxPerTurn;
	if (!env.counter.take(analysis.turnKey, max)) return result(`consult limit reached for this turn (${max}).`);

	const question = params.question?.trim() || undefined;
	try {
		onUpdate?.(result("Consulting advisors…"));
	} catch {
		// Display must never break the call.
	}
	const messages = env.caller ? [...env.snapshot, env.caller] : env.snapshot;
	let round: RoundOutput | undefined;
	try {
		round = await env.run({ messages, question, turn: analysis.turnKey, step: analysis.step });
	} catch (error) {
		return result(`consult failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), undefined, { isError: true });
	}
	if (!round) return result("consult failed: the preset has no usable advisors.", undefined, { isError: true });

	const usage = round.results.reduce<ConsultResult["usage"]>((sum, r) => addUsage(sum, r.usage), undefined);
	const extra = usage ? { usage } : {};
	if (round.interrupted) return result("consult aborted.", round.record, { ...extra, isError: true });
	const advice = frameAdvice(round.results);
	if (!advice) {
		const reasons = [...new Set(round.results.map((r) => (r.error ?? "empty response").slice(0, 80)))].join("; ");
		return result(`consult failed: no advisor answered (${reasons}).`, round.record, { ...extra, isError: true });
	}
	return result(advice, round.record, extra);
}
