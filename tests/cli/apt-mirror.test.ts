import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

describe('APT suite mirroring',()=>{
	it('retries bounded transient transport and HTTP failures',()=>{
		const script=readFileSync('scripts/release/mirror-apt-suite.sh','utf8');
		expect(script).toContain('--retry 5');
		expect(script).toContain('--retry-delay 2');
		expect(script).toContain('--retry-max-time 45');
		expect(script).toContain('--retry-all-errors');
		expect(script.match(/\bcurl\b/gu)).toHaveLength(1);
		expect(script).toContain('gpg --batch');
		expect(script).toContain('cmp "$temporary/signed-release" "$target_root/Release"');
	});
});
