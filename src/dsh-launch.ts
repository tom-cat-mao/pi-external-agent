/**
 * dsh's launch plumbing: the permission overlay every extension-spawned run
 * carries, and the offline composition anchor that proves it took effect.
 *
 * dsh composes base bundle → profile patch → home patch → `--patch` overlays.
 * Our overlay is last, so it owns the `permission` row of the composed config:
 * the row's whole config is replaced with the three extension tiers and a
 * `defaultPreset` expression driven by DSH_PERMISSION_MODE. The permission
 * service pins that preset into every fresh session; dsh's sandbox-policy and
 * approval rows read the same variable at boot.
 *
 * This is the 0.2.1+ topology. dsh no longer reads a path-configured settings
 * document, so the old `settings` re-point is not merely stale: it leaves a
 * profile's `permission.defaultPreset` free to outrank DSH_PERMISSION_MODE when
 * the session is created. Provisioning therefore writes one file, the overlay,
 * and the anchor checks the permission row itself.
 *
 * The overlay is ours by NAME, so a symlink found there is replaced rather than
 * followed. A failure to provision it is a refusal: without the overlay a
 * profile preset can silently govern the run.
 *
 * Provisioning alone is not proof. The composition is anchored once per profile
 * per process by an offline `dsh --dump-config` probe running with the same
 * profile and overlay the spawn will use. Findings are warnings here; the mode
 * aware prepareDshLaunch() decides whether a warning is a refusal. readonly and
 * write are fail-closed: if the requested tier cannot be proven, the dispatch
 * does not run. yolo only warns because it deliberately promises no boundary.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** dsh's home under the user's home; dsh's own default, shared with the user. */
export const DSH_HOME_DIR_NAME = ".dsh";

/** Our overlay inside that home; handed to dsh as `--patch <file>`. */
export const DSH_OVERLAY_NAME = "cordis.patch.pi-external-agent.yml";

/** How long the offline `--dump-config` anchor probe may take before it is skipped. */
const DSH_DUMP_TIMEOUT_MS = 10_000;

/**
 * The two dsh run profiles the extension can boot: `headless` on the legacy
 * one-shot adapter, `acp` on the production persistent path. The anchor probes
 * PER PROFILE because dsh composes per profile: an ACP profile patch cannot be
 * validated by a headless probe.
 */
export type DshProfile = "headless" | "acp";

/** The settings variable dsh's sandbox-policy and approval rows read. */
const DSH_PERMISSION_ENV = "DSH_PERMISSION_MODE";

/** The patch entry's row id: dsh's permission-preset service. */
const PERMISSION_ROW_ID = "permission";

/** The presets the extension depends on, in the order the overlay writes them. */
const REQUIRED_PRESETS = ["read-only", "workspace-write", "danger-full-access"] as const;

/** The two rows whose configs read DSH_PERMISSION_MODE; replacing either breaks tier pinning. */
const ENV_HOOKED_ROW_IDS = ["sandbox-policy", "approval"] as const;

/** dsh's shared home for the current user, home-directory-derived and injectable. */
export function dshSharedHome(): string {
	return join(homedir(), DSH_HOME_DIR_NAME);
}

/** Our overlay inside a home; `<home>/.dsh/cordis.patch.pi-external-agent.yml` by default. */
export function dshOverlayPath(home: string = dshSharedHome()): string {
	return join(home, DSH_OVERLAY_NAME);
}

/** The overlay's comment header; hand edits are overwritten on the next spawn. */
export const DSH_OVERLAY_HEADER = [
	"# Written by pi-external-agent on every dsh spawn; hand edits are overwritten.",
	"# Pins the 0.2.1+ permission row: its whole config is replaced by the three",
	"# extension tiers, and defaultPreset follows DSH_PERMISSION_MODE so a user's",
	"# profile default cannot silently outrank the tier this dispatch asked for.",
].join("\n");

/**
 * The overlay body: one patch entry replacing the permission row's whole
 * config. A patch replaces config rather than merging it, so the preset table
 * is restated here; defaultPreset remains an expression so one overlay serves
 * every mode and concurrent dispatches keep their own environment.
 */
export function dshOverlayContent(): string {
	const presets = REQUIRED_PRESETS.map((preset) => {
		const [sandbox, approval] =
			preset === "read-only" ? ["read-only", "ask"] : preset === "workspace-write" ? ["workspace-write", "ask"] : ["danger-full-access", "never"];
		return `      ${preset}:\n        sandbox: ${sandbox}\n        approval: ${approval}`;
	}).join("\n");
	return (
		`${DSH_OVERLAY_HEADER}\n` +
		`- id: ${PERMISSION_ROW_ID}\n` +
		"  config:\n" +
		"    presets:\n" +
		`${presets}\n` +
		`    defaultPreset: !!js process.env.${DSH_PERMISSION_ENV} ?? 'workspace-write'\n`
	);
}

export interface DshLaunchOptions {
	/** dsh's shared home; defaults to `<home>/.dsh`. */
	homeDir?: string;
	/** Our overlay; defaults to `<homeDir>/cordis.patch.pi-external-agent.yml`. */
	overlay?: string;
}

