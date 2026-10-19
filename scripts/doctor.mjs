import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { call } from '../src/ipc.mjs';
import { validateConfig } from '../src/policy.mjs';

const cfg = process.env.QUOTA_GUARD_CONFIG ?? new URL('../config/default.json', import.meta.url);
const config = validateConfig(JSON.parse(readFileSync(cfg, 'utf8')));
const executable = realpathSync(execFileSync('which', ['paseo'], { encoding: 'utf8' }).trim());
const cliRoot = resolve(dirname(executable), '..');
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
const source = join(cliRoot, 'node_modules/@getpaseo/server');
const hashes = JSON.parse(readFileSync(new URL('../config/paseo-0.11.2-hashes.json', import.meta.url), 'utf8'));
const compatibility = Object.entries(hashes).every(([p, hash]) => existsSync(join(source, p)) && createHash('sha256').update(readFileSync(join(source, p))).digest('hex') === hash);
const home = process.env.QUOTA_GUARD_HOME ?? join(homedir(), '.local/state/paseo-quota-guard');
const output = { node: process.version, paseo: pkg.version, patchCompatible: compatibility, config: {
  mode: config.mode, thresholds: config.thresholds, windowPolicy: config.windowPolicy, notifications: config.notifications },
  guard: 'not_connected', bridge: 'not_connected' };
for (const [name, socket] of [['guard','guard.sock'],['bridge','paseo.sock']]) {
  try { output[name] = await call(join(home, socket), '/health', {}, 1500); } catch {}
}
if (process.argv.includes('--live')) {
  const { connectToDaemon } = await import(pathToFileURL(join(cliRoot, 'dist/utils/client.js')).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home: process.env.PASEO_HOME ?? join(homedir(), '.paseo') } });
  try {
    const result = await client.listUsageReports({});
    output.usage = result.reports.filter(r => ['claude','codex'].includes(r.sourceId)).map(r => ({
      provider: r.sourceId, status: r.report.status, fetchedAt: r.fetchedAt,
      windows: r.report.windows?.filter(w => ['five_hour','weekly'].includes(w.id)).map(w => ({ id: w.id, usedPct: w.usedPct })),
      problem: r.report.problem?.kind,
    }));
  } finally { await client.close(); }
}
console.log(JSON.stringify(output, null, 2));
if (!compatibility) process.exitCode = 1;
