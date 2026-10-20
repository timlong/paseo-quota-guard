import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { startService } from '../src/main.mjs';
import { serve, call } from '../src/ipc.mjs';
import { config, report } from './helpers.mjs';

const START = Date.parse('2026-10-19T12:00:00Z');
const RESET = Date.parse('2026-10-19T14:00:00Z');
function reading(at, used = 82, weekly = 46, reset = new Date(RESET).toISOString(), provider = 'claude') {
  const r = report(provider, used, weekly, at);
  r.report.windows[0].resetsAt = reset;
  r.report.windows[1].resetsAt = '2026-10-23T00:00:00Z';
  return r;
}
function failed(at, error = '429 rate limited', provider = 'claude') {
  return { ...reading(at, 0, 0, null, provider), report: { status: 'error', error } };
}
function fixture(t, extra = {}) {
  let time = START;
  const store = new Store(':memory:'); t.after(() => store.close());
  let engine = new Engine(config(extra), store, () => time);
  return { get engine() { return engine; }, store, now: () => time, advance: ms => { time += ms; },
    restart() { engine = new Engine(engine.config, store, () => time); },
    messages: () => store.notificationHistory().map(r => ({ ...JSON.parse(r.body), status: r.status })) };
}

for (const [message, code] of [['429 rate limited', 'rate_limited'], ['request timed out', 'timeout']]) {
  test(`手动恢复：${code} 使用有效缓存，状态和服务端判断一致`, t => {
    const f = fixture(t);
    f.engine.ingest([reading(f.now())]); f.engine.pause('claude:a'); f.advance(120000);
    f.engine.ingest([failed(f.now(), message)]);
    let a = f.engine.status().accounts[0];
    assert.equal(a.errorCode, code); assert.equal(a.ready, true);
    assert.equal(a.assessment.usingCachedReading, true);
    f.restart(); assert.equal(f.engine.status().accounts[0].ready, true);
    f.engine.resume('claude:a'); assert.equal(f.engine.admission(['claude:a']).allowed, true);
    assert.equal(f.messages().filter(m => m.kind === 'ready').length, 0, '手动暂停不发可恢复通知');
    f.engine.pause('claude:a'); f.advance(480000);
    a = f.engine.status().accounts[0];
    assert.equal(a.ready, false, '即使尚未 tick，状态也不得返回过期 ready');
    assert.match(a.assessment.resumeReason, /过期/);
    assert.throws(() => f.engine.resume('claude:a'), /过期/);
  });
}

test('登录失效、无效窗口和未知错误不能借用缓存恢复；旧成功报告不能清除错误', t => {
  const f = fixture(t);
  const original = reading(f.now()); f.engine.ingest([original]); f.engine.pause('claude:a');
  for (const problem of [{ status: 'unavailable' }, { status: 'available', windows: [] }, { status: 'error', error: '500' }]) {
    f.advance(1000); f.engine.ingest([{ ...reading(f.now()), report: problem }]);
    assert.equal(f.engine.status().accounts[0].ready, false);
    assert.throws(() => f.engine.resume('claude:a'), /成功刷新/);
  }
  f.advance(1000); const newer = reading(f.now()); f.engine.ingest([newer]);
  f.advance(1000); f.engine.ingest([{ ...reading(f.now()), report: { status: 'unavailable' } }]);
  f.engine.ingest([original]);
  assert.equal(f.engine.require('claude:a').errorCode, 'unavailable');
  assert.throws(() => f.engine.resume('claude:a'), /登录失效/);
});

