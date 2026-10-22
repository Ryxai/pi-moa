import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `PI_MOA_DEBUG=1` logs to `<agentDir>/moa-debug.log`; any other non-empty value is used as the
 * log path. Logging goes to a file because stderr would corrupt the TUI.
 */
export function debugLogPath(env: string | undefined, agentDir: string): string | undefined {
	if (!env || env === "0" || env === "false") return undefined;
	return env === "1" || env === "true" ? join(agentDir, "moa-debug.log") : env;
}

export function createDebugLog(path: string | undefined): (line: string) => void {
	if (!path) return () => {};
	return (line) => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Debug logging must never break a turn.
		}
	};
}
