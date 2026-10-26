import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AdvisorResult } from "./advisors.ts";
import { budgetAction, formatUsd, recordSpend, type Spend } from "./budget.ts";
import type { MoaRecord } from "./round.ts";
import { isPlainObject, type ADVICE_DISPLAY, type MoaConfig } from "./schema.ts";

export type AdviceDisplay = (typeof ADVICE_DISPLAY)[number];

/** The theme methods the renderers use; pi's `Theme` satisfies it. */
export type ThemeLike = Pick<Theme, "fg" | "bold" | "italic" | "underline" | "strikethrough">;

/** A session `moa` entry's data or a consult result's `details`, when it has a record's shape. */
export function asRecord(data: unknown): MoaRecord | undefined {
	if (!isPlainObject(data) || !Array.isArray(data.advisors) || typeof data.reason !== "string") return undefined;
	const valid = data.advisors.every((a) => isPlainObject(a) && typeof a.label === "string" && typeof a.model === "string" && typeof a.role === "string");
	return valid ? (data as unknown as MoaRecord) : undefined;
}

export function formatLatency(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Known spend, with `+?` when some calls reported no cost; undefined when nothing is known. */
function costText(spend: Spend): string | undefined {
	if (spend.usd === 0 && spend.unknown > 0) return "cost ?";
	if (spend.usd === 0) return undefined;
	return `${formatUsd(spend.usd)}${spend.unknown > 0 ? "+?" : ""}`;
}

const SEP = " · ";

type Color = Parameters<ThemeLike["fg"]>[0];
const VERDICT_COLOR: Record<string, Color> = { "on-track": "success", revise: "warning", blocked: "error" };

/** The round's verdicts as `revise ×2, on-track`, most severe first; undefined when none was given. */
export function verdictSummary(record: MoaRecord): string | undefined {
	const counts = new Map<string, number>();
	const all = record.synthesis ? [...record.advisors, record.synthesis] : record.advisors;
	for (const advisor of all) if (advisor.ok && advisor.verdict) counts.set(advisor.verdict, (counts.get(advisor.verdict) ?? 0) + 1);
	if (counts.size === 0) return undefined;
	const order = ["blocked", "revise", "on-track"];
	return order
		.filter((v) => counts.has(v))
		.map((v) => (counts.get(v)! > 1 ? `${v} ×${counts.get(v)}` : v))
		.join(", ");
}

/** The one-line summary of a round, e.g. `◇ MoA · user_turn · step 2 · 2/2 advisors · revise · $0.0120 · 4.1s`. */
export function cardLine(record: MoaRecord, theme: ThemeLike): string {
	const ok = record.advisors.filter((a) => a.ok).length;
	const total = record.advisors.length;
	const countColor = ok === total ? "muted" : ok === 0 ? "error" : "warning";
	const calls = record.synthesis ? [...record.advisors, record.synthesis] : record.advisors;
	const latency = Math.max(0, ...calls.map((a) => (Number.isFinite(a.latencyMs) ? a.latencyMs : 0)));
	const parts = [
		theme.fg("accent", "◇ MoA"),
		theme.fg("muted", record.reason),
		...(typeof record.step === "number" ? [theme.fg("muted", `step ${record.step}`)] : []),
		theme.fg(countColor, `${ok}/${total} advisor${total === 1 ? "" : "s"}`),
	];
	const verdicts = verdictSummary(record);
	if (verdicts) parts.push(theme.fg(VERDICT_COLOR[verdicts.split(" ")[0]!] ?? "muted", verdicts));
	if (record.synthesis) parts.push(theme.fg(record.synthesis.ok ? "muted" : "warning", record.synthesis.ok ? (record.synthesis.silent ? "synthesis: nothing to reconcile" : "synthesis") : "synthesis failed"));
	const cost = costText(recordSpend(record));
	if (cost) parts.push(theme.fg("muted", cost));
	if (latency > 0) parts.push(theme.fg("muted", formatLatency(latency)));
	if (record.interrupted) parts.push(theme.fg("warning", "interrupted"));
	return parts.join(theme.fg("dim", SEP));
}

/** One advisor's header line: label, model, role, tokens, cost, latency and flags. */
export function advisorLine(advisor: AdvisorResult, theme: ThemeLike): string {
	const parts = [theme.bold(advisor.label), theme.fg("muted", advisor.model), theme.fg("muted", advisor.role)];
	if (advisor.effort) parts.push(theme.fg("muted", `effort ${advisor.effort}`));
	if (advisor.ok && advisor.verdict) parts.push(theme.fg(VERDICT_COLOR[advisor.verdict] ?? "muted", advisor.verdict));
	if (advisor.ok && advisor.silent) parts.push(theme.fg("muted", "nothing to reconcile"));
	const usage = advisor.usage;
	if (usage) {
		const input = usage.input + usage.cacheRead + usage.cacheWrite;
		const cached = usage.cacheRead > 0 ? ` (${formatTokens(usage.cacheRead)} cached)` : "";
		parts.push(theme.fg("dim", `${formatTokens(input)} in${cached} / ${formatTokens(usage.output)} out`));
	}
	if (typeof advisor.costUsd === "number" && Number.isFinite(advisor.costUsd)) parts.push(theme.fg("dim", formatUsd(advisor.costUsd)));
	if (advisor.latencyMs > 0) parts.push(theme.fg("dim", formatLatency(advisor.latencyMs)));
	const flags = (["retried", "sanitized", "truncated", "capped"] as const).filter((flag) => advisor[flag]);
	if (flags.length > 0) parts.push(theme.fg("warning", flags.join(", ")));
	const head = parts.join(theme.fg("dim", SEP));
	return advisor.ok ? head : `${head}\n${theme.fg("error", `error: ${advisor.error ?? "failed"}`)}`;
}

export function markdownTheme(theme: ThemeLike): MarkdownTheme {
	return {
		heading: (t) => theme.fg("mdHeading", t),
		link: (t) => theme.fg("mdLink", t),
		linkUrl: (t) => theme.fg("mdLinkUrl", t),
		code: (t) => theme.fg("mdCode", t),
		codeBlock: (t) => theme.fg("mdCodeBlock", t),
		codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
		quote: (t) => theme.fg("mdQuote", t),
		quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
		hr: (t) => theme.fg("mdHr", t),
		listBullet: (t) => theme.fg("mdListBullet", t),
		bold: (t) => theme.bold(t),
		italic: (t) => theme.italic(t),
		underline: (t) => theme.underline(t),
		strikethrough: (t) => theme.strikethrough(t),
		highlightCode: (code, lang) => {
			// pi's highlighter colours with pi's active theme (the one renderers are given); plain code-block colour when it is unavailable.
			try {
				return highlightCode(code, lang);
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

/** The card, and when expanded each advisor's header and advice (as markdown). */
export function recordComponent(record: MoaRecord, expanded: boolean, theme: ThemeLike): Container {
	const card = new Container();
	card.addChild(new Text(cardLine(record, theme), 0, 0));
	if (!expanded) return card;
	if (record.question) card.addChild(new Text(theme.fg("muted", `Question: ${record.question}`), 0, 0));
	const md = markdownTheme(theme);
	const calls = record.synthesis ? [...record.advisors, record.synthesis] : record.advisors;
	for (const advisor of calls) {
		card.addChild(new Text(`\n${advisorLine(advisor, theme)}`, 0, 0));
		if (advisor.ok && advisor.text) card.addChild(new Markdown(advisor.text, 2, 0, md));
	}
	return card;
}

/** The transcript line for a `before_done` review message sent back to the actor (its round shows as its own card). */
export function reviewMessageText(theme: ThemeLike): string {
	return [theme.fg("accent", "◇ MoA"), theme.fg("muted", "before_done review sent to the agent; it continues working (see the round above)")].join(theme.fg("dim", SEP));
}

/** Whether a record shows expanded under `display` when pi's expand toggle is `expanded`. */
export function isExpanded(display: AdviceDisplay, expanded: boolean): boolean {
	return display === "expanded" || (display === "collapsed" && expanded);
}

/** Renders a `moa` session entry; nothing in `hidden` mode or for malformed data. */
export function renderEntry(data: unknown, expanded: boolean, display: AdviceDisplay, theme: ThemeLike & Pick<Theme, "bg">): Component | undefined {
	if (display === "hidden") return undefined;
	const record = asRecord(data);
	if (!record) return undefined;
	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(recordComponent(record, isExpanded(display, expanded), theme));
	return box;
}

export function consultCallText(question: unknown, theme: ThemeLike): string {
	const title = theme.fg("toolTitle", theme.bold("consult"));
	if (typeof question !== "string" || !question.trim()) return title;
	const line = question.trim().replace(/\s+/g, " ");
	return `${title} ${theme.fg("accent", `"${line.length > 120 ? `${line.slice(0, 119)}…` : line}"`)}`;
}

export interface ConsultResultLike {
	content: readonly { type: string; text?: string }[];
	details?: unknown;
}

/**
 * The consult result: the round's card (advice only when expanded, never in `hidden` mode), or the
 * result text when no round ran (unavailable, budget, limit, failure).
 */
export function renderConsultResult(
	result: ConsultResultLike,
	options: { expanded: boolean; isPartial: boolean; isError?: boolean },
	display: AdviceDisplay,
	theme: ThemeLike,
): Component {
	const text = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n").trim();
	if (options.isPartial) return new Text(theme.fg("muted", text || "Consulting advisors…"), 0, 0);
	const record = asRecord(result.details);
	if (!record) return new Text(theme.fg(options.isError ? "error" : "muted", text), 0, 0);
	return recordComponent(record, isExpanded(display, options.expanded), theme);
}

/**
 * Footer status: `moa:<preset>` (session toggle) or `moa/<preset>` (selected virtual model), plus
 * spend when non-zero and a marker once the budget is reached.
 */
export function statusLine(preset: string, spend: Spend, budget: MoaConfig["budget"] | undefined, viaModel = false): string {
	const parts = [viaModel ? `moa/${preset}` : `moa:${preset}`];
	if (spend.usd > 0) parts.push(formatUsd(spend.usd));
	if (budget && budgetAction(budget, spend.usd) !== "run") parts.push("budget reached");
	return parts.join(SEP);
}

/** "MoA: advisors k/n…" progress for the working message. */
export function progressText(done: number, total: number): string {
	return `MoA: advisors ${done}/${total}…`;
}