test('新的高用量不能退回旧的低用量；周窗口、自定义恢复线与 Codex 单窗口有效', t => {
  const f = fixture(t);
  const original = reading(f.now()); f.engine.ingest([original]); f.engine.pause('claude:a');
  f.advance(1000); f.engine.ingest([reading(f.now(), 82, 91)]);
  f.advance(1000); f.engine.ingest([failed(f.now()), original]);
  assert.throws(() => f.engine.resume('claude:a'), /88%/);
  const c = reading(f.now(), 0, 91, null, 'codex'); c.report.windows.shift();
  f.engine.ingest([c]); f.engine.pause('codex:a');
  f.advance(1000); f.engine.ingest([failed(f.now(), 'timed out', 'codex')]);
  f.engine.resume('codex:a'); assert.equal(f.engine.admission(['codex:a']).allowed, true);
  f.engine.config.thresholds.codex = { warn: 80, pause: 92 };
  f.engine.pause('codex:a'); assert.throws(() => f.engine.resume('codex:a'), /90%/);
  f.engine.ingest([{ ...c, fetchedAt: new Date(f.now()).toISOString(), report: { status: 'available', windows: [] } }]);
  assert.throws(() => f.engine.resume('codex:a'), /缺少/);
});

test('实际时间抖动回放：跨秒、跨时区、刷新和重启只预警一次，真正换周期再提醒', t => {
  const f = fixture(t);
  const resets = ['2026-10-19T13:59:59.880472+00:00', '2026-10-19T14:00:00.050974+00:00',
    '2026-10-19T13:59:59.965666+00:00', '2026-10-19T22:00:00.192020+08:00'];
  for (const [i, reset] of resets.entries()) {
    f.engine.ingest([reading(f.now(), i ? 82 : 80, 46, reset)]);
    f.advance(120000); f.restart();
  }
  assert.equal(f.messages().length, 1);
  assert.equal(f.engine.require('claude:a').warningCycles.five_hour.anchor, Date.parse(resets[0]));
  // A correction before the old boundary is not evidence of a new quota period.
  f.engine.ingest([reading(f.now(), 82, 46, new Date(RESET + 120000).toISOString())]);
  assert.equal(f.messages().length, 1);
  f.advance(RESET - f.now() + 1000);
  f.engine.ingest([reading(f.now(), 82, 46, new Date(RESET + 18000000).toISOString())]);
  assert.equal(f.messages().length, 2);
});

test('两个窗口同轮预警合并；有重置时间时用量回落不重复，未知重置时间回落后可再提醒', t => {
  const f = fixture(t);
  f.engine.ingest([reading(f.now(), 82, 83)]);
  assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].warnings.length, 2);
  f.advance(1000); f.engine.ingest([reading(f.now(), 20, 20)]);
  f.advance(1000); f.engine.ingest([reading(f.now(), 82, 83)]);
  assert.equal(f.messages().length, 1);
  const g = fixture(t);
  g.engine.ingest([reading(g.now(), 82, 46, null)]);
  g.advance(1000); g.engine.ingest([reading(g.now(), 82, 46, 'bad date')]);
  assert.equal(g.messages().length, 1);
  g.advance(1000); g.engine.ingest([reading(g.now(), 20, 46, null)]);
  g.advance(1000); g.engine.ingest([reading(g.now(), 82, 46, null)]);
  assert.equal(g.messages().length, 2);
  g.advance(1000); g.engine.ingest([reading(g.now())]);
  assert.equal(g.messages().length, 2, '从未知变成有效重置时间不补发');
});

test('旧数据库迁移：保留周期和暂停状态，取消旧重复预警并且重启幂等', t => {
  const f = fixture(t);
  f.engine.ingest([reading(f.now())]);
  const legacy = structuredClone(f.engine.require('claude:a'));
  delete legacy.warningCycles; delete legacy.notices;
  legacy.warned = { five_hour: '2026-10-19T13:59:59.999473+00:00' };
  f.store.db.exec('DELETE FROM outbox'); f.store.save(legacy);
  for (let i = 0; i < 3; i++) f.store.enqueue(`old-${i}`, { accountId: legacy.id, epoch: legacy.epoch,
    kind: 'warning', settingsRevision: 16 }, f.now());
  f.restart(); f.advance(1000); f.engine.ingest([reading(f.now())]); f.restart();
  assert.equal(f.messages().length, 3);
  assert.ok(f.messages().every(m => m.status === 'cancelled'));
  assert.equal(f.engine.require('claude:a').locked, legacy.locked);
});

