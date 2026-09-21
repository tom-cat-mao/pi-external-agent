/**
 * dsh's launch plumbing: our settings document, and the overlay that pins dsh
 * to it.
 *
 * dsh reads its user settings from ~/.dsh, and a `permission.defaultPreset` in
 * that document OUTRANKS DSH_PERMISSION_MODE. Handing dsh the user's own home
 * would therefore make the hub's mode enforcement unreliable — a readonly task
 * could still write — which is why this module does not: it keeps the SHARED
 * home and re-points exactly one row of dsh's composed config at a document of
 * ours, which is empty.
 *
 *   - `~/.dsh/settings.pi-external-agent.yaml` — OUR settings document. Created
 *     EMPTY when missing and never written again: its whole job is to be a
 *     settings document with no `permission:` section, so the composed default
 *     (the one DSH_PERMISSION_MODE drives) governs the run. Never overwritten,
 *     never mutated.
 *   - `~/.dsh/cordis.patch.pi-external-agent.yml` — OUR overlay, handed to dsh
 *     as `--patch <file>`. A patch entry REPLACES the whole config of the row
 *     it targets, so `- id: settings` + a `path` makes dsh read our empty
 *     document instead of the user's. Rewritten whenever its content differs.
 *
 * Verified live against dsh 0.1.5-rc.2: with the real ~/.dsh holding
 * `defaultPreset: danger-full-access`, `DSH_PERMISSION_MODE=read-only dsh
 * --profile headless --patch <overlay> "create a file"` had the write DENIED by
 * the sandbox, the escalation failed closed, and settings.yaml was untouched.
 * `--patch` is a LAUNCHER flag and must precede the task positional.
 *
 * Provisioning is lazy and idempotent, on every dsh spawn. Only a file that
 * cannot be created at all is a refusal, because that leaves the tier
 * unenforced; nothing else here is fatal. There is no credentials machinery:
 * the home is the user's own, so dsh reads their credentials exactly as their
 * own shell does.
 *
 * Provisioning alone is not proof the composition is what we asked for — a
 * later patch can outrank our overlay, and a profile or home patch can replace
 * the rows that read DSH_PERMISSION_MODE — so the composition is ANCHORED once
 * per profile per process by an offline `dsh --dump-config` probe run under the
 * profile the dispatch will boot (dshCompositionWarnings): dsh composes
 * base → profile → home → `--patch`, so a probe under `headless` says nothing
 * about `acp` and vice versa. Its findings are warnings, never refusals: a run
 * whose composition drifted is still a run, but the caller has to know the tier
 * it asked for may not be the one in force. A probe that cannot run at all —
 * no dsh, a non-zero exit, a timeout — warns and is retried on the next
 * dispatch instead of standing in for a composition nobody read.
 *
 * Both files are ours by NAME, so a symlink found at either is replaced rather
 * than followed: a link we did not write could aim dsh's settings row at a
 * document carrying a `permission.defaultPreset`, which is exactly the
 * precedence this module exists to keep out of a hub-dispatched run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** dsh's home under the user's home; dsh's own default, shared with the user. */
export const DSH_HOME_DIR_NAME = ".dsh";

/** Our settings document inside that home; created empty, never written again. */
export const DSH_SETTINGS_DOC_NAME = "settings.pi-external-agent.yaml";

/** Our overlay inside that home; handed to dsh as `--patch <file>`. */
export const DSH_OVERLAY_NAME = "cordis.patch.pi-external-agent.yml";

/** How long the offline `--dump-config` anchor probe may take before it is skipped. */
const DSH_DUMP_TIMEOUT_MS = 10_000;

/**
 * The two dsh run profiles the extension boots: `headless` on the one-shot
 * transport, `acp` for the session driver. The anchor probes PER PROFILE,
 * because dsh composes base → profile → home → `--patch`: a user's
 * `~/.dsh/profiles/acp/cordis.patch.yml` can replace a row for the ACP
 * composition alone, and a probe under the other profile would never see it.
 */
export type DshProfile = "headless" | "acp";

/** The settings variable dsh's sandbox-policy and approval rows read. */
const DSH_PERMISSION_ENV = "DSH_PERMISSION_MODE";

/** The settings section that outranks that variable when a document carries one. */
const PERMISSION_SECTION = /^\s*permission\s*:/m;

/** The patch entry's row id: dsh's settings plugin (dsh-settings-file). */
const SETTINGS_ROW_ID = "settings";

