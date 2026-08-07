import { describe,expect,it,vi } from 'vitest';
import { startReconciliationLoop } from '../../src/runtime/supervisor.ts';

describe('appliance reconciliation supervisor', () => {
	it('runs immediately, records failure, and recovers without overlapping attempts', async () => {
		let release: (() => void) | undefined;
		const reconcile = vi.fn()
			.mockRejectedValueOnce(new Error('gpu unavailable'))
			.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		const loop = startReconciliationLoop({ reconcile, intervalMs: 60_000 });
		await vi.waitFor(() => expect(loop.state.lastError).toBe('gpu unavailable'));
		const second = loop.run();
		await vi.waitFor(() => expect(loop.state.running).toBe(true));
		await loop.run();
		expect(reconcile).toHaveBeenCalledTimes(2);
		release?.();
		await second;
		expect(loop.state.lastError).toBeNull();
		loop.stop();
	});
});
