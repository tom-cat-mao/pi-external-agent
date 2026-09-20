/**
 * dsh's dedicated harness home.
 *
 * dsh keeps its user settings in ~/.dsh, and that file's `permission.defaultPreset`
 * key OUTRANKS both DSH_PERMISSION_MODE and any --patch overlay (verified
 * 0.1.5-rc.2 by hand). Sharing the user's ~/.dsh would therefore make the hub's
 * mode enforcement unreliable — a readonly task could still write — so every dsh
 * spawn gets its own DSH_HOME, where the composed defaults govern and the
 * requested tier actually binds.
 *
 * Credentials are the one thing that must not be copied: they are the user's,
 * they rotate, and a duplicate would drift. A symlink to ~/.dsh/.credentials.yaml
 * keeps a single source of truth, and when that source does not exist yet the
 * whole provisioning fails with the sign-in instruction instead of handing dsh a
 * home that cannot authenticate.
 *
 * The link is not the only possible arrangement. dsh writes its credentials
 * through an atomic rename whose documented behavior REPLACES a symlink with a
 * real file (verified in @deepseek-ai/dsh-atomic-write), so after such a write —
 * a credentials layout migration, say — the harness home holds its own copy that
 * drifts as the user's credentials rotate. That copy is never deleted (it may be
 * the user's only working credentials), but it is reported: the result carries a
 * warning naming the one-line fix, which is deleting it so the next spawn
 * re-links the user's file.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The harness home's directory name under the user's home. */
export const DSH_HARNESS_HOME_NAME = ".dsh-external-agent";

/** The credentials link inside the harness home; dsh reads it as its own file. */
export const DSH_CREDENTIALS_LINK_NAME = ".credentials.yaml";

/** Why provisioning failed, and what the user has to do about it. */
export const DSH_SIGNIN_INSTRUCTION =
	"run `dsh web` once to sign in (it writes ~/.dsh/.credentials.yaml) before dispatching dsh tasks";

export interface DshHomeOptions {
	/** Harness home to provision; defaults to `<home>/.dsh-external-agent`. */
	homeDir?: string;
	/** The user's credentials file to link; defaults to `<home>/.dsh/.credentials.yaml`. */
	credentialsSource?: string;
}

export type DshHomeResult =
	| { ok: true; home: string; credentials: string; warning?: string }
	| { ok: false; reason: string };

/** The harness home for the current user; the value handed to dsh as DSH_HOME. */
export function dshHomeDir(): string {
	return join(homedir(), DSH_HARNESS_HOME_NAME);
}

/** The user's dsh credentials file, as written by `dsh web`. */
export function dshCredentialsSource(): string {
	return join(homedir(), ".dsh", DSH_CREDENTIALS_LINK_NAME);
}

/**
 * The warning a provisioned home carries when its credentials entry is a local
 * copy rather than the link: dsh's atomic credential write replaced the symlink,
 * so this copy no longer follows the user's rotations. The entry is kept (it may
 * be the only credentials that work), and the text names the one-line fix.
 */
export function dshCredentialsForkWarning(credentials: string, credentialsSource: string): string {
	return (
		`${credentials} is a local credentials copy, not a link to ${credentialsSource}: dsh's atomic credential write ` +
		`replaces a symlink with a real file, so this copy can go stale as the user's credentials rotate. ` +
		`Delete ${credentials} to re-link it.`
	);
}

/** True when the path exists and is a symlink to exactly that target. */
function isLinkTo(path: string, target: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
	} catch {
		return false;
	}
}

/** True when the path itself is a symlink, whatever it points at. */
function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Create the credentials link, tolerating the one race lazy provisioning can
 * lose: a second pi process that provisioned the same home between our check and
 * our symlinkSync makes that call fail with EEXIST. An entry that is the correct
 * link by the time we re-inspect is that process's success, not our failure;
 * anything else is reported with the original error.
 */
export function linkDshCredentials(
	credentialsSource: string,
	credentials: string,
): { ok: true } | { ok: false; reason: string } {
	try {
		symlinkSync(credentialsSource, credentials);
		return { ok: true };
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EEXIST" && isLinkTo(credentials, credentialsSource)) return { ok: true };
		return { ok: false, reason: `could not link ${credentials} to ${credentialsSource}: ${describe(err)}` };
	}
}

/**
 * Lazy, idempotent provisioning, called on every dsh spawn: create the harness
 * home when it is missing, and make sure `.credentials.yaml` is a symlink to
 * the user's credentials.
 *
 * The source is checked first so a failure leaves nothing behind — a dangling
 * link would only hide the missing sign-in. A symlinked home path is refused
 * rather than followed: provisioning through it would place dsh's settings and
 * credentials wherever the link points, outside the path this module can vouch
 * for. An existing link to the right target is left alone; a link to somewhere
 * else is replaced (the harness home is ours to manage, and a stale target means
 * dsh gets no credentials); a real file or directory at that name is left
 * untouched, because it is not ours to delete — and when it is a real file it is
 * reported as the fork it is.
 */
export function ensureDshHome(options: DshHomeOptions = {}): DshHomeResult {
	const home = options.homeDir ?? dshHomeDir();
	const credentialsSource = options.credentialsSource ?? dshCredentialsSource();

	if (!existsSync(credentialsSource)) {
		return { ok: false, reason: `dsh has no credentials at ${credentialsSource}: ${DSH_SIGNIN_INSTRUCTION}` };
	}

	if (isSymlink(home)) {
		return {
			ok: false,
			reason: `the dsh harness home ${home} is a symlink; remove it so provisioning can create a real directory instead of writing through the link.`,
		};
	}

	try {
		// 0o700: the home holds dsh's settings and a credentials entry. The mode
		// applies to the directories mkdir creates; an existing home keeps its own.
		mkdirSync(home, { recursive: true, mode: 0o700 });
	} catch (err) {
		return { ok: false, reason: `could not create the dsh harness home ${home}: ${describe(err)}` };
	}

	const credentials = join(home, DSH_CREDENTIALS_LINK_NAME);
	try {
		const existing = lstatSync(credentials);
		if (existing.isSymbolicLink()) {
			if (readlinkSync(credentials) === credentialsSource) return { ok: true, home, credentials };
			unlinkSync(credentials);
		} else {
			// A real file or directory: the user's data, never deleted. A real FILE
			// is what dsh's atomic credential write leaves behind when it replaces
			// the link, so that case is reported as the fork it is.
			const warning = existing.isFile() ? dshCredentialsForkWarning(credentials, credentialsSource) : undefined;
			return { ok: true, home, credentials, ...(warning ? { warning } : {}) };
		}
	} catch {
		/* absent: create the link below */
	}

	const linked = linkDshCredentials(credentialsSource, credentials);
	return linked.ok ? { ok: true, home, credentials } : { ok: false, reason: linked.reason };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
