import { isPlainObject } from "./schema.ts";

export const STATE_ENTRY = "moa-state";

export interface MoaState {
	enabled: boolean;
	preset?: string;
}

export const OFF: MoaState = { enabled: false };

/** Minimal shape of a session entry; pi's `SessionEntry` satisfies it. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Latest valid `moa-state` entry on the branch wins; no entry means off. */
export function reconstructState(branch: readonly EntryLike[]): MoaState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const state = toState(entry.data);
		if (state) return state;
	}
	return OFF;
}

function toState(data: unknown): MoaState | undefined {
	if (!isPlainObject(data) || typeof data.enabled !== "boolean") return undefined;
	if (!data.enabled) return OFF;
	return typeof data.preset === "string" ? { enabled: true, preset: data.preset } : undefined;
}

export interface TurnPosition {
	/** Timestamp of the last user message; identifies the turn. */
	turn?: number;
	/** Assistant messages since that user message. */
	step: number;
}

export function turnPosition(messages: readonly { role: string; timestamp?: number }[]): TurnPosition {
	let step = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "user") return { turn: message.timestamp, step };
		if (message.role === "assistant") step++;
	}
	return { step };
}
