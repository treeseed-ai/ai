import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const executableExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignored = new Set(['.git', 'coverage', 'dist', 'node_modules']);

function filesBelow(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (ignored.has(entry.name)) return [];
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

const files = filesBelow(root);
const handwritten = files.filter((path) => executableExtensions.has(extname(path)));
const oversized = handwritten.filter((path) => readFileSync(path, 'utf8').split(/\r?\n/u).length > 500);
if (oversized.length) throw new Error(`Handwritten files exceed 500 lines: ${oversized.map((path) => relative(root, path)).join(', ')}`);

const forbidden = files.filter((path) => {
	const name = relative(root, path);
	return !name.startsWith('dist/') && (name.endsWith('.js') || name.endsWith('.d.ts'));
});
if (forbidden.length) throw new Error(`Checked-in JavaScript or declarations are forbidden: ${forbidden.map((path) => relative(root, path)).join(', ')}`);

const counts = new Map<string, number>();
for (const path of handwritten) {
	const directory = relative(root, join(path, '..'));
	counts.set(directory, (counts.get(directory) ?? 0) + 1);
}
const crowded = [...counts].filter(([, count]) => count > 10);
if (crowded.length) throw new Error(`Executable directories exceed ten files: ${crowded.map(([directory]) => directory).join(', ')}`);

for (const path of handwritten) statSync(path);
