import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_CONFIG, isPlainObject } from "./schema.ts";
import { parseConfig, type ConfigIssue, type ParsedConfig } from "./config.ts";

export const CONFIG_FILE = "moa.json";

export interface ConfigPaths {
	global: string;
	project: string;
	projectTrusted: boolean;
}

export interface LoadedConfig extends ParsedConfig {
	/** Files that were read, lowest precedence first. */
	sources: string[];
	notes: string[];
	/** Contents of every role `promptFile`, by absolute path. */
	promptFiles: Record<string, string>;
}

export async function loadConfig(paths: ConfigPaths): Promise<LoadedConfig> {
	const layers: unknown[] = [];
	const sources: string[] = [];
	const notes: string[] = [];
	const fileIssues: ConfigIssue[] = [];
	const files = [paths.global, ...(paths.projectTrusted ? [paths.project] : [])];
	for (const file of files) {
		const result = await readJsonFile(file);
		if (result.kind === "missing") continue;
		if (result.kind === "error") {
			fileIssues.push({ path: file, message: result.message });
			continue;
		}
		layers.push(resolvePromptFiles(result.data, dirname(file)));
		sources.push(file);
	}
	if (!paths.projectTrusted && (await exists(paths.project))) {
		notes.push(`ignoring ${paths.project}: project is not trusted`);
	}
	const parsed = parseConfig(layers);
	const promptFiles = await readPromptFiles(parsed.config.roles, fileIssues);
	return { ...parsed, issues: [...fileIssues, ...parsed.issues], sources, notes, promptFiles };
}

async function readPromptFiles(roles: unknown, issues: ConfigIssue[]): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	if (!isPlainObject(roles)) return files;
	for (const [name, role] of Object.entries(roles)) {
		const file = isPlainObject(role) ? role.promptFile : undefined;
		if (typeof file !== "string" || file === "" || Object.hasOwn(files, file)) continue;
		try {
			files[file] = await readFile(file, "utf8");
		} catch (error) {
			issues.push({ path: `roles.${name}.promptFile`, message: `cannot read ${file}: ${(error as Error).message}` });
		}
	}
	return files;
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

type ReadResult = { kind: "missing" } | { kind: "error"; message: string } | { kind: "ok"; data: unknown };

async function readJsonFile(file: string): Promise<ReadResult> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "error", message: `cannot read: ${(error as Error).message}` };
	}
	try {
		return { kind: "ok", data: JSON.parse(text) };
	} catch (error) {
		return { kind: "error", message: `invalid JSON: ${(error as Error).message}` };
	}
}

/** Makes `roles.*.promptFile` absolute relative to the file that declared it. */
export function resolvePromptFiles(layer: unknown, baseDir: string): unknown {
	if (!isPlainObject(layer) || !isPlainObject(layer.roles)) return layer;
	const roles: Record<string, unknown> = {};
	for (const [name, role] of Object.entries(layer.roles)) {
		const file = isPlainObject(role) ? role.promptFile : undefined;
		const absolute = typeof file === "string" && file !== "" && !isAbsolute(file);
		roles[name] = absolute ? { ...(role as object), promptFile: resolve(baseDir, file) } : role;
	}
	return { ...layer, roles };
}

/** Writes the defaults to `file`. Returns false (and writes nothing) if it already exists. */
export async function writeDefaultConfig(file: string): Promise<boolean> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}
