export interface ReconciliationLoopState {
	running: boolean;
	attempts: number;
	lastStartedAt: string | null;
	lastFinishedAt: string | null;
	lastError: string | null;
}

export function startReconciliationLoop(input: {
	reconcile: () => Promise<unknown>;
	intervalMs?: number;
	onState?: (state: ReconciliationLoopState) => void;
}) {
	const state: ReconciliationLoopState = { running: false, attempts: 0, lastStartedAt: null, lastFinishedAt: null, lastError: null };
	let stopped = false;
	const publish = () => input.onState?.({ ...state });
	const run = async () => {
		if (stopped || state.running) return;
		state.running = true;
		state.attempts += 1;
		state.lastStartedAt = new Date().toISOString();
		publish();
		try { await input.reconcile(); state.lastError = null; }
		catch (error) { state.lastError = error instanceof Error ? error.message : String(error); }
		finally { state.running = false; state.lastFinishedAt = new Date().toISOString(); publish(); }
	};
	const timer = setInterval(() => { void run(); }, input.intervalMs ?? 60_000);
	void run();
	return {
		state,
		stop() { stopped = true; clearInterval(timer); },
		run,
	};
}
