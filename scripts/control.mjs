import { join } from 'node:path';
import { homedir } from 'node:os';
import { call } from '../src/ipc.mjs';
const [action = 'status', accountId] = process.argv.slice(2);
if (!['status', 'refresh', 'pause', 'resume', 'test-push'].includes(action)) throw new Error('用法：control.mjs status|refresh|pause|resume|test-push [accountId]');
const home = process.env.QUOTA_GUARD_HOME ?? join(homedir(), '.local/state/paseo-quota-guard');
console.log(JSON.stringify(await call(join(home, 'guard.sock'), `/${action}`, { accountId }, 60000), null, 2));
