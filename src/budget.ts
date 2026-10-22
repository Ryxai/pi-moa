import { CONSULT_TOOL } from "./tool-names.ts";
import { isPlainObject, type MoaConfig } from "./schema.ts";

/** Session entry shape for spend reconstruction; pi's `SessionEntry` satisfies it. */
export interface SpendEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

export interface Spend {
	usd: number;
	/** Advisor calls whose cost was not reported (counted as $0). */
	unknown: number;
}

export type BudgetAction = "run" | MoaConfig["budget"]["onExceed"];

/** What to do before a round or consult; `sessionUsd: 0` means no limit. */
export function budgetAction(budget: MoaConfig["budget"], spent: number): BudgetAction {
	return budget.sessionUsd > 0 && spent >= budget.sessionUsd ? budget.onExceed : "run";
}

/** Spend of one round record (a `moa` entry's data or a consult result's `details`). */
export function recordSpend(record: unknown): Spend {
	const spend: Spend = { usd: 0, unknown: 0 };
	if (!isPlainObject(record) || !Array.isArray(record.advisors)) return spend;
	for (const advisor of record.advisors) {
		if (!isPlainObject(advisor)) continue;
		const cost = advisor.costUsd;
		if (typeof cost === "number" && Number.isFinite(cost)) spend.usd += cost;
		else if (advisor.ok === true || advisor.usage !== undefined) spend.unknown++;
	}
	return spend;
}

/** Advisor spend on a branch: `recordEntry` custom entries plus consult tool results' `details`. */
export function branchSpend(branch: readonly SpendEntry[], recordEntry: string): Spend {
	const total: Spend = { usd: 0, unknown: 0 };
	for (const entry of branch) {
		const record = entry.type === "custom" && entry.customType === recordEntry ? entry.data : consultDetails(entry);
		if (record === undefined) continue;
		const spend = recordSpend(record);
		total.usd += spend.usd;
		total.unknown += spend.unknown;
	}
	return total;
}

function consultDetails(entry: SpendEntry): unknown {
	if (entry.type !== "message" || !isPlainObject(entry.message)) return undefined;
	const message = entry.message;
	return message.role === "toolResult" && message.toolName === CONSULT_TOOL ? message.details : undefined;
}

/** Session spend, rebuilt from the branch and increased live; notifies once per session when over. */
export class BudgetTracker {
	spend: Spend = { usd: 0, unknown: 0 };
	private notified = false;

	reset(spend: Spend): void {
		this.spend = spend;
		this.notified = false;
	}

	add(record: unknown): void {
		const spend = recordSpend(record);
		this.spend = { usd: this.spend.usd + spend.usd, unknown: this.spend.unknown + spend.unknown };
	}

	/** True the first time it is called since the last reset. */
	firstNotice(): boolean {
		if (this.notified) return false;
		this.notified = true;
		return true;
	}
}

export function formatUsd(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** The `/moa` status line for advisor spend. */
export function spendText(spend: Spend, budget: MoaConfig["budget"]): string {
	// Config may be invalid here (status is shown regardless).
	const limit = typeof budget?.sessionUsd === "number" && budget.sessionUsd > 0 ? ` of ${formatUsd(budget.sessionUsd)} (${budget.onExceed} when reached)` : " (no limit)";
	const unknown = spend.unknown > 0 ? `; some advisor costs unknown (${spend.unknown} call${spend.unknown === 1 ? "" : "s"})` : "";
	return `advisor spend this session: ${formatUsd(spend.usd)}${limit}${unknown}`;
}
