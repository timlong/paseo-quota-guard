// Asks the production guard to poll the Paseo bridge now instead of waiting for its idle interval.
// Used by upgrade-production.py right after a restart. Does not change settings; exit 2 if the guard is unreachable.
import { call } from '../src/ipc.mjs';

try {
  const s = await call('/home/qingteng/.local/state/paseo-quota-guard/guard.sock', '/refresh', {}, 80000);
  console.log(JSON.stringify({ ok: true, mode: s.mode ?? null }));
} catch {
  console.log(JSON.stringify({ ok: false }));
  process.exitCode = 2;
}
