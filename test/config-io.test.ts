import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolvePromptFiles, writeDefaultConfig } from "../src/config-io.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

let dir: string;
let paths: { global: string; project: string; projectTrusted: boolean };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-moa-"));
	await mkdir(join(dir, "agent"));
	await mkdir(join(dir, "proj", ".pi"), { recursive: true });
	paths = { global: join(dir, "agent", "moa.json"), project: join(dir, "proj", ".pi", "moa.json"), projectTrusted: true };
});

const write = (file: string, data: unknown) => writeFile(file, typeof data === "string" ? data : JSON.stringify(data));

describe("loadConfig", () => {
	it("uses defaults when no files exist", async () => {
		const loaded = await loadConfig(paths);
		expect(loaded.config).toEqual(DEFAULT_CONFIG);
		expect(loaded.sources).toEqual([]);
		expect(loaded.issues).toEqual([]);
	});

	it("layers a trusted project file over the global file", async () => {
		await write(paths.global, { budget: { sessionUsd: 2 }, defaultPreset: "solo" });
		await write(paths.project, { budget: { sessionUsd: 1 } });
		const loaded = await loadConfig(paths);
		expect(loaded.config.budget.sessionUsd).toBe(1);
		expect(loaded.sources).toEqual([paths.global, paths.project]);
	});

	it("ignores the project file when the project is untrusted", async () => {
		await write(paths.project, { budget: { sessionUsd: 1 } });
		const loaded = await loadConfig({ ...paths, projectTrusted: false });
		expect(loaded.config.budget.sessionUsd).toBe(DEFAULT_CONFIG.budget.sessionUsd);
		expect(loaded.notes[0]).toMatch(/not trusted/);
	});

	it("reports invalid JSON as an issue", async () => {
		await write(paths.global, "{ nope");
		const loaded = await loadConfig(paths);
		expect(loaded.issues[0]?.path).toBe(paths.global);
		expect(loaded.issues[0]?.message).toMatch(/invalid JSON/);
	});
});

describe("resolvePromptFiles", () => {
	it("makes relative prompt files absolute to the declaring file", () => {
		const out = resolvePromptFiles({ roles: { r: { promptFile: "./roles/r.md" }, abs: { promptFile: "/x.md" } } }, "/cfg");
		expect(out).toEqual({ roles: { r: { promptFile: "/cfg/roles/r.md" }, abs: { promptFile: "/x.md" } } });
	});
});

describe("writeDefaultConfig", () => {
	it("writes defaults once and never overwrites", async () => {
		const file = join(dir, "fresh", "moa.json");
		expect(await writeDefaultConfig(file)).toBe(true);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual(DEFAULT_CONFIG);
		await write(file, { mine: true });
		expect(await writeDefaultConfig(file)).toBe(false);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mine: true });
	});
});