test('暂停事件：结果反复、保存设置和重启不重复；新暂停事件可再通知', t => {
  const f = fixture(t);
  f.engine.ingest([reading(f.now(), 91)]);
  f.engine.stopPending('claude:a'); f.engine.stopPending('claude:a');
  f.engine.stopResult('claude:a', { complete: false, pending: ['child'] });
  f.engine.stopResult('claude:a', { complete: true, pending: [], checkedCount: 1 });
  f.engine.resetAccountsForSettings(true, true); f.engine.config.settingsRevision = 5;
  f.restart();
  f.engine.stopResult('claude:a', { complete: false, pending: ['child'] });
  f.engine.stopResult('claude:a', { complete: true, pending: [], checkedCount: 1 });
  assert.deepEqual(f.messages().map(m => m.kind), ['paused']);
  assert.match(f.messages()[0].body, /已核验/); assert.match(f.messages()[0].body, /91%/);
  f.advance(1000); f.engine.ingest([reading(f.now(), 10)]); f.engine.resume('claude:a');
  f.advance(1000); f.engine.ingest([reading(f.now(), 91)]);
  f.engine.stopResult('claude:a', { complete: true, pending: [] });
  assert.equal(f.messages().filter(m => m.kind === 'paused').length, 2);
  assert.equal(f.messages().filter(m => m.kind === 'recovered').length, 1);
});

test('矛盾或未确认的中断结果不得发完成通知，零关联任务明确说明范围', t => {
  const f = fixture(t); f.engine.ingest([reading(f.now(), 91)]);
  for (const result of [{ complete: true, pending: ['child'] }, { complete: true, pending: [], failures: ['failed'] },
    { complete: true, pending: [], disabled: true }, { complete: true }, { complete: false, pending: [], error: 'unknown' }]) {
    f.engine.stopResult('claude:a', result); assert.equal(f.engine.require('claude:a').stopStatus, 'partial');
  }
  f.engine.stopResult('claude:a', { complete: true, pending: [], checkedCount: 0 });
  assert.match(f.messages().find(m => m.kind === 'paused').body, /未发现可中断/);
});

