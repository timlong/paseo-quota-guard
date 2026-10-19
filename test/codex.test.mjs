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
  assert.equal(await consumeCredit(fake.bin, 'c-1', 5000), 'reset');
  const reqs = fake.requests();
  assert.deepEqual(reqs.map(r => r.method), ['initialize', 'initialized', 'account/rateLimits/read', 'initialize', 'initialized', 'account/rateLimitResetCredit/consume']);
  const consume = reqs.at(-1).params;
  assert.equal(consume.creditId, 'c-1');
  assert.match(consume.idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('codexRpc：错误、无效结果与超时都会失败且不挂起', async t => {
  const failing = fakeAppServer(t, m => m.method === 'initialize' ? { result: {} } : { error: { code: -1, message: 'secret detail' } });
  await assert.rejects(codexRpc(failing.bin, 'account/rateLimits/read', {}, 5000), /Codex 拒绝了请求/);
  const weird = fakeAppServer(t, m => m.method === 'initialize' ? { result: {} } : { result: { outcome: 'boom' } });
  await assert.rejects(consumeCredit(weird.bin, 'c-1', 5000), /结果无效/);
  const silent = fakeAppServer(t, () => null);
  await assert.rejects(codexRpc(silent.bin, 'account/rateLimits/read', {}, 300), /超时/);
  await assert.rejects(codexRpc('/nonexistent/codex', 'x', {}, 2000), /无法启动|意外退出/);
});

async function service(t, codex) {
  const home = mkdtempSync(join(tmpdir(), 'qg-codex-svc-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexReport = { ...report('codex', 10, 10, Date.now(), 'x'), id: 'codex:acct-1' };
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [codexReport], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    return { accepted: true };
  });
  t.after(() => bridge.close());
  const svc = await startService({ home, config: config({ windowPolicy: { claude: 'both', codex: 'available' } }), bridgePath: join(home, 'paseo.sock'), codex });
  t.after(() => svc.close());
  return { svc, req: (p, b) => call(join(home, 'guard.sock'), p, b) };
}

test('服务：账户不一致时拒绝读取与重置，且不消耗重置卡', async t => {
  let consumed = 0;
  const { req } = await service(t, { read: async () => summarize(readResult({ accountId: 'someone-else', ordinaryUsageAllowed: false }), NOW), consume: async () => { consumed++; return 'reset'; } });
  await assert.rejects(req('/codex-credits', { accountId: 'codex:acct-1' }), /账户不一致/);
  await assert.rejects(req('/codex-reset', { accountId: 'codex:acct-1' }), /账户不一致/);
  assert.equal(consumed, 0);
});

test('服务：额度未触顶时拒绝重置，不消耗重置卡', async t => {
  let consumed = 0;
  const { req } = await service(t, { read: async () => summarize(readResult(), NOW), consume: async () => { consumed++; return 'reset'; } });
  const s = await req('/codex-credits', { accountId: 'codex:acct-1' });
  assert.deepEqual(s.credits.map(c => c.id), ['c-early', 'c-late']);
  assert.equal((await req('/status')).codexCredits['codex:acct-1'].availableCount, 3);
  await assert.rejects(req('/codex-reset', { accountId: 'codex:acct-1' }), /尚未触顶/);
  assert.equal(consumed, 0);
});

test('服务：触顶时默认使用最早到期的卡，可指定卡，无效卡拒绝，并发重置拒绝；审计记录结果', async t => {
  const used = [];
  let release;
  const { svc, req } = await service(t, {
    read: async () => summarize(readResult({ ordinaryUsageAllowed: false }), NOW),
    consume: async id => { used.push(id); if (used.length === 2) await new Promise(r => { release = r; }); return 'reset'; },
  });
  assert.equal((await req('/codex-reset', { accountId: 'codex:acct-1' })).outcome, 'reset');
  assert.deepEqual(used, ['c-early']);
  const slow = req('/codex-reset', { accountId: 'codex:acct-1', creditId: 'c-late' });
  while (used.length < 2) await new Promise(r => setTimeout(r, 10));
  await assert.rejects(req('/codex-reset', { accountId: 'codex:acct-1' }), /正在重置/);
  release();
  assert.equal((await slow).outcome, 'reset');
  assert.deepEqual(used, ['c-early', 'c-late']);
  await assert.rejects(req('/codex-reset', { accountId: 'codex:acct-1', creditId: 'c-used' }), /不可用/);
  await assert.rejects(req('/codex-reset', { accountId: 'claude:a' }), /不是已采集的 Codex 账户/);
  const audits = svc.engine.store.events().filter(e => e.kind === 'reset_credit_consumed');
  assert.equal(audits.length, 2);
  assert.equal(audits[0].body.outcome, 'reset');
});
