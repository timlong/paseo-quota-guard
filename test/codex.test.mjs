import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexRpc, summarize, readCredits, consumeCredit } from '../src/codex-account.mjs';
import { startService } from '../src/main.mjs';
import { serve, call } from '../src/ipc.mjs';
import { config, report } from './helpers.mjs';

const NOW = 1_800_000_000_000;
const REQUEST_KEY = '00000000-0000-4000-8000-000000000001';
const resetRequest = (creditId = 'c-late', requestId = 'request-0001') => ({ accountId: 'codex:acct-1', creditId, requestId });
const credit = (id, expiresSec, status = 'available') =>
  ({ id, resetType: 'codexRateLimits', status, grantedAt: 1_790_000_000, expiresAt: expiresSec, title: 'Full reset', description: null });
const readResult = (extra = {}) => ({
  ordinaryUsageAllowed: true, accountId: 'acct-1',
  rateLimits: { planType: 'pro', rateLimitReachedType: null, credits: { hasCredits: true, unlimited: false, balance: '62500.0000000000' } },
  rateLimitResetCredits: { availableCount: 3, credits: [credit('c-late', 1_800_900_000), credit('c-early', 1_800_100_000), credit('c-used', 1_800_050_000, 'redeemed')] },
  ...extra,
});

test('summarize：仅保留可用且未过期的卡，按到期时间排序；触顶只看后端信号', () => {
  const s = summarize(readResult(), NOW);
  assert.deepEqual(s.credits.map(c => c.id), ['c-early', 'c-late']);
  assert.equal(s.credits[0].expiresAt, 1_800_100_000_000);
  assert.equal(s.availableCount, 3);
  assert.equal(s.planType, 'pro');
  assert.equal(s.creditBalance, 62500);
  assert.equal(s.limitReached, false);
  assert.equal(summarize(readResult({ ordinaryUsageAllowed: false }), NOW).limitReached, true);
  assert.equal(summarize(readResult({ rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }), NOW).limitReached, true);
  assert.deepEqual(summarize(readResult(), 1_800_200_000_000).credits.map(c => c.id), ['c-late'], '过期卡不列出');
  assert.throws(() => summarize(null));
});

function fakeAppServer(t, behavior) {
  const dir = mkdtempSync(join(tmpdir(), 'qg-codex-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'requests.jsonl'), bin = join(dir, 'codex');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); let buf = '';
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
  const reply = (${behavior.toString()})(m); if (reply) process.stdout.write(JSON.stringify({ id: m.id, ...reply }) + '\\n'); } });