async function serviceFixture(t, { used = 82, interrupt = async () => ({ complete: true, pending: [], checkedCount: 1 }),
  push = async () => ({ accepted: true }), stopNoticeMs = 60000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'qg-regression-'));
  let time = START, input = reading(time, used), received = [];
  const bridge = await serve(join(home, 'paseo.sock'), async (path, body) => {
    if (path === '/snapshot') return { mode: 'enforce', reports: input ? [input] : [], agents: [] };
    if (path === '/interrupt') return interrupt(body);
    if (path === '/push') { received.push(body); return push(body); }
    throw new Error('unexpected request');
  });
  let service;
  t.after(async () => { await service?.close(); await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  const start = () => startService({ home, config: config({ notifications: true }), bridgePath: join(home, 'paseo.sock'), now: () => time, stopNoticeMs });
  service = await start();
  const req = (path, body) => call(join(home, 'guard.sock'), path, body);
  return { get service() { return service; }, received, now: () => time, req,
    advance: ms => { time += ms; }, setInput: r => { input = r; },
    restart: async () => { await service.close(); service = await start(); },
    settings: async patch => { const s = await req('/status'); return req('/settings', {
      revision: s.settingsRevision, enabled: s.enabled, notifications: s.notifications, thresholds: s.thresholds, ...patch }); } };
}

test('隔离 socket：限流可恢复，过期、缺失账户及最新超限不可恢复', async t => {
  const f = await serviceFixture(t);
  await f.req('/pause', { accountId: 'claude:a' });
  f.advance(120000); f.setInput(failed(f.now()));
  await f.req('/resume', { accountId: 'claude:a' });
  assert.equal((await f.req('/admit', { reportIds: ['claude:a'] })).allowed, true);
  await f.req('/pause', { accountId: 'claude:a' });
  f.setInput(null); await assert.rejects(f.req('/resume', { accountId: 'claude:a' }), /未返回/);
  f.setInput(reading(f.now(), 95)); await assert.rejects(f.req('/resume', { accountId: 'claude:a' }), /88%/);
  f.setInput(reading(f.now(), 82)); await f.req('/refresh');
  f.advance(600000); f.setInput(failed(f.now()));
  await assert.rejects(f.req('/resume', { accountId: 'claude:a' }), /过期/);
});

test('隔离 socket：设置保存、通知与保护开关、重启均不重复已有预警', async t => {
  const f = await serviceFixture(t);
  await f.settings({}); await f.settings({ notifications: false }); await f.settings({ notifications: true });
  await f.settings({ enabled: false }); await f.settings({ enabled: true });
  await f.settings({ thresholds: { claude: { warn: 70, pause: 90 }, codex: { warn: 90, pause: 95 } } });
  await f.restart();
  assert.equal(f.received.filter(m => m.kind === 'warning').length, 1);
});

test('隔离 socket：自动暂停结果失败重试，partial 后确认完成必有一次通知', async t => {
  let complete = false, accepted = false;
  const f = await serviceFixture(t, { used: 91,
    interrupt: async () => ({ complete, pending: complete ? [] : ['child'], error: complete ? undefined : '中断调用失败' }),
    push: async () => ({ accepted }) });
  assert.deepEqual(f.received.map(m => m.kind), ['partial']);
  assert.equal(f.service.engine.store.events().filter(e => e.kind === 'push_submitted').length, 0);
  accepted = true; f.advance(60000); await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['partial', 'partial']);
  complete = true; f.advance(1000); await f.service.tick(true);
  await f.settings({}); await f.restart();
  assert.deepEqual(f.received.map(m => m.kind), ['partial', 'partial', 'paused']);
  assert.ok(f.service.engine.store.events().filter(e => e.kind === 'push_submitted').every(e => e.body.delivery === 'unconfirmed'));
});

test('隔离 socket：持续未停止才通知异常，再通知完成，已完成账户不重复提示', async t => {
  const sent = [];
  let release;
  const f = await serviceFixture(t, { used: 91, stopNoticeMs: 5,
    interrupt: () => new Promise(resolve => { release = () => resolve({ complete: true, pending: [] }); }),
    push: async body => { sent.push(body.kind); if (body.kind === 'partial') release(); return { accepted: true }; } });
  assert.deepEqual(sent, ['partial', 'paused']);
  const tick = f.service.tick(true);
  // Release the next interrupt without waiting for another progress notification.
  await new Promise(resolve => setTimeout(resolve, 30)); release(); await tick;
  assert.deepEqual(sent, ['partial', 'paused']);
});

test('隔离 socket：恢复后不补发旧暂停通知，换周期不补发旧预警', async t => {
  let accepted = false;
  const f = await serviceFixture(t, { used: 91, push: async () => ({ accepted }) });
  f.advance(1000); f.setInput(reading(f.now(), 10)); await f.req('/resume', { accountId: 'claude:a' });
  accepted = true; f.advance(60000); await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['paused', 'recovered']);
  assert.equal(f.service.engine.store.notificationHistory()[0].status, 'cancelled');
  assert.equal(f.service.engine.store.notificationHistory()[1].status, 'submitted');
  const g = await serviceFixture(t, { push: async () => ({ accepted: false }) });
  g.advance(RESET - g.now() + 1000);
  g.setInput(reading(g.now(), 82, 46, new Date(RESET + 18000000).toISOString()));
  await g.service.tick(true);
  assert.equal(g.received.length, 2, '本轮只尝试新周期，旧周期取消');
  assert.equal(g.service.engine.store.notificationHistory()[0].status, 'cancelled');
});

