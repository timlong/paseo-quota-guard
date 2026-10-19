import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { validateConfig } from '../src/policy.mjs';
import { startService } from '../src/main.mjs';
import { serve, call } from '../src/ipc.mjs';
import { readSettings } from '../src/settings.mjs';
import { config, report } from './helpers.mjs';

function fixture(t, extra = {}) {
  let time = 1000000000;
  const store = new Store(':memory:'); t.after(() => store.close());
  const engine = new Engine(config(extra), store, () => time);
  return { engine, store, now: () => time, advance: n => { time += n; } };
}

// 无有效读数报告：fetch 失败，账户从未有过有效窗口。
const bad = (provider = 'claude', account = 'a', at) => ({
  id: `${provider}:${account}`, sourceId: provider, sourceLabel: provider, account: { label: account },
  fetchedAt: new Date(at).toISOString(), report: { status: 'error', error: 'no' },
});

test('有过有效读数不隐藏', t => {
  const f = fixture(t);
  f.engine.ingest([report('claude', 10, 10, f.now())]);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('真实 pause() 后不隐藏', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  assert.equal(f.engine.require('claude:a').locked, false);
  f.engine.config.enabled = true;
  f.engine.pause('claude:a');
  assert.equal(f.engine.require('claude:a').reason, '用户手动暂停');
  assert.equal(f.engine.require('claude:a').locked, true);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('自动 unknown 锁定不隐藏', t => {
  const f = fixture(t);
  f.engine.ingest([bad('claude', 'a', f.now())]);
  assert.equal(f.engine.require('claude:a').locked, true);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('partial 暂停状态不隐藏', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  f.engine.stopResult('claude:a', { complete: false, pending: ['agent'] });
  assert.equal(f.engine.require('claude:a').stopStatus, 'partial');
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('未超时不隐藏', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  f.advance(f.engine.config.pruneMs - 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('超时隐藏', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), true);
});

test('隐藏账户不出现在 status().accounts', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now()), report('codex', 10, 10, f.now())]);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  const ids = f.engine.status().accounts.map(a => a.id);
  assert.ok(!ids.includes('claude:a'));
  assert.ok(ids.includes('codex:a'));
});

test('再次被报告取消隐藏', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), true);
  f.engine.ingest([bad('claude', 'a', f.now())]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('保护开启后无数据账户被锁定并重新可见（故障安全）', t => {
  const f = fixture(t, { enabled: false });
  f.engine.ingest([bad('claude', 'a', f.now())]);
  f.advance(f.engine.config.pruneMs + 1);
  f.engine.ingest([]);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), true);
  f.engine.config.enabled = true;
  f.engine.ingest([]);
  assert.equal(f.engine.require('claude:a').locked, true);
  assert.equal(f.engine.isHidden(f.engine.require('claude:a')), false);
});

test('旧数据缺 lastSeenAt：加载时补为加载时刻', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.save({ id: 'claude:a', provider: 'claude', label: 'a', windows: [], fetchedAt: null,
    locked: false, reason: '', epoch: 0, ready: false, warned: {}, stopStatus: null, error: null });
  let time = 5000;
  const engine = new Engine(config(), store, () => time);
  assert.equal(engine.require('claude:a').lastSeenAt, 5000);
  assert.equal(engine.isHidden(engine.require('claude:a')), false);
});

test('配置校验：pruneMs 必须为整数且大于 staleMs', () => {
  assert.throws(() => validateConfig(config({ pruneMs: config().staleMs })), /pruneMs/);
  assert.throws(() => validateConfig(config({ pruneMs: 1.5 })), /pruneMs/);
  assert.throws(() => validateConfig(config({ pruneMs: 0 })), /pruneMs/);
  assert.doesNotThrow(() => validateConfig(config({ pruneMs: config().staleMs + 1 })));
});

test('配置校验：旧用户配置缺少 pruneMs 时取默认 6 小时', () => {
  const legacy = config(); delete legacy.pruneMs;
  assert.equal(validateConfig(legacy).pruneMs, 21600000);
});

