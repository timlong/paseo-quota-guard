// Validates a guard config with the target release's own validateConfig before services are switched.
// Usage: node check-guard-config.mjs <releaseDir> <configPath>. Never prints config contents.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [release, configPath] = process.argv.slice(2);
try {
  const { validateConfig } = await import(pathToFileURL(join(release, 'guard/policy.mjs')).href);
  validateConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  console.log(JSON.stringify({ ok: true }));
} catch {
  console.log(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