test('旧设置曾清空 warned：从最后一条旧预警恢复周期，避免升级重新提醒', t => {
  const f = fixture(t); f.engine.ingest([reading(f.now())]);
  const a = structuredClone(f.engine.require('claude:a'));
  delete a.warningCycles; a.warned = {};
  f.store.save(a); f.store.db.exec('DELETE FROM outbox');
  const payload = { accountId: a.id, epoch: a.epoch, kind: 'warning', settingsRevision: 16 };
  f.store.enqueue(`${a.id}:warning:five_hour:2026-10-19T09:00:00Z:settings:15`, payload, f.now());
  f.store.enqueue(`${a.id}:warning:five_hour:2026-10-19T13:59:59.965666Z:settings:16`, payload, f.now());
  f.restart(); f.advance(1000); f.engine.ingest([reading(f.now())]);
  assert.equal(f.messages().length, 2);
  assert.ok(f.messages().every(m => m.status === 'cancelled'));
  assert.equal(f.engine.require(a.id).warningCycles.five_hour.anchor, Date.parse('2026-10-19T13:59:59.965666Z'));
});

test('隔离 socket：中断调用失败通知未确认结果，后续恢复连接再通知完成', async t => {
  let connected = false;
  const f = await serviceFixture(t, { used: 91, interrupt: async () => {
    if (!connected) throw new Error('disconnected');
    return { complete: true, pending: [], checkedCount: 1 };
  } });
  assert.equal(f.received[0].kind, 'partial'); assert.match(f.received[0].body, /无法确认/);
  connected = true; await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['partial', 'paused']);
});

test('隔离 socket：通知未返回也必须开始中断其他超限账户', { timeout: 3000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-interrupt-order-'));
  let allowPush;
  const bothInterrupted = new Promise(resolve => { allowPush = resolve; });
  const stopped = new Set(), pushes = [];
  const bridge = await serve(join(home, 'paseo.sock'), async (path, body) => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [reading(START, 91), reading(START, 96, 0, null, 'codex')], agents: [] };
    if (path === '/interrupt') { stopped.add(body.accountId); if (stopped.size === 2) allowPush(); return { complete: true, pending: [] }; }
    if (path === '/push') { await bothInterrupted; pushes.push(body); return { accepted: true }; }
    throw new Error('unexpected request');
  });
  let service;
  t.after(async () => { allowPush(); await service?.close(); await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  service = await startService({ home, config: config({ notifications: true }), bridgePath: join(home, 'paseo.sock'), now: () => START });
  assert.equal(stopped.size, 2); assert.equal(pushes.filter(m => m.kind === 'paused').length, 2);
});

test('截图场景回放：24 秒内从部分停止到完成，只推送一次完成', async t => {
  let complete = false;
  const f = await serviceFixture(t, { used: 91, interrupt: async () => ({ complete, pending: complete ? [] : ['child'] }) });
  assert.equal((await f.req('/status')).accounts[0].stopStatus, 'partial');
  f.advance(5000); await f.service.tick(true);
  assert.deepEqual(f.received, []);
  complete = true; f.advance(19000); await f.service.tick(true);
  await f.service.tick(true); await f.restart();
  assert.deepEqual(f.received.map(m => m.kind), ['paused']);
});

test('持续未停止满 60 秒才提醒，重启保持计时且不重复，完成另发一次', async t => {
  let complete = false;
  const f = await serviceFixture(t, { used: 91, interrupt: async () => ({ complete, pending: complete ? [] : ['child'] }) });
  f.advance(59000); await f.restart();
  assert.deepEqual(f.received, []);
  f.advance(1000); await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['partial']);
  await f.restart(); await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['partial']);
  complete = true; await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['partial', 'paused']);
});