test('设置变更持久化所有账户，重建 engine 状态一致', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-settings-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let time = 1000000000, present = true;
  const badReport = () => ({ id: 'claude:a', sourceId: 'claude', sourceLabel: 'claude', account: { label: 'a' },
    fetchedAt: new Date(time).toISOString(), report: { status: 'error', error: 'no' } });
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: present ? [badReport()] : [], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    if (path === '/push') return { accepted: true };
    return { ok: true };
  });
  t.after(() => bridge.close());
  const req = (p, b) => call(join(home, 'guard.sock'), p, b);
  let service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  t.after(() => service.close());
  // 初次：protection 开启，无数据账户被锁定，epoch=1
  assert.equal(service.engine.require('claude:a').locked, true);
  assert.equal(service.engine.require('claude:a').epoch, 1);
  // 关闭保护 → 解锁 epoch=2
  let s = await req('/status');
  await req('/settings', { revision: s.settingsRevision, enabled: false, notifications: s.notifications, thresholds: s.thresholds });
  assert.equal(service.engine.require('claude:a').locked, false);
  assert.equal(service.engine.require('claude:a').epoch, 2);
  // 停止报告 + 超过 pruneMs → 隐藏
  present = false;
  time += service.engine.config.pruneMs + 1;
  await service.tick(true);
  assert.equal(service.engine.isHidden(service.engine.require('claude:a')), true);
  // 再次设置变更（保持关闭）→ epoch 继续 +1，必须持久化
  s = await req('/status');
  await req('/settings', { revision: s.settingsRevision, enabled: false, notifications: s.notifications, thresholds: s.thresholds });
  const epochAfter = service.engine.require('claude:a').epoch;
  const lockedAfter = service.engine.require('claude:a').locked;
  assert.equal(epochAfter, 3);
  assert.equal(lockedAfter, false);
  // 重建 service，验证持久化一致
  await service.close();
  service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  assert.equal(service.engine.require('claude:a').epoch, epochAfter, '重建后 epoch 一致');
  assert.equal(service.engine.require('claude:a').locked, lockedAfter, '重建后 locked 一致');
});

test('多账户设置保存中途失败：内存与数据库一致，设置未部分应用', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-settings-fail-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let time = 1000000000;
  const badReport = (id, account) => ({ id, sourceId: 'claude', sourceLabel: 'claude', account: { label: account },
    fetchedAt: new Date(time).toISOString(), report: { status: 'error', error: 'no' } });
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [badReport('claude:a', 'a'), badReport('claude:b', 'b')], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    if (path === '/push') return { accepted: true };
    return { ok: true };
  });
  t.after(() => bridge.close());
  const service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  t.after(() => service.close());
  assert.equal(service.engine.require('claude:a').locked, true);
  assert.equal(service.engine.require('claude:b').locked, true);
  assert.equal(service.engine.require('claude:a').epoch, 1);
  assert.equal(service.engine.require('claude:b').epoch, 1);
  // 注入第二次 save 抛错，触发事务回滚
  const store = service.engine.store;
  const originalSave = store.save.bind(store);
  let calls = 0;
  store.save = a => { calls++; if (calls === 2) throw new Error('注入失败'); return originalSave(a); };
  const s = await call(join(home, 'guard.sock'), '/status');
  await assert.rejects(call(join(home, 'guard.sock'), '/settings', { revision: s.settingsRevision, enabled: false, notifications: s.notifications, thresholds: s.thresholds }), /注入失败/);
  store.save = originalSave;
  // 内存一致
  for (const id of ['claude:a', 'claude:b']) {
    assert.equal(service.engine.require(id).locked, true, `${id} 内存未解锁`);
    assert.equal(service.engine.require(id).epoch, 1, `${id} 内存 epoch 未变`);
  }
  // 设置未被部分应用：首次设置且失败回滚，settings.json 不存在
  assert.equal(readSettings(home), null);
  // 数据库一致
  const rebuilt = new Engine(config(), service.engine.store, () => time);
  for (const id of ['claude:a', 'claude:b']) {
    assert.equal(rebuilt.require(id).locked, true, `${id} 数据库未解锁`);
    assert.equal(rebuilt.require(id).epoch, 1, `${id} 数据库 epoch 未变`);
  }
});

