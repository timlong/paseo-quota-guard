import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { assess, validateConfig, reportText } from '../src/policy.mjs';
import { readSettings, saveSettings, protectionDisabled } from '../src/settings.mjs';
import { config, report } from './helpers.mjs';

const split = { claude: { warn: 80, pause: 85, windows: {
  five_hour: { warn: 75, pause: 85 }, weekly: { warn: 90, pause: 95 },
} }, codex: { warn: 90, pause: 95 } };
function setup(t) {
  let now = Date.now();
  const store = new Store(':memory:'); t.after(() => store.close());
  const cfg = validateConfig(config({ thresholds: structuredClone(split) }));
  const engine = new Engine(cfg, store, () => now);
  const ingest = (five, week) => { now += 1000; engine.ingest([report('claude', five, week, now)]); };
  return { cfg, engine, store, ingest, get account() { return engine.status().accounts[0]; } };
}

test('5h/周按独立阈值判断；较小百分比窗口超线也必须暂停', t => {
  const f = setup(t);
  f.ingest(70, 89); assert.equal(f.account.assessment.level, 'normal');
  f.ingest(80, 89); assert.equal(f.account.assessment.level, 'warning');
  assert.match(f.account.assessment.reason, /^5 小时/);
  f.ingest(85, 94); assert.equal(f.account.locked, true);
  assert.match(f.account.reason, /^5 小时/);
  assert.match(reportText(f.account, f.cfg), /5 小时达到 85% 或周达到 95%/);
});

test('周窗口独立触发暂停；两个窗口均满足各自恢复线才能自动解除', t => {
  const f = setup(t);
  f.ingest(10, 95); assert.equal(f.account.locked, true); assert.match(f.account.reason, /^周/);
  f.ingest(0, 93); assert.equal(f.account.locked, true);
  assert.match(f.account.assessment.resumeReason, /5 小时须低于 83%.*周须低于 93%/);
  f.ingest(83, 92); assert.equal(f.account.locked, true);
  f.ingest(82.99, 92.99); assert.equal(f.account.locked, false);
});

test('窗口预警分别去重；周高于旧统一阈值但未到周预警线不通知', t => {
  const f = setup(t);
  f.ingest(10, 89); assert.equal(f.store.notificationHistory().length, 0);
  f.ingest(75, 89);
  let notices = f.store.notificationHistory().map(r => JSON.parse(r.body));
  assert.deepEqual(notices[0].warnings.map(w => w.id), ['five_hour']);
  // Keep the same reset cycle when the weekly warning is first reached.
  f.ingest(80, 90);
  notices = f.store.notificationHistory().map(r => JSON.parse(r.body));
  assert.equal(notices.length, 2); assert.deepEqual(notices[1].warnings.map(w => w.id), ['weekly']);
});

test('旧设置延续原阈值；分窗口设置持久化，旧客户端不得覆盖', t => {
  const home = mkdtempSync(join(tmpdir(), 'qg-window-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let cfg = validateConfig(config({ settingsRevision: 0 }));
  const legacy = { claude: { warn: 80, pause: 85 }, codex: { warn: 90, pause: 95 } };
  let s = saveSettings(home, cfg, { revision: 0, enabled: true, notifications: true, thresholds: legacy });
  assert.deepEqual(readSettings(home).thresholds, legacy);
  cfg = { ...cfg, ...s, settingsRevision: s.revision };
  const a = { provider: 'claude', fetchedAt: 1000, windows: [{ id: 'five_hour', used: 0 }, { id: 'weekly', used: 85 }] };
  assert.equal(assess(a, cfg, 1000).level, 'pause');
  s = saveSettings(home, cfg, { revision: 1, enabled: false, notifications: true, thresholds: split });
  assert.deepEqual(readSettings(home).thresholds, split);
  assert.equal(protectionDisabled(home), true);
  cfg = { ...cfg, ...s, settingsRevision: s.revision };
  assert.equal(assess(a, cfg, 1000).level, 'normal');
  assert.throws(() => saveSettings(home, cfg, { revision: 2, enabled: true, notifications: true, thresholds: legacy }), /分窗口/);
  assert.equal(readSettings(home).revision, 2);
});

test('拒绝缺失、非法或未知窗口阈值', () => {
  for (const change of [
    t => delete t.claude.windows.weekly,
    t => { t.claude.windows.weekly.pause = 90; },
    t => { t.claude.windows.five_hour.warn = NaN; },
    t => { t.claude.windows.extra = { warn: 80, pause: 90 }; },
  ]) {
    const thresholds = structuredClone(split); change(thresholds);
    assert.throws(() => validateConfig(config({ thresholds })), /阈值/);
  }
});
