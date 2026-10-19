// Read-only status/plugin fetch via plugin RPC. Never calls /refresh and never mutates settings.
import assert from 'node:assert/strict';
import { connectToDaemon } from '/home/qingteng/.local/lib/node_modules/@getpaseo/cli/dist/utils/client.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  if (hit === undefined) return undefined;
  const value = hit.slice(prefix.length);
  if (!value) throw new Error(`参数 --${name} 缺少值`);
  return value;
}
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--expected-enabled=') && !a.startsWith('--expected-plugin-path=')) {
    throw new Error('未知参数: ' + a);
  }
}
const expectedEnabled = argValue('expected-enabled');
const expectedPluginPath = argValue('expected-plugin-path');
if (expectedEnabled !== undefined && expectedEnabled !== 'true' && expectedEnabled !== 'false') {
  throw new Error('--expected-enabled 必须为 true 或 false');
}

const client = await connectToDaemon({ target: { kind: 'instance', home: '/home/qingteng/.paseo' } });
try {
  const status = await client.invokePluginRpc('quota-guard', 'quota.control', { action: 'status' });
  assert.equal(typeof status.enabled, 'boolean', 'enabled 非布尔');
  if (expectedEnabled !== undefined) assert.equal(String(status.enabled), expectedEnabled, 'enabled 与预期不符');
  const plugins = await client.listPlugins();
  const qg = plugins.find(p => p.id === 'quota-guard');
  assert.ok(qg, 'quota-guard 插件未列出');
  if (expectedPluginPath !== undefined) {
    assert.equal(qg.path, expectedPluginPath, 'quota-guard 插件路径不符');
    assert.equal(qg.status, 'running', 'quota-guard 插件未运行');
  }
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), mode: status.mode, bridgeMode: status.bridgeMode,
    enabled: status.enabled, notifications: status.notifications, thresholds: status.thresholds,
    settingsRevision: status.settingsRevision, lastError: status.lastError ?? null,
    pluginPath: qg.path, pluginStatus: qg.status }));
} finally { await client.close(); }
