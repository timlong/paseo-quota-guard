// Explicitly used by the user-authorized production rollout, never by npm test.
import assert from 'node:assert/strict';
import { connectToDaemon } from '/home/qingteng/.local/lib/node_modules/@getpaseo/cli/dist/utils/client.js';
import { call } from '../src/ipc.mjs';
const home = '/home/qingteng/.local/state/paseo-quota-guard';
const client = await connectToDaemon({ target: { kind: 'instance', home: '/home/qingteng/.paseo' } });
try {
  await call(`${home}/guard.sock`, '/refresh', {}, 60000);
  const rpc = input => client.invokePluginRpc('quota-guard', 'quota.control', input);
  let status = await rpc({ action: 'status' });
  assert.equal(status.mode, 'enforce'); assert.equal(status.bridgeMode, 'enforce'); assert.equal(status.lastError, null);
  for (const provider of ['claude', 'codex']) {
    const accounts = status.accounts.filter(a => a.provider === provider);
    assert.ok(accounts.length > 0, `${provider}: no usage account`);
    for (const account of accounts) {
      assert.equal(account.error, null); assert.notEqual(account.assessment.level, 'unknown');
      assert.ok(account.windows.length > 0);
    }
  }
  assert.equal(status.agents.some(a => a.protection === 'unmapped'), false, 'Unmapped native session');
  if (process.argv.includes('--activate')) {
    await rpc({ action: 'settings', settings: { revision: status.settingsRevision, enabled: true,
      notifications: true, thresholds: status.thresholds } });
    status = await rpc({ action: 'status' });
    assert.equal(status.enforcementReady, true); assert.equal(status.enabled, true);
  }
  const plugins = await client.listPlugins();
  assert.ok(plugins.some(p => p.id === 'quota-guard'), 'Plugin missing');
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), pluginRpc: true,
    mode: status.mode, bridgeMode: status.bridgeMode, enabled: status.enabled, enforcementReady: status.enforcementReady,
    notifications: status.notifications, thresholds: status.thresholds,
    accounts: status.accounts.map(a => ({ provider: a.provider, windows: a.windows, locked: a.locked, error: a.error })),
    mappedSessions: status.agents.length }));
} finally { await client.close(); }