/** The two rows whose configs read DSH_PERMISSION_MODE; replacing either breaks tier pinning. */
const ENV_HOOKED_ROW_IDS = ["sandbox-policy", "approval"] as const;

/** dsh's shared home for the current user, home-directory-derived and injectable. */
export function dshSharedHome(): string {
	return join(homedir(), DSH_HOME_DIR_NAME);
}

/** Our settings document inside a home; `<home>/.dsh/settings.pi-external-agent.yaml` by default. */
export function dshSettingsDocPath(home: string = dshSharedHome()): string {
	return join(home, DSH_SETTINGS_DOC_NAME);
}

/** Our overlay inside a home; `<home>/.dsh/cordis.patch.pi-external-agent.yml` by default. */
export function dshOverlayPath(home: string = dshSharedHome()): string {
	return join(home, DSH_OVERLAY_NAME);
}

/**
 * The overlay's comment header. It says who writes the file, because a hand
 * edit here is both pointless (the next spawn rewrites it) and dangerous: this
 * one entry is what keeps the user's own settings document out of the run.
 */
export const DSH_OVERLAY_HEADER = [
	"# Written by pi-external-agent on every dsh spawn; hand edits are overwritten.",
	"# Re-points dsh's settings row at pi's own empty settings document: a document",
	"# with a permission.defaultPreset outranks DSH_PERMISSION_MODE, so the user's",
	"# settings.yaml must not be the one a hub-dispatched run reads.",
].join("\n");

/**
 * The overlay body: one patch entry replacing the settings row's whole config,
 * which is how a patch overrides a row (`config` is replaced, not merged).
 */
export function dshOverlayContent(settingsDoc: string): string {
	return `${DSH_OVERLAY_HEADER}\n- id: ${SETTINGS_ROW_ID}\n  config:\n    path: ${settingsDoc}\n`;
}

export interface DshLaunchOptions {
	/** dsh's shared home; defaults to `<home>/.dsh`. */
	homeDir?: string;
	/** Our settings document; defaults to `<homeDir>/settings.pi-external-agent.yaml`. */
	settingsDoc?: string;
	/** Our overlay; defaults to `<homeDir>/cordis.patch.pi-external-agent.yml`. */
	overlay?: string;
}

export type DshLaunchResult =
	| { ok: true; overlay: string; settingsDoc: string }
	| { ok: false; reason: string };

/**
 * Lazy, idempotent provisioning, called on every dsh spawn: make sure our empty
 * settings document exists, and that the overlay points at it.
 *
 * The document comes first, and is only ever CREATED (flag `wx`, never a
 * truncate): an existing one belongs to the user or to an earlier process, and
 * overwriting it could erase a document someone is editing. What matters about
 * it is only that it carries no `permission:` section, which the anchor probe
 * checks. The overlay is ours outright, so it is rewritten whenever its content
 * differs — a stale one from an earlier build (or a home that moved) must not
 * pin the settings row at a path nothing maintains.
 *
 * Both names are reserved for these two files, so a symlink at either is
 * removed and replaced by the regular file itself: writing through the link
 * would put a document we cannot see — one that may carry
 * `permission.defaultPreset` — where dsh reads its settings.
 *
 * A failure here is a refusal rather than a warning because both files are
 * load-bearing: without the overlay dsh reads the user's settings document, and
 * the requested tier stops binding silently.
 */