export type DshLaunchResult = { ok: true; overlay: string } | { ok: false; reason: string };

/**
 * Lazy, idempotent overlay provisioning, called on every dsh spawn. The shared
 * home is the only directory this module creates. The overlay is ours outright,
 * so it is rewritten whenever its content differs; provisioning uses a temp file
 * and rename so a concurrent spawn never reads a half-written patch.
 *
 * A failure here is a refusal: without the overlay a profile's own
 * `permission.defaultPreset` can become the effective tier.
 */
export function ensureDshLaunch(options: DshLaunchOptions = {}): DshLaunchResult {
	const home = options.homeDir ?? dshSharedHome();
	const overlay = options.overlay ?? dshOverlayPath(home);
	try {
		mkdirSync(home, { recursive: true });
	} catch (err) {
		return { ok: false, reason: `could not create dsh's shared home ${home}: ${describe(err)}` };
	}

	const content = dshOverlayContent();
	let existing: string | undefined;
	try {
		existing = readFileSync(overlay, "utf8");
	} catch {
		/* absent or unreadable: the write below is the same either way */
	}
	if (isSymlink(overlay) || existing !== content) {
		const temp = `${overlay}.${process.pid}.tmp`;
		try {
			writeFileSync(temp, content);
			renameSync(temp, overlay);
		} catch (err) {
			try {
				unlinkSync(temp);
			} catch {
				/* nothing was created, or the write failed before it existed */
			}
			return { ok: false, reason: `could not write the dsh overlay ${overlay}: ${describe(err)}` };
		}
	}
	return { ok: true, overlay };
}

/** Whether a path exists as a symbolic link — lstat, so the link itself is examined. */
function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		/* absent, or its parent is not a directory: nothing to replace */
		return false;
	}
}

export interface DshGuardOptions {
	/** Our overlay path, as handed to dsh. */
	overlay: string;
	/** The profile the spawn will boot; dsh composes per profile, so the probe must too. */
	profile: DshProfile;
	/** The dsh executable to probe; defaults to 'dsh' from PATH. */
	bin?: string;
	/**
	 * Probe runner, for tests and for a caller with its own dsh: given the probe
	 * argv, it returns the composed config, or why it could not be read.
	 * Defaults to spawning the dsh binary.
	 */
	run?: (argv: string[]) => DshProbeOutcome;
}

/** What one offline probe produced: the composed config, or why there is none. */
export type DshProbeOutcome = { ok: true; dump: string } | { ok: false; reason: string };

/** The memoized anchor results, one per profile; absent until that profile has probed. */
const compositionWarnings = new Map<DshProfile, string[]>();

/** Forget the memoized anchor results, so the next call probes again. */
export function resetDshCompositionGuard(): void {
	compositionWarnings.clear();
}

/**
 * The composition anchor: at most one offline dump-config spawn per profile per
 * process. The probe proves what the process will actually compose:
 *   (a) our overlay owns the permission row and its defaultPreset reads
 *       DSH_PERMISSION_MODE;
 *   (b) the permission row still carries the three presets this extension maps
 *       its modes onto;
 *   (c) the sandbox-policy and approval rows still read DSH_PERMISSION_MODE.
 *
 * A probe that cannot run (dsh absent, a non-zero exit, a timeout) is reported
 * as an unavailable anchor and is not memoized: the next dispatch probes again.
 */
export function dshCompositionWarnings(options: DshGuardOptions): string[] {
	const memo = compositionWarnings.get(options.profile);
	if (memo !== undefined) return memo;
	const probe = options.run ?? ((argv: string[]) => runDshDumpConfig(options.bin ?? "dsh", argv));
	const outcome = probe(dshDumpArgv(options.profile, options.overlay));
	if (!outcome.ok) {
		return [
			`dsh composition anchor unavailable: the ${options.profile} profile's composition could not be read offline` +
				` (${outcome.reason}): the requested permission tier may not be the one in force.`,
		];
	}
	const warnings = compositionViolations(outcome.dump, options);
	compositionWarnings.set(options.profile, warnings);
	return warnings;
}

/** The offline probe: the launcher composes and prints its config, no model call, no session. */
function dshDumpArgv(profile: DshProfile, overlay: string): string[] {
	return ["--profile", profile, "--patch", overlay, "--dump-config"];
}

function runDshDumpConfig(bin: string, argv: string[]): DshProbeOutcome {
	try {
		return {
			ok: true,
			dump: execFileSync(bin, argv, {
				encoding: "utf8",
				timeout: DSH_DUMP_TIMEOUT_MS,
				// The probe must see the composition the spawn will see, and the
				// spawn strips an inherited DSH_HOME so it resolves the shared home.
				env: probeEnv(),
				stdio: ["ignore", "pipe", "ignore"],
			}),
		};
	} catch (err) {
		return { ok: false, reason: describe(err) };
	}
}

/** process.env with dsh's home override removed, so the probe reads the shared home. */
function probeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.DSH_HOME;
	return env;
}

/** One composed-config row: its id line, the lines that follow it, and the patch that wrote it. */
interface ConfigRow {
	lines: string[];
	patch?: string;
}

