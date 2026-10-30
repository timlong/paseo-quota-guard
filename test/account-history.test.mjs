import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { config, report } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/main.mjs';
import { serve, call } from '../src/ipc.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = Date.now(); const cfg = config();
  let engine = new Engine(cfg, store, () => now);
  return { store, get engine() { return engine; }, advance(ms = cfg.staleMs) { now += ms; },
    snapshot(ids, agents = []) { engine.ingest(ids.map(id => report('claude', 10, 10, now, id)), { agents }); },
    restart() { engine = new Engine(cfg, store, () => now); } };
}

test('旧账户转入历史但不删除或解锁；重新识别恢复到当前列表，手动暂停保留', t => {
  const f = fixture(t); f.snapshot(['old']);
  f.engine.pause('claude:old'); f.engine.stopResult('claude:old', { complete: true, pending: [], checkedCount: 0 });
  const before = structuredClone(f.engine.require('claude:old'));
  f.advance(); f.snapshot(['new']);
  assert.deepEqual(f.engine.status().accounts.map(a => a.id), ['claude:new']);
  assert.deepEqual(f.engine.status().historicalAccounts.map(a => a.id), ['claude:old']);
  for (const k of ['locked', 'pauseCause', 'epoch', 'notices', 'warningCycles', 'windows', 'fetchedAt'])
    assert.deepEqual(f.engine.require('claude:old')[k], before[k]);
  assert.equal(f.engine.admission(['claude:old']).allowed, false);
  f.restart(); assert.equal(f.engine.status().historicalAccounts.length, 1);
  f.snapshot(['old', 'new']);
  assert.equal(f.engine.status().historicalAccounts.length, 0);
  assert.equal(f.engine.require('claude:old').locked, true);
  assert.equal(f.engine.require('claude:old').pauseCause, 'manual');
  assert.equal(f.store.notificationHistory().filter(r => JSON.parse(r.body).kind === 'recovered').length, 0);
});

test('未返回账户、短暂缺失和心跳不能移走仍可见的账号', t => {
  const f = fixture(t); f.snapshot(['old']);
  f.advance(1000); f.snapshot(['new']);
  assert.equal(f.engine.status().accounts.length, 2);
  f.advance(); f.snapshot([]); f.engine.ingest([]);
  assert.equal(f.engine.status().historicalAccounts.length, 0);
});

test('有关联会话、归属不明的会话或暂停未确认时，旧账户继续显示', t => {
  const f = fixture(t); f.snapshot(['old']); f.advance();
  f.snapshot(['new'], [{ provider: 'claude', reportIds: ['claude:old'] }]);
  assert.equal(f.engine.status().historicalAccounts.length, 0);
  f.snapshot(['new'], [{ provider: 'claude', reportIds: [], protection: 'unmapped' }]);
  assert.equal(f.engine.status().historicalAccounts.length, 0);
  f.snapshot(['new']);
  assert.equal(f.engine.status().historicalAccounts.length, 0, '未确认暂停，不能收进历史');
  f.engine.stopResult('claude:old', { complete: false, pending: ['task'] });
  assert.equal(f.engine.status().historicalAccounts.length, 0);
  f.engine.stopResult('claude:old', { complete: true, pending: [], checkedCount: 0 });
  assert.equal(f.engine.status().historicalAccounts.length, 1);
});

test('同名两个真实账户都仍在采集时不合并；不同服务商不触发归档', t => {
  const f = fixture(t); f.snapshot(['a', 'b']); f.advance(); f.snapshot(['a', 'b']);
  assert.equal(f.engine.status().accounts.length, 2);
  f.advance(); f.engine.ingest([report('codex')], { agents: [] });
  assert.equal(f.engine.status().historicalAccounts.length, 0);
});

test('完整服务快照将旧锁定记录收进历史；重启和采集失败不清锁、不补发旧通知', async t => {
  const home = mkdtempSync(join(tmpdir(), 'qgh-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let now = Date.now(), fail = false; const cfg = config({ notifications: true });
  const seed = new Store(join(home, 'state.db'));
  const old = new Engine(cfg, seed, () => now);
  old.ingest([report('claude', 10, 10, now, 'old')]); old.pause('claude:old');
  old.stopResult('claude:old', { complete: true, pending: [], checkedCount: 0 }); seed.close();
  now += cfg.staleMs;
  const received = [];
  const bridge = await serve(join(home, 'paseo.sock'), async (path, body) => {
    if (path === '/snapshot') {
      if (fail) throw Error('discovery unavailable');
      return { mode: 'enforce', agents: [], reports: [{ ...report('claude', 0, 0, now, 'fallback'), report: { status: 'unavailable' } }] };
    }
    if (path === '/interrupt') return { complete: true, pending: [], checkedCount: 0 };
    if (path === '/push') { received.push(body); return { accepted: true }; }
  }); t.after(() => bridge.close());
  let service = await startService({ home, config: cfg, bridgePath: join(home, 'paseo.sock'), now: () => now });
  t.after(() => service.close());
  const rpc = (p, b) => call(join(home, 'guard.sock'), p, b);
  let s = await rpc('/status');
  assert.deepEqual(s.accounts.map(a => a.id), ['claude:fallback']);
  assert.deepEqual(s.historicalAccounts.map(a => a.id), ['claude:old']);
  assert.equal(s.historicalAccounts[0].pauseCause, 'manual');
  assert.equal(s.historicalAccounts[0].locked, true);
  assert.equal((await rpc('/admit', { reportIds: ['claude:old'] })).allowed, false);
  assert.equal(received.filter(p => p.accountId === 'claude:old').length, 0);
  await service.close(); fail = true;
  service = await startService({ home, config: cfg, bridgePath: join(home, 'paseo.sock'), now: () => now });
  s = await rpc('/status');
  assert.equal(s.historicalAccounts[0].locked, true);
  assert.equal(s.accounts[0].locked, true);
  assert.equal(received.length, 1, '不补发历史暂停或重复通知');
});
