// Read-only probe for upgrade-production.py: prints raw status and plugin fields; validation happens in Python.
// The two RPCs are collected independently so a partial result is never discarded.
// Never calls /refresh or mutates settings. Exit 2 means the daemon could not be reached at all.
import { connectToDaemon } from '/home/qingteng/.local/lib/node_modules/@getpaseo/cli/dist/utils/client.js';

const attempt = async fn => { try { return { value: await fn() }; } catch { return { error: true }; } };
let client;
try {
  client = await connectToDaemon({ target: { kind: 'instance', home: '/home/qingteng/.paseo' } });
} catch {
  console.log(JSON.stringify({ transportError: true }));
  process.exit(2);
}
try {
  const s = await attempt(() => client.invokePluginRpc('quota-guard', 'quota.control', { action: 'status' }));
  const p = await attempt(async () => (await client.listPlugins()).find(x => x.id === 'quota-guard') ?? null);
  const status = s.value && typeof s.value === 'object' ? s.value : null;
  console.log(JSON.stringify({
    statusError: Boolean(s.error), pluginError: Boolean(p.error),
    status: status && { mode: status.mode, bridgeMode: status.bridgeMode, enabled: status.enabled,
      notifications: status.notifications, thresholds: status.thresholds, settingsRevision: status.settingsRevision },
    plugin: p.value ? { path: p.value.path, status: p.value.status } : null,
  }));
} finally { await client.close().catch(() => {}); }