`);
  chmodSync(bin, 0o755);
  return { bin, requests: () => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

test('codexRpc：完成 initialize 握手后发送请求；读取与使用重置卡', async t => {
  const fake = fakeAppServer(t, m => m.method === 'initialize' ? { result: {} }
    : m.method === 'account/rateLimits/read' ? { result: { ordinaryUsageAllowed: false, accountId: 'acct-1', rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: [] } } }
    : m.method === 'account/rateLimitResetCredit/consume' ? { result: { outcome: 'reset' } } : null);
  const s = await readCredits(fake.bin, 5000);
  assert.equal(s.accountId, 'acct-1'); assert.equal(s.limitReached, true);
  assert.equal(await consumeCredit(fake.bin, 'c-1', REQUEST_KEY, 5000), 'reset');
  const reqs = fake.requests();
  assert.deepEqual(reqs.map(r => r.method), ['initialize', 'initialized', 'account/rateLimits/read', 'initialize', 'initialized', 'account/rateLimitResetCredit/consume']);
  const consume = reqs.at(-1).params;
  assert.equal(consume.creditId, 'c-1');
  assert.equal(consume.idempotencyKey, REQUEST_KEY);
});

test('codexRpc：错误、无效结果与超时都会失败且不挂起', async t => {
  const failing = fakeAppServer(t, m => m.method === 'initialize' ? { result: {} } : { error: { code: -1, message: 'secret detail' } });
  await assert.rejects(codexRpc(failing.bin, 'account/rateLimits/read', {}, 5000), /Codex 拒绝了请求/);
  const weird = fakeAppServer(t, m => m.method === 'initialize' ? { result: {} } : { result: { outcome: 'boom' } });
  await assert.rejects(consumeCredit(weird.bin, 'c-1', REQUEST_KEY, 5000), /结果无效/);
  const silent = fakeAppServer(t, () => null);
  await assert.rejects(codexRpc(silent.bin, 'account/rateLimits/read', {}, 300), /超时/);
  await assert.rejects(codexRpc('/nonexistent/codex', 'x', {}, 2000), /无法启动|意外退出/);
});

async function service(t, codex) {
  const home = mkdtempSync(join(tmpdir(), 'qg-codex-svc-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexReport = { ...report('codex', 10, 10, NOW, 'x'), id: 'codex:acct-1' };
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [codexReport], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    return { accepted: true };
  });
  t.after(() => bridge.close());
  const start = () => startService({ home, config: config({ windowPolicy: { claude: 'both', codex: 'available' } }), bridgePath: join(home, 'paseo.sock'), codex, now: () => NOW });
  let svc = await start();
  t.after(() => svc.close());
  return { get svc() { return svc; }, req: (p, b) => call(join(home, 'guard.sock'), p, b),
    restart: async () => { await svc.close(); svc = await start(); } };
}

test('服务：账户不一致时拒绝读取与重置，且不消耗重置卡', async t => {
  let consumed = 0;
  const { req } = await service(t, { read: async () => summarize(readResult({ accountId: 'someone-else' }), NOW), consume: async () => { consumed++; return 'reset'; } });
  await assert.rejects(req('/codex-credits', { accountId: 'codex:acct-1' }), /账户不一致/);
  await assert.rejects(req('/codex-reset', resetRequest()), /账户不一致/);
  assert.equal(consumed, 0);
});

test('服务：未触顶也能选择第二、第三张卡；接口请求只使用指定 ID', async t => {
  const used = [];
  const result = readResult(); result.rateLimitResetCredits.credits.push(credit('c-third', 1_801_000_000));
  const { req } = await service(t, { read: async () => summarize(result, NOW), consume: async (id, key) => { used.push({ id, key }); return 'reset'; } });
  const s = await req('/codex-credits', { accountId: 'codex:acct-1' });
  assert.equal(s.limitReached, false);
  assert.deepEqual(s.credits.map(c => c.id), ['c-early', 'c-late', 'c-third']);
  assert.equal((await req('/codex-reset', resetRequest())).outcome, 'reset');
  assert.equal((await req('/codex-reset', resetRequest('c-third', 'request-0002'))).outcome, 'reset');
  assert.deepEqual(used.map(x => x.id), ['c-late', 'c-third']);
  assert.notEqual(used[0].key, used[1].key);
});

test('服务：必须明确选择卡片和请求标识；失效或过期卡不替换为其他卡', async t => {
  let consumed = 0;
  const result = readResult(); result.rateLimitResetCredits.credits.push(credit('c-expired', NOW / 1000));
  const { req } = await service(t, { read: async () => summarize(result, NOW), consume: async () => { consumed++; return 'reset'; } });
  for (const creditId of [undefined, '', '   ']) await assert.rejects(req('/codex-reset', { ...resetRequest(), creditId }), /请选择/);
  await assert.rejects(req('/codex-reset', { accountId: 'codex:acct-1', creditId: 'c-late' }), /标识/);
  for (const creditId of ['c-used', 'c-expired', 'c-missing']) await assert.rejects(req('/codex-reset', resetRequest(creditId)), /不可用/);
  await assert.rejects(req('/codex-reset', { ...resetRequest(), accountId: 'claude:a' }), /不是已采集的 Codex 账户/);
  assert.equal(consumed, 0);
});

test('服务：刷新改变顺序仍绑定所选卡；卡片消失不切换到剩余卡', async t => {
  const used = []; let current = readResult();
  const { req } = await service(t, { read: async () => summarize(current, NOW), consume: async id => { used.push(id); return 'reset'; } });
  await req('/codex-credits', { accountId: 'codex:acct-1' });
  current.rateLimitResetCredits.credits.reverse();
  await req('/codex-reset', resetRequest('c-late'));
  current.rateLimitResetCredits.credits = current.rateLimitResetCredits.credits.filter(c => c.id !== 'c-early');
  await assert.rejects(req('/codex-reset', resetRequest('c-early', 'request-0002')), /不可用/);
  assert.deepEqual(used, ['c-late']);
});

test('服务：防并发，同一请求成功后重复发送和重启不再次消耗，不可改绑其他卡', async t => {
  const used = []; let release, started;
  const consuming = new Promise(resolve => { started = resolve; });
  const f = await service(t, { read: async () => summarize(readResult(), NOW), consume: async (id, key) => {
    used.push({ id, key }); started(); await new Promise(resolve => { release = resolve; }); return 'reset';
  } });
  const slow = f.req('/codex-reset', resetRequest());
  await consuming;
  await assert.rejects(f.req('/codex-reset', resetRequest()), /正在重置/);
  release(); assert.equal((await slow).outcome, 'reset');
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'reset');
  await f.restart();
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'reset');
  await assert.rejects(f.req('/codex-reset', resetRequest('c-early')), /不一致/);
  assert.equal(used.length, 1);
  assert.equal(f.svc.engine.store.events().filter(e => e.kind === 'reset_credit_result').length, 1);
});

for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']) {
  test(`服务：准确返回及审计 ${outcome}，不统一记为消耗成功`, async t => {
    const { svc, req } = await service(t, { read: async () => summarize(readResult(), NOW), consume: async () => outcome });
    assert.equal((await req('/codex-reset', resetRequest())).outcome, outcome);
    const audit = svc.engine.store.events().filter(e => e.kind === 'reset_credit_result');
    assert.equal(audit.length, 1); assert.equal(audit[0].body.creditId, 'c-late'); assert.equal(audit[0].body.outcome, outcome);
    assert.equal(svc.engine.store.events().filter(e => e.kind === 'reset_credit_consumed').length, 0);
  });
}

test('服务：超时后只查询；重启和新客户端重试同张卡沿用原幂等键，明确结果后才开始新操作', async t => {
  const keys = []; let reads = 0;
  const f = await service(t, { read: async () => { reads++; return summarize(readResult(), NOW); }, consume: async (_, key) => {
    keys.push(key); if (keys.length === 1) throw new Error('timeout'); return 'nothingToReset';
  } });
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'unknown');
  assert.equal(keys.length, 1); assert.equal(reads, 2, '提交前后均读取卡片，未自动再次提交');
  await f.restart();
  assert.equal((await f.req('/codex-reset', resetRequest('c-late', 'request-newclient'))).outcome, 'nothingToReset');
  assert.equal(keys[0], keys[1]);
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'nothingToReset');
  assert.equal(keys.length, 2, '另一客户端已确认后，原请求不得再提交');
  assert.equal((await f.req('/codex-reset', resetRequest('c-late', 'request-next'))).outcome, 'nothingToReset');
  assert.notEqual(keys[1], keys[2]);
});

test('服务：超时后卡片已消失，重试原请求只报告待确认，不消耗其他卡', async t => {
  let consumed = 0, current = readResult();
  const { req } = await service(t, { read: async () => summarize(current, NOW), consume: async () => {
    consumed++; current.rateLimitResetCredits.credits = current.rateLimitResetCredits.credits.filter(c => c.id !== 'c-late');
    throw new Error('timeout');
  } });
  assert.equal((await req('/codex-reset', resetRequest())).outcome, 'unknown');
  assert.equal((await req('/codex-reset', resetRequest())).outcome, 'unknown');
  assert.equal(consumed, 1);
});

test('服务：成功后的读取失败不覆盖已确认结果；接口拒绝与未知结果分开', async t => {
  let consumed = false;
  const { req } = await service(t, { read: async () => { if (consumed) throw new Error('read timeout'); return summarize(readResult(), NOW); },
    consume: async () => { consumed = true; return 'reset'; } });
  const result = await req('/codex-reset', resetRequest());
  assert.equal(result.outcome, 'reset'); assert.equal(result.credits, null); assert.equal(result.refreshIncomplete, true);
  const f = await service(t, { read: async () => summarize(readResult(), NOW), consume: async () => { throw Object.assign(new Error('rejected'), { code: 'CODEX_REJECTED' }); } });
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'rejected');
});

test('服务：提交前持久化后进程退出，重启仍沿用原上游幂等键', async t => {
  const keys = [];
  const f = await service(t, { read: async () => summarize(readResult(), NOW), consume: async (_, key) => { keys.push(key); return 'reset'; } });
  f.svc.engine.store.transaction(() => {
    f.svc.engine.store.setMeta('credit_reset_request:request-0001', { accountId: 'codex:acct-1', creditId: 'c-late',
      idempotencyKey: REQUEST_KEY, status: 'pending', startedAt: NOW });
    f.svc.engine.store.setMeta('credit_reset_pending:["codex:acct-1","c-late"]', REQUEST_KEY);
  });
  await f.restart();
  assert.equal((await f.req('/codex-reset', resetRequest())).outcome, 'reset');
  assert.deepEqual(keys, [REQUEST_KEY]);
});

test('服务：重置后的刷新仍在进行时，后续操作等待而不并发消耗', async t => {
  let consumed = 0, finishRefresh, signalRefresh;
  const refreshing = new Promise(resolve => { signalRefresh = resolve; });
  const f = await service(t, { read: async () => {
    if (consumed) { signalRefresh(); await new Promise(resolve => { finishRefresh = resolve; }); }
    return summarize(readResult(), NOW);
  }, consume: async () => { consumed++; return 'reset'; } });
  const first = f.req('/codex-reset', resetRequest());
  await refreshing;
  await assert.rejects(f.req('/codex-reset', resetRequest('c-early', 'request-0002')), /正在重置/);
  finishRefresh(); assert.equal((await first).outcome, 'reset'); assert.equal(consumed, 1);
});