const ROW_START = /^- id:\s*(\S+)\s*$/;
const PATCHED_BY = /patched by ([^,\s]+)/g;

/**
 * Index a config dump by row id. dsh marks a patched row with a
 * "patched by <file>" comment on the line above it. A row several patches wrote
 * carries one marker per patch in composition order, so the LAST marker is the
 * patch that won.
 */
function configRows(dump: string): Map<string, ConfigRow> {
	const rows = new Map<string, ConfigRow>();
	let pendingPatch: string | undefined;
	let current: ConfigRow | undefined;
	for (const line of dump.split("\n")) {
		if (line.trimStart().startsWith("#")) {
			for (const marker of line.matchAll(PATCHED_BY)) pendingPatch = marker[1];
			continue;
		}
		const start = ROW_START.exec(line);
		if (start) {
			current = { lines: [line], ...(pendingPatch ? { patch: pendingPatch } : {}) };
			pendingPatch = undefined;
			rows.set(start[1], current);
			continue;
		}
		current?.lines.push(line);
	}
	return rows;
}

/** The value of a key line inside the row's own config block, if there is one. */
function rowValue(row: ConfigRow, key: string): string | undefined {
	const pattern = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`);
	for (let index = 0; index < row.lines.length; index += 1) {
		const header = /^(\s+)config:\s*$/.exec(row.lines[index]);
		if (!header) continue;
		const indent = header[1].length;
		for (const line of row.lines.slice(index + 1)) {
			const lineIndent = /^\s*/.exec(line)![0].length;
			if (line.trim() && lineIndent <= indent) break;
			const match = pattern.exec(line);
			if (match) return match[1];
		}
	}
	return undefined;
}

/** A dump line with its YAML comment removed; quoted scalars keep their hash. */
function stripYamlComment(line: string): string {
	let quote: string | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === "#") {
			return line.slice(0, index);
		}
	}
	return line;
}

/** Every way the composed config can leave the requested tier unproven. */
function compositionViolations(dump: string, options: DshGuardOptions): string[] {
	const rows = configRows(dump);
	const warnings: string[] = [];

	const permission = rows.get(PERMISSION_ROW_ID);
	const offender = permission?.patch ?? options.overlay;
	if (permission === undefined) {
		warnings.push(
			`dsh's ${PERMISSION_ROW_ID} row is missing from the composed config, so a fresh session's permission preset is not pinned` +
				`: the requested permission tier may not be the one in force.`,
		);
	} else {
		const defaultPreset = rowValue(permission, "defaultPreset");
		if (defaultPreset === undefined || !defaultPreset.includes(DSH_PERMISSION_ENV)) {
			warnings.push(
				`${offender} left dsh's ${PERMISSION_ROW_ID} row without a defaultPreset that reads ${DSH_PERMISSION_ENV}` +
					`: a profile's permission default can outrank the variable, so the requested permission tier may not be the one in force.`,
			);
		}
		const missing = REQUIRED_PRESETS.filter((preset) => !permission.lines.some((line) => stripYamlComment(line).trim() === `${preset}:`));
		if (missing.length > 0) {
			warnings.push(
				`${offender} left dsh's ${PERMISSION_ROW_ID} row without the ${missing.join(", ")} preset(s)` +
					": the extension cannot map every permission mode onto the composed permission service.",
			);
		}
	}

	for (const id of ENV_HOOKED_ROW_IDS) {
		const row = rows.get(id);
		if (row && row.lines.some((line) => stripYamlComment(line).includes(DSH_PERMISSION_ENV))) continue;
		warnings.push(
			row
				? `${row.patch ?? "the composed config"} replaced dsh's ${id} row with config that no longer reads ${DSH_PERMISSION_ENV}` +
						": the requested permission tier is not what governs the run."
				: `dsh's ${id} row is missing from the composed config, so nothing reads ${DSH_PERMISSION_ENV}` +
						": the requested permission tier is not what governs the run.",
		);
	}

	return warnings;
}

export type DshPrepareResult = { ok: true; overlay: string; warning?: string } | { ok: false; reason: string };

/**
 * Provisioning plus the mode-aware anchor decision - what both dsh transports
 * call before they spawn. readonly and write refuse when any composition
 * warning leaves the tier unproven; yolo warns and runs because it deliberately
 * promises no confinement.
 */
export function prepareDshLaunch(profile: DshProfile, mode: "readonly" | "write" | "yolo", options: DshLaunchOptions = {}): DshPrepareResult {
	const launch = ensureDshLaunch(options);
	if (!launch.ok) return launch;
	const warnings = dshCompositionWarnings({ overlay: launch.overlay, profile });
	if (warnings.length === 0) return launch;
	if (mode !== "yolo") {
		return {
			ok: false,
			reason:
				`dsh composition did not prove the requested ${mode} permission tier; refusing to run rather than claim a sandbox boundary ` +
				`that may not be enforced. Request mode "yolo" if full access is intended. ${warnings.join(" ")}`,
		};
	}
	return { ...launch, warning: warnings.join(" ") };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