export function ensureDshLaunch(options: DshLaunchOptions = {}): DshLaunchResult {
	const home = options.homeDir ?? dshSharedHome();
	const settingsDoc = options.settingsDoc ?? dshSettingsDocPath(home);
	const overlay = options.overlay ?? dshOverlayPath(home);

	// The shared home is the user's own dsh home: an existing one is left exactly
	// as it is, and this is the only directory this module ever creates. A path
	// that cannot be a directory (a file in the way, permissions) takes both
	// files with it, so it is reported here rather than twice below.
	try {
		mkdirSync(home, { recursive: true });
	} catch (err) {
		return { ok: false, reason: `could not create dsh's shared home ${home}: ${describe(err)}` };
	}

	if (isSymlink(settingsDoc)) {
		try {
			unlinkSync(settingsDoc);
		} catch (err) {
			return {
				ok: false,
				reason: `could not replace the symlinked dsh settings document ${settingsDoc}: ${describe(err)}`,
			};
		}
	}

	if (!existsSync(settingsDoc)) {
		try {
			writeFileSync(settingsDoc, "", { flag: "wx" });
		} catch (err) {
			// Losing the race to a peer pi process that created it in between is
			// that process's success, not our failure; anything else means the
			// path cannot hold a file at all.
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
				return {
					ok: false,
					reason: `could not create the empty dsh settings document ${settingsDoc}: ${describe(err)}`,
				};
			}
		}
	}

	const content = dshOverlayContent(settingsDoc);
	let existing: string | undefined;
	try {
		existing = readFileSync(overlay, "utf8");
	} catch {
		/* absent or unreadable: the write below is the same either way */
	}
	if (isSymlink(overlay) || existing !== content) {
		// Through a temp file and a rename: the overlay is never half-written
		// where a concurrent spawn could read it, and the rename replaces a
		// symlink at the destination instead of writing through it.
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

	return { ok: true, overlay, settingsDoc };
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
	/** Our settings document, whose emptiness is the point. */
	settingsDoc: string;
	/** The profile the spawn will boot; dsh composes per profile, so the probe must too. */
	profile: DshProfile;
	/** The dsh executable to probe; defaults to `dsh` from PATH. */
	bin?: string;
	/**
	 * Probe runner, for tests and for a caller with its own dsh: given the probe
	 * argv, it returns the composed config, or why it could not be read.
	 * Defaults to spawning `dsh <argv>`.
	 */
	run?: (argv: string[]) => DshProbeOutcome;
}

/** What one offline probe produced: the composed config, or why there is none. */
export type DshProbeOutcome = { ok: true; dump: string } | { ok: false; reason: string };

/** The memoized anchor results, one per profile; absent until that profile has probed. */
const compositionWarnings = new Map<DshProfile, string[]>();

/**
 * Forget the memoized anchor results, so the next call probes again. Production
 * probes once per profile per process on purpose — the answer is about this
 * machine's configuration, not about one dispatch — so this exists for tests
 * that need a fresh probe.
 */
export function resetDshCompositionGuard(): void {
	compositionWarnings.clear();
}

/**
 * The composition anchor: at most one offline `dsh --dump-config` spawn per
 * profile per process, reported as warnings.
 *
 * Provisioning proves the two files are on disk; this proves the process dsh
 * will actually compose reads them. Three things are worth knowing, and each
 * one breaks the tier silently rather than loudly:
 *   (a) our overlay did not take effect — the settings row points elsewhere, so
 *       dsh reads a document that may carry `permission.defaultPreset`;
 *   (b) a `sandbox-policy` or `approval` row was replaced with a literal — the
 *       composition no longer reads DSH_PERMISSION_MODE at all;
 *   (c) something wrote a `permission:` section into OUR document.
 *
 * The probe runs under the profile the spawn will boot, so a profile patch that
 * rewrites a row for `acp` is reported for an `acp` session rather than hidden
 * behind a clean `headless` composition.
 *
 * A probe that cannot run (dsh absent, a non-zero exit, a timeout) is reported
 * as an unavailable anchor and NOT memoized: it is a fact about this attempt,
 * not about the machine, so the next dispatch probes again. Either way the
 * finding is a warning and never blocks a dispatch.
 */
export function dshCompositionWarnings(options: DshGuardOptions): string[] {
	const memo = compositionWarnings.get(options.profile);
	if (memo !== undefined) return memo;

	// A document that is not a regular file (a directory, a symlink somebody
	// re-created) cannot be read as an empty settings document, and the probe
	// could not tell us what dsh reads instead: warn, and skip the guard.
	const doc = lstatOrUndefined(options.settingsDoc);
	if (doc && !doc.isFile()) {
		return [
			`${options.settingsDoc} is not a regular file, so the composition anchor is skipped` +
				`: the requested permission tier may not be the one in force.`,
		];
	}

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
				// spawn strips an inherited DSH_HOME (it would point the shared
				// home elsewhere) — so the probe strips it too.
				env: probeEnv(),
				stdio: ["ignore", "pipe", "ignore"],
			}),
		};
	} catch (err) {
		// Best effort by construction: an unavailable or unhappy dsh is reported
		// as an unavailable anchor instead of failing a dispatch that would run.
		return { ok: false, reason: describe(err) };
	}
}

/** `lstatSync`, or undefined when the path does not exist. */
function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/** process.env with dsh's home override removed, so the probe reads the shared home. */
function probeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.DSH_HOME;
	return env;
}

/** One composed-config row: its `- id:` line, the lines that follow it, and the patch that wrote it. */
interface ConfigRow {
	lines: string[];
	patch?: string;
}

