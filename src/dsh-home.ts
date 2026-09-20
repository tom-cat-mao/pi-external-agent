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

export type DshHomeResult = { ok: true; home: string; credentials: string } | { ok: false; reason: string };

/** The harness home for the current user; the value handed to dsh as DSH_HOME. */
export function dshHomeDir(): string {
	return join(homedir(), DSH_HARNESS_HOME_NAME);
}

/** The user's dsh credentials file, as written by `dsh web`. */
export function dshCredentialsSource(): string {
	return join(homedir(), ".dsh", DSH_CREDENTIALS_LINK_NAME);
}

/**
 * Lazy, idempotent provisioning, called on every dsh spawn: create the harness
 * home when it is missing, and make sure `.credentials.yaml` is a symlink to
 * the user's credentials.
 *
 * The source is checked first so a failure leaves nothing behind — a dangling
 * link would only hide the missing sign-in. An existing link to the right
 * target is left alone; a link to somewhere else is replaced (the harness home
 * is ours to manage, and a stale target means dsh gets no credentials); a real
 * file or directory at that name is left untouched, because it is not ours to
 * delete.
 */
export function ensureDshHome(options: DshHomeOptions = {}): DshHomeResult {
	const home = options.homeDir ?? dshHomeDir();
	const credentialsSource = options.credentialsSource ?? dshCredentialsSource();

	if (!existsSync(credentialsSource)) {
		return { ok: false, reason: `dsh has no credentials at ${credentialsSource}: ${DSH_SIGNIN_INSTRUCTION}` };
	}

	try {
		mkdirSync(home, { recursive: true });
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
			// A real file or directory: the user's own arrangement, never deleted.
			return { ok: true, home, credentials };
		}
	} catch {
		/* absent: create the link below */
	}

	try {
		symlinkSync(credentialsSource, credentials);
	} catch (err) {
		return { ok: false, reason: `could not link ${credentials} to ${credentialsSource}: ${describe(err)}` };
	}
	return { ok: true, home, credentials };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
