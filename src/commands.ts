export type MoaCommand =
	| { kind: "status" }
	| { kind: "on"; preset?: string }
	| { kind: "off" }
	| { kind: "reload" }
	| { kind: "init" }
	| { kind: "prompt"; text: string };

export const SUBCOMMANDS = ["on", "off", "reload", "init"] as const;

/**
 * Keywords only count when the word count fits (`on [preset]`, bare `off`/`reload`/`init`);
 * anything else is a one-shot prompt, so `/moa off the top of your head…` is a prompt.
 */
export function parseMoaArgs(args: string): MoaCommand {
	const text = args.trim();
	if (text === "") return { kind: "status" };
	const words = text.split(/\s+/);
	const [first, second] = words;
	if (first === "on" && words.length <= 2) return second ? { kind: "on", preset: second } : { kind: "on" };
	if (words.length === 1 && (first === "off" || first === "reload" || first === "init")) return { kind: first };
	return { kind: "prompt", text };
}

export interface Completion {
	value: string;
	label: string;
}

export function completeMoaArgs(prefix: string, presets: readonly string[]): Completion[] | null {
	const onMatch = /^on\s+(\S*)$/.exec(prefix);
	if (onMatch) {
		const partial = onMatch[1] ?? "";
		const items = presets.filter((p) => p.startsWith(partial)).map((p) => ({ value: `on ${p}`, label: p }));
		return items.length > 0 ? items : null;
	}
	if (/\s/.test(prefix)) return null;
	const items = SUBCOMMANDS.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
	return items.length > 0 ? items : null;
}
