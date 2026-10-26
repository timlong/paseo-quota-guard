import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { validateConfig } from '../src/policy.mjs';
import { config, report } from './helpers.mjs';

function setup(t) {
  let now = Date.now();
  const cfg = validateConfig(config()); const store = new Store(':memory:'); t.after(() => store.close());
  let engine = new Engine(cfg, store, () => now);
  return { cfg, store, get engine() { return engine; }, get account() { return engine.status().accounts[0]; },
    good: (used = 18, week = 80) => engine.ingest([report('claude', used, week, now)]),
    fail: (error = 'Rate limited by Claude. Try again in 15m.') => engine.ingest([
      { ...report('claude', 0, 0, now), report: { status: 'error', error } },
    ]),
    advance: ms => { now += ms; engine.ingest([]); },
    restart: () => { engine = new Engine(cfg, store, () => now); engine.ingest([]); },
  };
}

test('失败与重启不刷新缓存时间，满 10 分钟即暂停；新有效读数恢复且只通知一次', t => {
  const f = setup(t); f.good();
  f.advance(300000); f.fail();
  const fetchedAt = f.account.fetchedAt;
  assert.equal(f.account.locked, false);
  f.advance(299999); f.fail(); f.restart();
  assert.equal(f.account.locked, false); assert.equal(f.account.fetchedAt, fetchedAt);
  assert.equal(f.engine.admission([f.account.id]).allowed, true);
  assert.equal(f.account.windows[0].used, 18, '失败不伪造零用量');
  f.advance(1); assert.equal(f.account.locked, true); assert.equal(f.account.pauseCause, 'unavailable');
  assert.equal(f.account.assessment.level, 'unknown');
  assert.equal(f.account.assessment.canResume, false);
  assert.equal(f.engine.admission([f.account.id]).allowed, false);
  const event = f.store.events().find(e => e.kind === 'pause_requested');
  assert.equal(event.body.errorCode, 'rate_limited'); assert.equal(event.body.windows[0].used, 18);
  f.restart(); assert.equal(f.account.locked, true);
  f.advance(1); f.good(); assert.equal(f.account.locked, false);
  assert.match(JSON.parse(f.store.notificationHistory().find(r => JSON.parse(r.body).kind === 'recovered').body).title, /额度查询已恢复/);
  f.restart(); f.good();
  assert.equal(f.store.notificationHistory().filter(r => JSON.parse(r.body).kind === 'recovered').length, 1);
});

test('10 分钟内读取恢复不产生虚假的暂停/恢复通知；新超限读数立即暂停', t => {
  const f = setup(t); f.good(); f.advance(300000); f.fail('timed out');
  f.good(); assert.equal(f.account.locked, false);
  assert.equal(f.store.events().some(e => e.kind === 'pause_requested'), false);
  assert.equal(f.store.notificationHistory().some(r => JSON.parse(r.body).kind === 'recovered'), false);
  f.advance(300000); f.fail(); f.good(90, 80);
  assert.equal(f.account.locked, true); assert.equal(f.account.pauseCause, 'quota');
});

test('异常暂停必须新读数且满足全部恢复线；手动暂停不被自动恢复', t => {
  const f = setup(t); f.good(); f.advance(600000);
  assert.equal(f.account.locked, true);
  f.fail(); assert.equal(f.account.locked, true);
  f.advance(1); f.good(1, 88); assert.equal(f.account.locked, true);
  f.good(1, 87); assert.equal(f.account.locked, false);
  f.engine.pause(f.account.id); f.advance(1000); f.good(1, 1);
  assert.equal(f.account.locked, true); assert.equal(f.account.pauseCause, 'manual');
});

test('没有历史有效窗口立即保护；过期缓存不得用于手动恢复', t => {
  const f = setup(t); f.fail(); assert.equal(f.account.locked, true);
  assert.equal(f.engine.admission(['missing']).allowed, false);
  f.advance(1); f.good(); assert.equal(f.account.locked, false);
  f.engine.pause(f.account.id); f.advance(600000);
  assert.throws(() => f.engine.resume(f.account.id), /过期/);
  assert.equal(f.engine.admission([f.account.id]).allowed, false);
});