test('自动恢复：所有窗口低于自定义恢复线才解除，通知和审计跨重启只一次', t => {
  const f = fixture(t, { thresholds: { claude: { warn: 75, pause: 85 }, codex: { warn: 90, pause: 95 } } });
  f.engine.ingest([reading(f.now(), 85, 86)]);
  f.advance(1000); f.engine.ingest([reading(f.now(), 0, 86)]);
  assert.equal(f.engine.require('claude:a').locked, true);
  f.advance(1000); f.engine.ingest([reading(f.now(), 0, 83)]);
  assert.equal(f.engine.require('claude:a').locked, true, '恢复线须严格低于 83%');
  f.advance(1000); f.engine.ingest([reading(f.now(), 0, 82)]);
  assert.equal(f.engine.admission(['claude:a']).allowed, true);
  assert.deepEqual(f.messages().map(m => m.kind), ['recovered'], '恢复到预警区间也只发恢复通知');
  assert.match(f.messages()[0].body, /自动解除/);
  f.engine.stopResult('claude:a', { complete: false, pending: ['late-result'] });
  assert.equal(f.engine.require('claude:a').stopStatus, null, '恢复后迟到的中断结果不能恢复旧暂停状态');
  f.restart(); f.advance(1000); f.engine.ingest([reading(f.now(), 0, 82)]);
  assert.equal(f.messages().length, 1);
  assert.equal(f.store.events().filter(e => e.kind === 'auto_resumed').length, 1);
});

test('自动恢复必须有本次有效新读数：空快照、错误、旧数据、过期数据和缺失窗口均不能触发', t => {
  const f = fixture(t);
  f.engine.ingest([reading(f.now(), 91)]);
  f.advance(1000);
  // Relaxing settings alone must not interpret a cached reading as recovered quota.
  f.engine.config.thresholds.claude = { warn: 90, pause: 99 };
  for (const entries of [[], [failed(f.now())], [failed(f.now(), 'timed out')],
    [{ ...reading(f.now()), report: { status: 'unavailable' } }],
    [{ ...reading(f.now()), report: { status: 'available', windows: [] } }],
    [reading(START - 1000, 0, 0)]]) {
    f.engine.ingest(entries); assert.equal(f.engine.require('claude:a').locked, true);
  }
  f.advance(600000); f.engine.ingest([reading(START + 500, 0, 0)]);
  assert.equal(f.engine.require('claude:a').locked, true);
  assert.equal(f.messages().filter(m => m.kind === 'recovered').length, 0);
  f.engine.ingest([reading(f.now(), 0, 0)]);
  assert.equal(f.engine.require('claude:a').locked, false);
  assert.equal(f.messages().filter(m => m.kind === 'recovered').length, 1);
});

test('Codex 单窗口自动恢复；未知窗口不能当作归零；手动暂停优先', t => {
  const f = fixture(t);
  const codex = used => {
    const r = reading(f.now(), 0, used, null, 'codex'); r.report.windows.shift(); return r;
  };
  f.engine.ingest([codex(95)]);
  f.advance(1000);
  const missing = codex(0); missing.report.windows[0].id = 'unknown';
  f.engine.ingest([missing]); assert.equal(f.engine.require('codex:a').locked, true);
  f.engine.ingest([codex(92)]); assert.equal(f.engine.require('codex:a').locked, false);
  f.advance(1000); f.engine.ingest([codex(95)]);
  f.engine.pause('codex:a'); f.restart();
  f.advance(1000); f.engine.ingest([codex(0)]);
  assert.equal(f.engine.require('codex:a').locked, true);
  assert.equal(f.engine.require('codex:a').pauseCause, 'manual');
  assert.equal(f.messages().filter(m => m.kind === 'recovered').length, 1);
});