const ROW_START = /^- id:\s*(\S+)\s*$/;
const PATCHED_BY = /patched by ([^,\s]+)/g;

/**
 * Index a `--dump-config` dump by row id. dsh marks a patched row with a
 * `# ... patched by <file>` comment on the line above it, which is the only
 * provenance in the dump — and the file name a warning should name. A row
 * several patches wrote carries one marker per patch, in composition order, so
 * the LAST marker is the patch that won.
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

/**
 * The value of a `key:` line inside the row's own `config:` block, if there is
 * one. Scoped to that block: the patch entry replaces a row's `config` wholesale,
 * so a same-named key anywhere else in the row is not what dsh composes.
 */
function rowValue(row: ConfigRow, key: string): string | undefined {
	const pattern = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`);
	for (let index = 0; index < row.lines.length; index += 1) {
		const header = /^(\s+)config:\s*$/.exec(row.lines[index]);
		if (!header) continue;
		const indent = header[1].length;
		for (const line of row.lines.slice(index + 1)) {
			const lineIndent = /^\s*/.exec(line)![0].length;
			if (line.trim() && lineIndent <= indent) break; // dedented: the block ended
			const match = pattern.exec(line);
			if (match) return match[1];
		}
	}
	return undefined;
}

/**
 * A dump line with its YAML comment removed. The heuristic is naive on purpose:
 * a `#` opens a comment unless it sits inside a quoted scalar, which is where
 * the dump's `!!js` rows carry their quotes. It is what keeps a decoy comment
 * from standing in for a row that no longer reads the variable.
 */
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

/**
 * The three composition violations, each naming the file that caused it and the
 * consequence of leaving it: the requested tier is not the tier in force.
 */
function compositionViolations(dump: string, options: DshGuardOptions): string[] {
	const rows = configRows(dump);
	const warnings: string[] = [];

	// (a) Our overlay must be the patch that wrote the settings row. A later
	// patch (or a profile patch) that re-points the row wins over ours, and then
	// dsh reads a settings document we did not choose.
	const settings = rows.get(SETTINGS_ROW_ID);
	const composed = settings ? rowValue(settings, "path") : undefined;
	if (composed !== options.settingsDoc) {
		const offender = settings?.patch ?? options.overlay;
		warnings.push(
			`${offender} left dsh's ${SETTINGS_ROW_ID} row reading ${composed ?? "no path"} instead of ${options.settingsDoc}` +
				`: dsh then reads a settings document that can carry permission.defaultPreset, which outranks ${DSH_PERMISSION_ENV}, ` +
				"so the requested permission tier may not be the one in force.",
		);
	}

	// (b) The tier travels in the environment, and exactly two rows read it.
	// Replacing either with a literal pinning one mode breaks every other tier.
	// Comments are stripped first: a row whose literal is decorated with a
	// mention of the variable reads no variable at all.
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

	// (c) Our document is only correct while it is empty of a permission
	// section: one written there would outrank the variable, which is exactly
	// what re-pointing the settings row exists to prevent.
	let doc: string | undefined;
	try {
		doc = readFileSync(options.settingsDoc, "utf8");
	} catch {
		/* unreadable: nothing to check, and nothing worth failing a dispatch over */
	}
	if (doc !== undefined && PERMISSION_SECTION.test(doc)) {
		warnings.push(
			`${options.settingsDoc} gained a permission: section, whose permission.defaultPreset outranks ${DSH_PERMISSION_ENV}` +
				": the requested permission tier is not what governs the run. Remove the section; the document exists only to be empty.",
		);
	}

	return warnings;
}

export type DshPrepareResult =
	| { ok: true; overlay: string; settingsDoc: string; warning?: string }
	| { ok: false; reason: string };

/**
 * Provisioning plus the anchor probe — what both dsh transports call before
 * they spawn, each with the profile it is about to boot. The refusal is about
 * provisioning only (a file that cannot exist); everything the anchor finds is
 * a warning, because a run whose composition drifted is still a run the caller
 * may want to make.
 */
export function prepareDshLaunch(profile: DshProfile, options: DshLaunchOptions = {}): DshPrepareResult {
	const launch = ensureDshLaunch(options);
	if (!launch.ok) return launch;
	const warnings = dshCompositionWarnings({ overlay: launch.overlay, settingsDoc: launch.settingsDoc, profile });
	return warnings.length > 0 ? { ...launch, warning: warnings.join(" ") } : launch;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
