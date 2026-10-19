import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { normalizeReport, validateConfig } from '../src/policy.mjs';
import { config, report } from './helpers.mjs';

function fixture(t, extra = {}) {
  let time = 1000000000;
  const store = new Store(':memory:'); t.after(() => store.close());
  const engine = new Engine(config(extra), store, () => time);
  return { engine, store, now: () => time, advance: n => { time += n; } };
}
for (const [provider, warn, pause] of [['claude', 80, 90], ['codex', 90, 95]]) {
  for (const weekly of [false, true]) {
    test(`${provider} ${weekly ? '周' : '5h'} 精确边界`, t => {
      const f = fixture(t); const id = `${provider}:a`;
      const input = n => weekly ? report(provider, 0, n, f.now()) : report(provider, n, 0, f.now());
      f.engine.ingest([input(warn - 0.01)]);
      assert.equal(f.store.pending(f.now()).length, 0);
      f.engine.ingest([input(warn)]);
      assert.equal(f.store.pending(f.now()).length, 1);
      f.engine.ingest([input(warn)]);
      assert.equal(f.store.pending(f.now()).length, 1, '重复采集不重复预警');
      assert.equal(f.engine.admission([id]).allowed, true);
      f.engine.ingest([input(pause)]);
      assert.equal(f.engine.admission([id]).allowed, false);
      assert.equal(f.engine.require(id).stopStatus, null, '未核验不得声称已停止');
    });
  }
}
test('账户隔离、服务商隔离和未知账户禁止', t => {
  const f = fixture(t);
  f.engine.ingest([report('claude', 90, 0, f.now()), report('claude', 10, 0, f.now(), 'b'), report('codex', 90, 0, f.now())]);
  assert.equal(f.engine.admission(['claude:a']).allowed, false);
  assert.equal(f.engine.admission(['claude:b']).allowed, true);
  assert.equal(f.engine.admission(['codex:a']).allowed, true);
  assert.equal(f.engine.admission(['missing']).allowed, false);
  assert.equal(f.engine.admission([]).allowed, false);
});
test('5h 重置但周额度仍超限不能恢复；恢复不自动续跑', t => {
  const f = fixture(t); const id = 'claude:a';
  f.engine.ingest([report('claude', 91, 92, f.now())]);
  f.engine.ingest([report('claude', 0, 92, f.now())]);
  assert.throws(() => f.engine.resume(id));
  f.engine.ingest([report('claude', 0, 88, f.now())]);
  assert.throws(() => f.engine.resume(id));
  f.engine.ingest([report('claude', 0, 87, f.now())]);
  assert.equal(f.engine.require(id).locked, true);
  assert.equal(f.engine.require(id).ready, true);
  f.engine.resume(id);
  assert.equal(f.engine.admission([id]).allowed, true);
});
test('手动暂停是持久状态，额度低也不自动恢复', t => {
  const f = fixture(t); f.engine.ingest([report('codex', 1, 1, f.now())]);
  f.engine.pause('codex:a');
  const restored = new Engine(config(), f.store, f.now);
  restored.ingest([report('codex', 1, 1, f.now())]);
  assert.equal(restored.admission(['codex:a']).allowed, false);
  assert.equal(restored.require('codex:a').ready, true);
});
test('数据过期保护；错误不是 0%；旧读数不得倒退', t => {
  const f = fixture(t); f.engine.ingest([report('claude', 30, 20, f.now())]);
  f.advance(1000);
  f.engine.ingest([{ ...report('claude', 0, 0, f.now()), report: { status: 'error', error: 'no' } }]);
  assert.equal(f.engine.require('claude:a').windows[0].used, 30);
  const stale = f.engine.config.staleMs;
  f.advance(stale - 2000); f.engine.ingest([]);
  assert.equal(f.engine.admission(['claude:a']).allowed, true, '有效期内采集失败仍沿用上次读数');
  f.advance(2000); f.engine.ingest([]);
  assert.equal(f.engine.admission(['claude:a']).allowed, false);
  f.engine.ingest([report('claude', 1, 1, f.now() - stale * 3)]);
  assert.equal(f.engine.require('claude:a').windows[0].used, 30);
});
test('不根据重置倒计时猜测 Codex 额度窗口', () => {
  const r = report('codex'); r.report.windows[0].id = 'unknown_primary';
  assert.equal(normalizeReport(r, Date.now()).fetchedAt, null);
});
test('null、NaN、重复窗口、未来时间均无有效额度', () => {
  for (const change of [r => r.report.windows[0].usedPct = null, r => r.report.windows[0].usedPct = NaN,
    r => r.report.windows[0].id = 'weekly', r => r.fetchedAt = new Date(Date.now() + 60000).toISOString()]) {
    const r = report(); change(r); assert.equal(normalizeReport(r, Date.now()).fetchedAt, null);
  }
});
test('观察模式不阻止、不入生产通知队列、不执行手动暂停', t => {
  const f = fixture(t, { mode: 'observe' }); f.engine.ingest([report('claude', 99, 99, f.now())]);
  assert.equal(f.engine.admission(['claude:a']).allowed, true);
  assert.equal(f.store.pending(f.now()).length, 0);
  assert.throws(() => f.engine.pause('claude:a'));
});
test('暂停失败与成功分别记录，重试不重复通知', t => {
  const f = fixture(t); f.engine.ingest([report('claude', 91, 0, f.now())]);
  f.engine.stopResult('claude:a', { complete: false, pending: ['agent'] });
  f.engine.stopResult('claude:a', { complete: false, pending: ['agent'] });
  assert.equal(f.store.pending(f.now()).length, 1);
  assert.equal(f.engine.require('claude:a').stopStatus, 'partial');
  f.engine.stopResult('claude:a', { complete: true, pending: [] });
  assert.equal(f.engine.require('claude:a').stopStatus, 'paused');
  assert.equal(f.store.pending(f.now()).length, 2);
});
test('配置校验拒绝无效阈值和轮询间隔', () => {
  assert.throws(() => validateConfig(config({ thresholds: { claude: { warn: 90, pause: 80 } } })));
  assert.throws(() => validateConfig(config({ activePollMs: 999999 })));
});