test('两步之间退出后重启协调：落后 revision 重新应用账户重置', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-settings-crash-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let time = 1000000000;
  const badReport = () => ({ id: 'claude:a', sourceId: 'claude', sourceLabel: 'claude', account: { label: 'a' },
    fetchedAt: new Date(time).toISOString(), report: { status: 'error', error: 'no' } });
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [badReport()], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    if (path === '/push') return { accepted: true };
    return { ok: true };
  });
  t.after(() => bridge.close());
  let service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  t.after(() => service.close());
  // 账户被 unknown 锁定；做一次阈值设置使 meta 落盘 revision=1、applied_enabled=true
  let s = await call(join(home, 'guard.sock'), '/status');
  await call(join(home, 'guard.sock'), '/settings', { revision: s.settingsRevision, enabled: s.enabled, notifications: s.notifications, thresholds: { claude: { warn: 70, pause: 80 }, codex: { warn: 90, pause: 95 } } });
  assert.equal(service.engine.store.getMeta('applied_settings_revision'), 1);
  assert.equal(service.engine.store.getMeta('applied_enabled'), true);
  assert.equal(service.engine.require('claude:a').locked, true);
  // 模拟文件先落盘、事务未提交：手动写 revision=2 enabled=false，meta 仍为 1
  await service.close();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabled: false, notifications: false, thresholds: { claude: { warn: 70, pause: 80 }, codex: { warn: 90, pause: 95 } }, revision: 2 }));
  // 重启 → 协调：meta(1) < file(2) → 重新应用账户重置（解锁）
  service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  assert.equal(service.engine.require('claude:a').locked, false, '协调后账户解锁');
  assert.equal(service.engine.store.getMeta('applied_settings_revision'), 2);
  assert.equal(service.engine.store.getMeta('applied_enabled'), false);
});

test('全新数据库首次设置变更中途退出后重启协调', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-settings-first-crash-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let time = 1000000000;
  const badReport = () => ({ id: 'claude:a', sourceId: 'claude', sourceLabel: 'claude', account: { label: 'a' },
    fetchedAt: new Date(time).toISOString(), report: { status: 'error', error: 'no' } });
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'enforce', reports: [badReport()], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    if (path === '/push') return { accepted: true };
    return { ok: true };
  });
  t.after(() => bridge.close());
  let service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  t.after(() => service.close());
  // 启动即初始化基线（无 settings.json → revision 0，enabled true）
  assert.equal(service.engine.store.getMeta('applied_settings_revision'), 0);
  assert.equal(service.engine.store.getMeta('applied_enabled'), true);
  assert.equal(service.engine.require('claude:a').locked, true);
  // 模拟首次设置变更：文件已落盘 revision=1 enabled=false，账户事务未提交，meta 仍为 0
  await service.close();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabled: false, notifications: false, thresholds: { claude: { warn: 80, pause: 90 }, codex: { warn: 90, pause: 95 } }, revision: 1 }));
  // 重启 → 检测 meta(0) < file(1) → 按新设置重置账户并推进 meta
  service = await startService({ home, config: config(), bridgePath: join(home, 'paseo.sock'), now: () => time });
  assert.equal(service.engine.require('claude:a').locked, false, '首次变更崩溃后账户按新设置解锁');
  assert.equal(service.engine.store.getMeta('applied_settings_revision'), 1);
  assert.equal(service.engine.store.getMeta('applied_enabled'), false);
});

test('旧库（有账户、无 meta）启动初始化基线且不改动账户', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-old-db-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  // 旧库：有账户、无 meta（旧版升级场景）
  const seedStore = new Store(join(home, 'state.db'));
  seedStore.save({ id: 'claude:a', provider: 'claude', label: 'a', windows: [], fetchedAt: null, lastSeenAt: 1000000000,
    locked: true, reason: '额度数据缺失或过期', epoch: 1, ready: false, warned: {}, stopStatus: null, error: '额度读取失败或登录不可用' });
  seedStore.close();
  let time = 1000000000;
  const bridge = await serve(join(home, 'paseo.sock'), async path => {
    if (path === '/snapshot') return { mode: 'observe', reports: [], agents: [] };
    if (path === '/interrupt') return { complete: true, pending: [] };
    if (path === '/push') return { accepted: true };
    return { ok: true };
  });
  t.after(() => bridge.close());
  const service = await startService({ home, config: config({ mode: 'observe' }), bridgePath: join(home, 'paseo.sock'), now: () => time });
  t.after(() => service.close());
  assert.equal(service.engine.store.getMeta('applied_settings_revision'), 0);
  assert.equal(service.engine.store.getMeta('applied_enabled'), true);
  assert.equal(service.engine.require('claude:a').locked, true, '旧库账户锁定不改动');
  assert.equal(service.engine.require('claude:a').epoch, 1, '旧库账户 epoch 不改动');
  assert.equal(service.engine.require('claude:a').stopStatus, null, '旧库账户暂停状态不改动');
});
