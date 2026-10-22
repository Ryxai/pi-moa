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

/** The one-line summary of a round, e.g. `◇ MoA · user_turn · step 2 · 2/2 advisors · $0.0120 · 4.1s`. */
export function cardLine(record: MoaRecord, theme: ThemeLike): string {
	const ok = record.advisors.filter((a) => a.ok).length;
	const total = record.advisors.length;
	const countColor = ok === total ? "muted" : ok === 0 ? "error" : "warning";
	const latency = Math.max(0, ...record.advisors.map((a) => (Number.isFinite(a.latencyMs) ? a.latencyMs : 0)));
	const parts = [
		theme.fg("accent", "◇ MoA"),
		theme.fg("muted", record.reason),
		...(typeof record.step === "number" ? [theme.fg("muted", `step ${record.step}`)] : []),
		theme.fg(countColor, `${ok}/${total} advisor${total === 1 ? "" : "s"}`),
	];
	const cost = costText(recordSpend(record));
	if (cost) parts.push(theme.fg("muted", cost));
	if (latency > 0) parts.push(theme.fg("muted", formatLatency(latency)));
	if (record.interrupted) parts.push(theme.fg("warning", "interrupted"));
	return parts.join(theme.fg("dim", SEP));
}

/** One advisor's header line: label, model, role, tokens, cost, latency and flags. */
export function advisorLine(advisor: AdvisorResult, theme: ThemeLike): string {
	const parts = [theme.bold(advisor.label), theme.fg("muted", advisor.model), theme.fg("muted", advisor.role)];
	const usage = advisor.usage;
	if (usage) {
		const input = usage.input + usage.cacheRead + usage.cacheWrite;
		const cached = usage.cacheRead > 0 ? ` (${formatTokens(usage.cacheRead)} cached)` : "";
		parts.push(theme.fg("dim", `${formatTokens(input)} in${cached} / ${formatTokens(usage.output)} out`));
	}
	if (typeof advisor.costUsd === "number" && Number.isFinite(advisor.costUsd)) parts.push(theme.fg("dim", formatUsd(advisor.costUsd)));
	if (advisor.latencyMs > 0) parts.push(theme.fg("dim", formatLatency(advisor.latencyMs)));
	const flags = (["retried", "sanitized", "truncated"] as const).filter((flag) => advisor[flag]);
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
	for (const advisor of record.advisors) {
		card.addChild(new Text(`\n${advisorLine(advisor, theme)}`, 0, 0));
		if (advisor.ok && advisor.text) card.addChild(new Markdown(advisor.text, 2, 0, md));
	}
	return card;
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
