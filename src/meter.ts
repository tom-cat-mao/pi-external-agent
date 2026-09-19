/**
 * Usage meter — session-scoped, in-memory accounting of what the target CLIs
 * themselves reported.
 *
 * Every number here is **as reported by the target CLI; not billing.** The
 * extension never estimates tokens and never prices them: a field the CLI did
 * not report stays absent in the aggregate instead of becoming a zero, so
 * "unknown" and "reported zero" never collapse into each other. The
 * claude-family adapters are the ones that self-report a cost today
 * (`total_cost_usd`); for every other CLI `costUsd` is simply absent.
 *
 * Pure module: no pi imports, no I/O, no timers. Wiring into the hub (dispatch
 * time, settle time, the stats command) belongs to index.ts.
 */

/**
 * One CLI-reported sample. Numeric fields are optional and independent: a CLI
 * may report tokens but no cost, or only some token kinds.
 */
export interface UsageSample {
	/** Input (prompt-side) tokens, as reported by the target CLI; not billing. */
	in?: number;
	/** Output (completion-side) tokens, as reported by the target CLI; not billing. */
	out?: number;
	/** Cached input tokens the target CLI reported reusing; not billing. */
	cached?: number;
	/** Cost in USD as reported by the target CLI; not billing. Absent unless the CLI self-reported it. */
	costUsd?: number;
	/** Which CLI reported the sample (an AgentId in practice; a plain string keeps this module pi-free). */
	source: string;
}

/** Accumulated usage: per-field sums over the samples folded in. */
export interface UsageTotals {
	in?: number;
	out?: number;
	cached?: number;
	/** Sum of CLI self-reported USD costs; not billing. Absent when no sample carried a cost. */
	costUsd?: number;
	/** Distinct sources that contributed, in first-seen order. */
	sources: string[];
	/** How many samples were folded in. */
	samples: number;
}

export interface MeterSnapshot {
	/** Per-task totals, keyed by the taskId passed to record/recordDispatch. */
	tasks: Record<string, UsageTotals>;
	/** Lifetime totals across every task. */
	totals: UsageTotals;
	/** Distinct tasks dispatched (see recordDispatch). */
	dispatchTotal: number;
	/** Refusals by reason label, e.g. { "mode above maxMode": 2 }. */
	refusedTotal: Record<string, number>;
}

export interface Meter {
	/** Fold one CLI-reported sample into that task's bucket and into the lifetime totals. */
	record(taskId: string, sample: UsageSample): void;
	/** Deep copy of the counters; safe to mutate and to hold onto. */
	snapshot(): MeterSnapshot;
	/**
	 * Count a dispatch. Idempotent per taskId — the counter reads as "tasks
	 * dispatched", so a re-record or retry path cannot inflate it, and the same
	 * task's usage keeps accumulating into one bucket.
	 */
	recordDispatch(taskId: string): void;
	/** Count a refused dispatch under its reason label. */
	recordRefused(reason: string): void;
}

function emptyTotals(): UsageTotals {
	return { sources: [], samples: 0 };
}

/** Sum only the fields the sample actually carries; absent stays absent. */
function addSample(totals: UsageTotals, sample: UsageSample): void {
	if (!totals.sources.includes(sample.source)) totals.sources.push(sample.source);
	totals.samples += 1;
	if (typeof sample.in === "number") totals.in = (totals.in ?? 0) + sample.in;
	if (typeof sample.out === "number") totals.out = (totals.out ?? 0) + sample.out;
	if (typeof sample.cached === "number") totals.cached = (totals.cached ?? 0) + sample.cached;
	if (typeof sample.costUsd === "number") totals.costUsd = (totals.costUsd ?? 0) + sample.costUsd;
}

/** Spread keeps the exact key set (no undefined-valued keys), so copies compare cleanly. */
function copyTotals(totals: UsageTotals): UsageTotals {
	return { ...totals, sources: [...totals.sources] };
}

export function createMeter(): Meter {
	const tasks = new Map<string, UsageTotals>();
	const totals = emptyTotals();
	const dispatched = new Set<string>();
	const refused = new Map<string, number>();

	return {
		record(taskId, sample) {
			let bucket = tasks.get(taskId);
			if (!bucket) {
				bucket = emptyTotals();
				tasks.set(taskId, bucket);
			}
			addSample(bucket, sample);
			addSample(totals, sample);
		},
		snapshot() {
			const copies: Record<string, UsageTotals> = {};
			for (const [taskId, bucket] of tasks) copies[taskId] = copyTotals(bucket);
			return {
				tasks: copies,
				totals: copyTotals(totals),
				dispatchTotal: dispatched.size,
				refusedTotal: Object.fromEntries(refused),
			};
		},
		recordDispatch(taskId) {
			dispatched.add(taskId);
		},
		recordRefused(reason) {
			refused.set(reason, (refused.get(reason) ?? 0) + 1);
		},
	};
}
