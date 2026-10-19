import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, call } from '../src/ipc.mjs';
import { startService } from '../src/main.mjs';
import { config, report } from '../test/helpers.mjs';

const home = mkdtempSync(join(tmpdir(), 'quota-demo-'));
let values = { claude: 79, codex: 89 }; const events = []; let service;
const bridge = await serve(join(home, 'paseo.sock'), async (path, body) => {
  if (path === '/snapshot') return { mode:'enforce', reports: Object.entries(values).map(([p,n]) => report(p,n,1)), agents: [{ id: 'demo', running: true }] };
  if (path === '/interrupt') { events.push({ type: 'interrupt', account: body.accountId }); return { complete: true, pending: [] }; }
  if (path === '/push') { events.push({ type: 'simulated_push', kind: body.kind, title: body.title }); return { accepted: true }; }
  return { ok: true };
});
try {
  service = await startService({ home, config: config({ notifications: true }), bridgePath: join(home, 'paseo.sock') });
  for (const v of [{ claude:80,codex:90 }, { claude:90,codex:95 }, { claude:1,codex:1 }]) { values = v; await service.tick(true); }
  await call(join(home,'guard.sock'),'/resume',{accountId:'claude:a'});
  const result = { simulated: true, realModelsCalled: false, realPushSent: false, events, status: service.engine.status() };
  mkdirSync('.local/reports', { recursive: true });
  writeFileSync('.local/reports/demo.json', JSON.stringify(result,null,2));
  console.log(JSON.stringify({ simulated:true, events, accounts:result.status.accounts.map(a=>({provider:a.provider,locked:a.locked,ready:a.ready})) },null,2));
} finally { await service?.close(); await bridge.close(); rmSync(home,{recursive:true,force:true}); }
