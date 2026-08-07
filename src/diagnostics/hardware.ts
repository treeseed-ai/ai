import { execFileSync } from 'node:child_process';
import { existsSync,readFileSync,readdirSync,statfsSync } from 'node:fs';
import { totalmem } from 'node:os';

export type HardwareCheck = { id: string; status: 'ready' | 'warning' | 'blocked'; summary: string; observed?: unknown; repair?: string };

function command(file: string, args: string[] = []) {
	try { return execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function memoryGiB(bytes: number) { return Math.round(bytes / 1024 ** 3 * 10) / 10; }

export function inspectHardware(root = '/') {
	const virtualization = command('systemd-detect-virt') || 'none';
	const docker = command('docker', ['--version']);
	const compose = command('docker', ['compose', 'version']);
	const gpu = command('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader']);
	const iommu = existsSync('/sys/kernel/iommu_groups') && readdirSync('/sys/kernel/iommu_groups').length > 0;
	let diskGiB = 0;
	try { const disk = statfsSync(root); diskGiB = memoryGiB(disk.bavail * disk.bsize); } catch { /* reported below */ }
	const checks: HardwareCheck[] = [
		{ id: 'memory', status: totalmem() >= 16 * 1024 ** 3 ? 'ready' : 'warning', summary: `${memoryGiB(totalmem())} GiB system memory`, observed: { gib: memoryGiB(totalmem()) }, repair: 'Use at least 16 GiB system RAM; 32 GiB is recommended for model loading and container overhead.' },
		{ id: 'disk', status: diskGiB >= 30 ? 'ready' : 'warning', summary: `${diskGiB} GiB free storage`, observed: { gib: diskGiB }, repair: 'Provide at least 30 GiB free for images, model weights, and runtime state.' },
		{ id: 'docker', status: docker && compose ? 'ready' : 'blocked', summary: docker && compose ? `${docker}; ${compose}` : 'Docker Engine with Compose v2 is unavailable.', repair: 'Install Docker Engine and the Compose v2 plugin, then grant the appliance service access.' },
		{ id: 'gpu', status: gpu ? 'ready' : 'blocked', summary: gpu || 'No NVIDIA GPU is visible to this operating system.', repair: virtualization !== 'none' ? 'Configure GPU PCI passthrough, IOMMU/VFIO, a compatible guest driver, and NVIDIA Container Toolkit.' : 'Install a compatible NVIDIA driver and NVIDIA Container Toolkit.' },
		{ id: 'virtualization', status: virtualization === 'none' || gpu ? 'ready' : 'warning', summary: virtualization === 'none' ? 'Bare metal' : `Virtualized with ${virtualization}`, observed: { provider: virtualization, iommu }, repair: 'Verify that the hypervisor exposes the complete GPU PCI function and that IOMMU groups are available to the guest.' },
	];
	const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
	return { ready: checks.every((entry) => entry.status !== 'blocked'), checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, osRelease, checks };
}
