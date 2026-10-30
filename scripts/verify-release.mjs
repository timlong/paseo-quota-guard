import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = resolve(process.argv[2] ?? '.local/release');
const server = join(release, 'server');
const manifest = JSON.parse(readFileSync(join(server, 'quota-patch-manifest.json'), 'utf8'));
const expectedHashes = JSON.parse(readFileSync(new URL('../config/paseo-0.11.2-hashes.json', import.meta.url), 'utf8'));
const manifestFiles = manifest.files.map(f => f.file);
assert.equal(new Set(manifestFiles).size, manifestFiles.length, 'manifest 文件集合必须唯一');
assert.deepEqual([...manifestFiles].sort(), Object.keys(expectedHashes).sort(), 'manifest 文件集合必须恰为预期四个');
for (const f of manifest.files) {
  assert.equal(f.before, expectedHashes[f.file], `before 必须等于原文件哈希：${f.file}`);
  assert.equal(createHash('sha256').update(readFileSync(join(server, f.file))).digest('hex'), f.after, `after 必须等于实际文件哈希：${f.file}`);
}
const testHome = join(server, '.quota-verification');
const bridgeHome = mkdtempSync(join(tmpdir(), 'qgs-')); // Unix sockets have a short pathname limit.
mkdirSync(testHome, { recursive: true });
try {
  const { build } = await import(pathToFileURL(join(release, 'node_modules/esbuild/lib/main.js')).href);
  await build({ entryPoints: [join(server, 'dist/server/builtin-plugins/codex-usage-source/server/usage.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: {}, outfile: join(testHome, 'usage.mjs') });
  const { fetchUsage } = await import(pathToFileURL(join(testHome, 'usage.mjs')).href);
  const authPath = join(testHome, 'fake-auth.json');
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: 'TEST-ONLY-NOT-A-CREDENTIAL', account_id: 'test-account' } }));
  let now = 1000000000, calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } }));
  };
  const input = { route: { store: 'codex', path: authPath } };
  await assert.rejects(fetchUsage(input, mockFetch, { now: () => now }), /429/);
  await assert.rejects(fetchUsage(input, mockFetch, { now: () => now }), /cooling/);
  assert.equal(calls, 1, '冷却期不能再次请求');
  now += 120001;
  const usage = await fetchUsage(input, mockFetch, { now: () => now });
  assert.equal(usage.windows[0].id, 'five_hour'); assert.equal(calls, 2);

  // Claude 身份兜底补丁：profile 抖动不再生成无数据影子账户。
  process.env.PASEO_QUOTA_GUARD_HOME = testHome;
  await build({ entryPoints: [join(server, 'dist/server/builtin-plugins/claude-usage-source/server/usage.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: {}, outfile: join(testHome, 'claude-usage.mjs') });
  const { discover } = await import(pathToFileURL(join(testHome, 'claude-usage.mjs')).href);
  const credsHome = join(testHome, 'claude-creds'); mkdirSync(credsHome, { recursive: true });
  const credsPath = join(credsHome, '.credentials.json');
  const writeClaudeCreds = (accessToken, refreshToken, expiresAt) =>
    writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } }));
  const claudeScope = { kind: 'session', provider: 'claude', env: {} };
  const claudeLookup = { claudeHome: credsHome, now: () => 2000000000 };
  let claudeProfileMode = 'success';
  const claudeFetch = async (url) => {
    if (String(url).includes('/api/oauth/profile')) {
      if (claudeProfileMode === 'throw') throw new Error('profile unavailable');
      if (claudeProfileMode === 'status') return new Response('', { status: 401 });
      return new Response(JSON.stringify({ account: { uuid: 'acc-uuid', email: 'person@example.com' }, organization: { uuid: 'org-uuid' } }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const fallbackKey = (account) => createHash('sha256').update(JSON.stringify(account.input.route)).digest('hex');
  // 1) profile 成功得真实 key。
  writeClaudeCreds('at-1', 'rt-shared', undefined);
  claudeProfileMode = 'success';
  const [claudeOk] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeOk.key, 'acc-uuid.org-uuid'); assert.equal(claudeOk.label, 'person@example.com');
  // 模块重新加载（包括 daemon 重启）后，过期的同一凭据仍映射到已验证身份。
  const restartedClaude = await import(pathToFileURL(join(testHome, 'claude-usage.mjs')).href + '?restart');
  writeClaudeCreds('at-restarted', 'rt-shared', 2000000000 - 1);
  const [afterRestart] = await restartedClaude.discover(claudeScope, claudeLookup, async () => { throw Error('must not fetch expired credentials'); });
  assert.equal(afterRestart.key, claudeOk.key); assert.equal(afterRestart.label, claudeOk.label);
  // 2) 同一凭据（refreshToken 不变）下 profile 抛错仍得真实 key/label。
  writeClaudeCreds('at-2', 'rt-shared', undefined);
  claudeProfileMode = 'throw';
  const [claudeThrow] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeThrow.key, 'acc-uuid.org-uuid'); assert.equal(claudeThrow.label, 'person@example.com');
  // 3) profile 返回 status 仍得真实 key/label。
  writeClaudeCreds('at-3', 'rt-shared', undefined);
  claudeProfileMode = 'status';
  const [claudeStatus] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeStatus.key, 'acc-uuid.org-uuid'); assert.equal(claudeStatus.label, 'person@example.com');
  // 4) 凭据过期仍得真实 key/label。
  writeClaudeCreds('at-4', 'rt-shared', 2000000000 - 1);
  claudeProfileMode = 'throw';
  const [claudeExpired] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeExpired.key, 'acc-uuid.org-uuid'); assert.equal(claudeExpired.label, 'person@example.com');
  // 5) 更换 refreshToken 后 profile 失败得兜底哈希 key，且不沿用旧账户。
  writeClaudeCreds('at-5', 'rt-changed', undefined);
  claudeProfileMode = 'throw';
  const [claudeChanged] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeChanged.key, fallbackKey(claudeChanged)); assert.equal(claudeChanged.label, undefined);
  // 5.5) 空/空白 refreshToken：指纹回退 accessToken，避免换号串号。
  writeClaudeCreds('at-empty-A', '', undefined);
  claudeProfileMode = 'success';
  const [claudeEmptyA] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeEmptyA.key, 'acc-uuid.org-uuid');
  writeClaudeCreds('at-empty-B', '   ', undefined);
  claudeProfileMode = 'throw';
  const [claudeEmptyB] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeEmptyB.key, fallbackKey(claudeEmptyB), '空白 refreshToken 换号后必须回退兜底哈希而非沿用 A');
  assert.equal(claudeEmptyB.label, undefined);
  // 5.6) 两者都为空（accessToken 也为空白）：不读写缓存，直接原兜底。
  writeClaudeCreds('   ', '   ', undefined);
  claudeProfileMode = 'success';
  const [claudeBothEmptyOk] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeBothEmptyOk.key, 'acc-uuid.org-uuid');
  writeClaudeCreds('    ', '   ', undefined);
  claudeProfileMode = 'throw';
  const [claudeBothEmptyThrow] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeBothEmptyThrow.key, fallbackKey(claudeBothEmptyThrow), '两者为空不读写缓存');
  // 6) 缓存有界：填满 64 条后清空，旧指纹回到兜底哈希。
  for (let i = 0; i < 65; i++) {
    writeClaudeCreds('at-fill', `rt-fill-${i}`, undefined);
    claudeProfileMode = 'success';
    await discover(claudeScope, claudeLookup, claudeFetch);
  }
  writeClaudeCreds('at-evict', 'rt-shared', 2000000000 - 1);
  claudeProfileMode = 'throw';
  const [claudeEvicted] = await discover(claudeScope, claudeLookup, claudeFetch);
  assert.equal(claudeEvicted.key, fallbackKey(claudeEvicted));

  process.env.PASEO_QUOTA_GUARD_HOME = testHome;
  process.env.PASEO_QUOTA_GUARD_MODE = 'enforce';
  const { wrapSessionProvider } = await import(pathToFileURL(join(server, 'dist/server/server/agent/provider-registry.js')).href);
  let dispatched = 0;
  const inner = { id: 'test', usageSession: () => ({ provider: 'claude', env: {}, sessionKey: 'test' }), run: async () => { dispatched++; }, close: async () => {} };
  const wrapped = wrapSessionProvider('claude', inner);
  await assert.rejects(wrapped.run('test'), /尚未就绪/); assert.equal(dispatched, 0);
  process.env.PASEO_QUOTA_GUARD_MODE = 'observe';
  await wrapped.run('test'); assert.equal(dispatched, 1);
  await wrapped.close();
  const { CodexAppServerAgentSession } = await import(pathToFileURL(join(server, 'dist/server/server/agent/providers/codex-app-server-agent.js')).href);
  const codexProto = CodexAppServerAgentSession.prototype;
  const codexInner = { parseSlashCommandInput: codexProto.parseSlashCommandInput, goalsEnabled: false, tryHandleOutOfBand: codexProto.tryHandleOutOfBand };
  const codexSession = wrapSessionProvider('codex', codexInner);
  const plain = codexSession.tryHandleOutOfBand('普通输入'); assert.equal(plain, null); assert.ok(!(plain instanceof Promise));
  const compact = codexSession.tryHandleOutOfBand('/compact'); assert.ok(compact && typeof compact.run === 'function'); assert.ok(!(compact instanceof Promise));

  // Exercise the installed provider's actual task protocol, including aliases and
  // nested tasks, against the bridge shipped in this candidate. No CLI/model runs.
  const { ClaudeTaskProtocolSource } = await import(pathToFileURL(join(server,
    'dist/server/server/agent/providers/claude/subagents/live-source.js')).href);
  const { startBridge } = await import(pathToFileURL(join(release, 'guard/bridge.mjs')).href);
  const { call } = await import(pathToFileURL(join(release, 'guard/ipc.mjs')).href);
  const protocol = new ClaudeTaskProtocolSource();
  const descriptors = new Map();
  const apply = observations => {
    for (const o of observations) {
      if (o.kind === 'declared') descriptors.set(o.id, { id: o.id, status: 'running' });
      if (o.kind === 'status') descriptors.get(o.id).status = o.status;
    }
  };
  const started = (task_id, tool_use_id) => ({ type: 'system', subtype: 'task_started',
    task_id, tool_use_id, task_type: 'local_agent', subagent_type: 'general-purpose', is_backgrounded: true });
  apply(protocol.observe(started('native-parent', 'toolu_parent')));
  apply(protocol.observe(started('native-parent', 'toolu_alias')));
  protocol.ownerSubagentIdByToolUseId.set('toolu_nested', 'toolu_parent');
  apply(protocol.observe(started('native-nested', 'toolu_nested')));
  const stopped = [];
  const native = {
    usageSession: () => ({ provider: 'claude', sessionKey: 'stop-verification', env: {} }),
    taskProtocolSource: protocol, mainTurnInFlight: false, async interrupt() {},
    query: { async stopTask(id) {
      assert.ok(['native-parent', 'native-nested'].includes(id), 'stopTask 必须使用原生任务 ID');
      stopped.push(id);
      apply(protocol.observe({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped' }));
    } },
    async close() {},
  };
  const guarded = wrapSessionProvider('claude', native);
  const bridge = await startBridge({ home: bridgeHome, mode: 'enforce', paseoHome: bridgeHome, serverId: 'test',
    manager: { agents: new Map([['agent', { id: 'agent', provider: 'claude', session: guarded }]]),
      providerSubagents: { list: () => [...descriptors.values()] } },
    runtime: { listUsageReports: async () => [{ id: 'claude:test', sourceId: 'claude' }] }, watchdogMs: 100000 });
  try {
    const result = await call(join(bridgeHome, 'paseo.sock'), '/interrupt', { accountId: 'claude:test' });
    assert.equal(result.complete, true); assert.deepEqual(result.pending, []); assert.deepEqual(result.failures, []);
    assert.deepEqual(stopped.sort(), ['native-nested', 'native-parent']);
    assert.ok([...descriptors.values()].every(d => d.status === 'canceled'));
  } finally { await bridge.close(); await guarded.close(); }
  console.log('Release 验证通过：4 个文件哈希、真实 provider 包装入口、Codex 冷却与带外契约、Claude 身份缓存及原生后台/嵌套任务停止路由。未调用真实模型或额度 API。');
} finally {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
}