test('旧库迁移保留手动暂停、识别额度暂停、撤销旧进度和待手动恢复通知', t => {
  const f = fixture(t);
  f.engine.ingest([reading(f.now(), 91), reading(f.now(), 96, 0, null, 'codex')]);
  f.engine.pause('codex:a');
  for (const a of f.engine.accounts.values()) {
    delete a.pauseCause; delete a.stopStartedAt; f.store.save(a);
  }
  const a = f.engine.require('claude:a');
  for (const kind of ['stopping', 'ready']) f.store.enqueue('legacy-' + kind,
    { accountId: a.id, kind, epoch: a.epoch, notificationVersion: 2 }, f.now());
  f.restart();
  assert.equal(f.engine.require('claude:a').locked, true, '加载旧库本身不解除暂停');
  f.advance(1000); f.engine.ingest([reading(f.now(), 0), reading(f.now(), 0, 0, null, 'codex')]);
  assert.equal(f.engine.require('claude:a').locked, false);
  assert.equal(f.engine.require('codex:a').locked, true);
  assert.ok(f.messages().filter(m => ['stopping', 'ready'].includes(m.kind)).every(m => m.status === 'cancelled'));
});

test('自动恢复不依赖推送成功；通知重试跨重启，重新暂停后撤销过时恢复通知', async t => {
  let accepted = true, stops = 0;
  const f = await serviceFixture(t, { used: 91,
    interrupt: async () => { stops++; return { complete: true, pending: [] }; },
    push: async () => ({ accepted }) });
  accepted = false;
  f.advance(1000); f.setInput(reading(f.now(), 10)); await f.service.tick(true);
  assert.equal((await f.req('/admit', { reportIds: ['claude:a'] })).allowed, true);
  const afterPause = stops;
  await f.restart(); assert.equal(stops, afterPause, '自动恢复后不再中断，也不调用任何续跑接口');
  accepted = true; f.advance(60000); f.setInput(reading(f.now(), 10)); await f.service.tick(true);
  assert.deepEqual(f.received.map(m => m.kind), ['paused', 'recovered', 'recovered']);
  await f.restart(); assert.equal(f.received.length, 3);
  f.advance(1000); f.setInput(reading(f.now(), 91)); await f.service.tick(true);
  accepted = false; f.advance(1000); f.setInput(reading(f.now(), 10)); await f.service.tick(true);
  f.advance(1000); f.setInput(reading(f.now(), 91)); await f.service.tick(true);
  accepted = true; f.advance(60000); await f.service.tick(true);
  const recovery = f.service.engine.store.notificationHistory().filter(r => JSON.parse(r.body).kind === 'recovered');
  assert.deepEqual(recovery.map(r => r.status), ['submitted', 'cancelled']);
});

test('关闭通知仍自动恢复但不推送；观察模式和数据缺失锁定不冒充额度恢复', async t => {
  const f = await serviceFixture(t, { used: 91 });
  await f.settings({ notifications: false }); const count = f.received.length;
  f.advance(1000); f.setInput(reading(f.now(), 10)); await f.service.tick(true);
  assert.equal((await f.req('/admit', { reportIds: ['claude:a'] })).allowed, true);
  assert.equal(f.received.length, count);
  const g = fixture(t, { mode: 'observe' });
  g.engine.ingest([reading(g.now(), 91)]); g.advance(1000); g.engine.ingest([reading(g.now(), 10)]);
  assert.equal(g.messages().length, 0);
  const h = fixture(t);
  h.engine.ingest([failed(h.now())]); h.advance(1000); h.engine.ingest([reading(h.now(), 10)]);
  assert.equal(h.engine.require('claude:a').locked, true);
  assert.equal(h.messages().filter(m => m.kind === 'recovered').length, 0);
  h.advance(1000); h.engine.ingest([reading(h.now(), 91)]);
  h.advance(1000); h.engine.ingest([reading(h.now(), 10)]);
  assert.equal(h.engine.require('claude:a').locked, false, '随后确认真实超限后可以自动恢复');
});
