import { chmodSync,cpSync,existsSync,mkdirSync,rmSync,symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const destination = resolve(root, '.treeseed/package/treeseed-ai_0.1.0_amd64');
if (!existsSync(resolve(root, 'dist/cli/main.js'))) throw new Error('Run npm run build before packaging the Debian artifact.');
rmSync(destination, { recursive: true, force: true });
mkdirSync(resolve(destination, 'DEBIAN'), { recursive: true });
mkdirSync(resolve(destination, 'usr/lib/treeseed-ai'), { recursive: true });
mkdirSync(resolve(destination, 'usr/bin'), { recursive: true });
mkdirSync(resolve(destination, 'lib/systemd/system'), { recursive: true });
mkdirSync(resolve(destination, 'etc/treeseed/ai/providers'), { recursive: true });
mkdirSync(resolve(destination, 'etc/treeseed/ai/opencode'), { recursive: true });
cpSync(resolve(root, 'debian/control'), resolve(destination, 'DEBIAN/control'));
for (const script of ['postinst', 'prerm']) { cpSync(resolve(root, `debian/${script}`), resolve(destination, `DEBIAN/${script}`)); chmodSync(resolve(destination, `DEBIAN/${script}`), 0o755); }
for (const entry of ['dist', 'package.json', 'package-lock.json', 'compose.ai.yml']) cpSync(resolve(root, entry), resolve(destination, 'usr/lib/treeseed-ai', entry), { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'], {
	cwd: resolve(destination, 'usr/lib/treeseed-ai'), stdio: 'inherit',
});
chmodSync(resolve(destination, 'usr/lib/treeseed-ai/dist/cli/main.js'), 0o755);
symlinkSync('../lib/treeseed-ai/dist/cli/main.js', resolve(destination, 'usr/bin/treeseed-ai'));
cpSync(resolve(root, 'systemd/treeseed-ai.service'), resolve(destination, 'lib/systemd/system/treeseed-ai.service'));
cpSync(resolve(root, 'treeseed.ai-appliance.yaml'), resolve(destination, 'etc/treeseed/ai/treeseed.ai-appliance.yaml'));
cpSync(resolve(root, 'config/providers/agent.yaml'), resolve(destination, 'etc/treeseed/ai/providers/agent.yaml'));
cpSync(resolve(root, 'config/providers/platform-operation.yaml'), resolve(destination, 'etc/treeseed/ai/providers/platform-operation.yaml'));
cpSync(resolve(root, 'config/opencode/opencode.json'), resolve(destination, 'etc/treeseed/ai/opencode/opencode.json'));
execFileSync('dpkg-deb', ['--build', '--root-owner-group', destination], { stdio: 'inherit' });
