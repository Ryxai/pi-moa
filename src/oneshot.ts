/**
 * A pending `/moa <prompt>`: MoA runs for the turn that `text` starts and no other. The turn is
 * found in the request hook as the first turn whose user message is exactly `text`, skipping the
 * turn that was current when the command ran (it may have the same text).
 */
export interface OneShot {
	preset: string;
	text: string;
	/** Turn key current when the command ran; never bound. */
	exclude?: string;
	/** Bound turn key, once seen. */
	turn?: string;
}

/**
 * The one-shot's preset if it applies to the request in `turnKey`, plus the updated pending
 * one-shot (`undefined` once its turn has passed).
 */
export function matchOneShot(
	pending: OneShot | undefined,
	turn: { turnKey: string; userText?: string },
): { pending: OneShot | undefined; preset?: string } {
	if (!pending) return { pending };
	if (pending.turn !== undefined) {
		return pending.turn === turn.turnKey ? { pending, preset: pending.preset } : { pending: undefined };
	}
	if (turn.turnKey !== "" && turn.turnKey !== pending.exclude && turn.userText === pending.text) {
		const bound = { ...pending, turn: turn.turnKey };
		return { pending: bound, preset: bound.preset };
	}
	return { pending };
}