test('用户确认：Codex 仅保护实际返回窗口，零窗口仍保护暂停', t => {
  const f=fixture(t); const r=report('codex',0,90,f.now());r.report.windows=r.report.windows.filter(w=>w.id==='weekly');
  f.engine.ingest([r]);assert.equal(f.engine.admission(['codex:a']).allowed,true);
  assert.equal(f.store.pending(f.now()).length,1);
  r.report.windows[0].usedPct=95;f.engine.ingest([r]);assert.equal(f.engine.admission(['codex:a']).allowed,false);
  const empty=report('codex',0,0,f.now(),'empty');empty.report.windows=[];f.engine.ingest([empty]);
  assert.equal(f.engine.admission(['codex:empty']).allowed,false);
});

test('很低的自定义暂停线仍可在额度归零后手动恢复', t => {
 const f=fixture(t,{thresholds:{claude:{warn:0.1,pause:1},codex:{warn:90,pause:95}}});
 f.engine.ingest([report('claude',1,0,f.now())]);
 assert.equal(f.engine.admission(['claude:a']).allowed,false);
 f.engine.ingest([report('claude',0,0,f.now())]);f.engine.resume('claude:a');
 assert.equal(f.engine.admission(['claude:a']).allowed,true);
});

test('采集错误按原因区分：限流、超时、登录失效、其他', () => {
  const failed = (report) => normalizeReport({ ...report_(), report }, Date.now()).error;
  const report_ = () => { const r = report(); delete r.report; return r; };
  assert.equal(failed({ status: 'error', error: 'Rate limited by Claude. Try again in 1m.' }), '额度接口限流，暂时沿用上次读数');
  assert.equal(failed({ status: 'error', error: 'Codex usage API cooling down after 429' }), '额度接口限流，暂时沿用上次读数');
  assert.equal(failed({ status: 'error', error: 'Usage fetch timed out' }), '额度读取超时，暂时沿用上次读数');
  assert.equal(failed({ status: 'unavailable', problem: { kind: 'expired' } }), '登录失效或额度不可用');
  assert.equal(failed({ status: 'error', error: 'Claude usage API returned 500' }), '额度读取失败');
  assert.equal(failed(undefined), '额度读取失败');
});
