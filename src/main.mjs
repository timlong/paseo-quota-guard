import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assess, reportText, validateConfig } from './policy.mjs';
import { warningIsCurrent } from './warnings.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { call, serve } from './ipc.mjs';
import { readSettings, saveSettings, restoreSettings } from './settings.mjs';
import { readCredits, consumeCredit } from './codex-account.mjs';
import { createCreditReset } from './codex-reset.mjs';

export async function startService({ home, config, bridgePath, now = Date.now, codex = null, stopNoticeMs = 60000 }) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const saved = readSettings(home);
  config = { ...config, enabled: true, ...saved, settingsRevision: saved?.revision ?? 0 };
  const store = new Store(join(home, 'state.db'));
  const engine = new Engine(validateConfig(config), store, now, { stopNoticeMs });
  // 启动协调：meta 缺失（新库或旧版升级）时以当前设置初始化基线，视现有账户为已按当前设置应用；
  // 否则设置文件先落盘、账户事务后提交，若进程在两步之间退出，DB 落后于设置文件时按当前设置重放账户重置。
  if (store.getMeta('applied_settings_revision') === undefined) {
    store.transaction(() => {
      store.setMeta('applied_settings_revision', engine.config.settingsRevision);
      store.setMeta('applied_enabled', engine.config.enabled);
    });
  }
  if (store.getMeta('applied_settings_revision') < engine.config.settingsRevision) {
    store.transaction(() => {
      engine.resetAccountsForSettings(engine.config.enabled, store.getMeta('applied_enabled'));
      store.setMeta('applied_settings_revision', engine.config.settingsRevision);
      store.setMeta('applied_enabled', engine.config.enabled);
    });
  }
  const bridge = (path, body) => call(bridgePath, path, body);
  let stopped = false, busy = false, lastPoll = 0, lastError = null, tickStarted = 0, lastActivity = -Infinity, bridgeMode = null;
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  async function stopAccounts() {
    if (config.mode !== 'enforce' || !config.enabled) return;
    // Start all interruptions before any push; notification latency must not delay task stopping.
    const attempts = [...engine.accounts.values()].filter(a => a.locked).map(a => ({ a,
      interrupt: bridge('/interrupt', { accountId: a.id }).catch(() =>
        ({ complete: false, error: '无法联系 Paseo 执行中断', pending: [] })),
    }));
    for (const { a, interrupt } of attempts) {
      let timer;
      const slow = Symbol('slow');
      try {
        let result = await Promise.race([interrupt, new Promise(resolve => {
          timer = setTimeout(() => resolve(slow), stopNoticeMs);
        })]);
        if (result === slow) {
          engine.stopPending(a.id, true);
          await deliver();
          result = await interrupt;
        }
        engine.stopResult(a.id, result);
        // A slow or unavailable account must not hold back another account's result notification.
        await deliver();
      } finally { clearTimeout(timer); }
    }
  }
  async function deliver() {
    if (!config.enabled || !config.notifications || config.mode !== 'enforce') return;
    for (const job of store.pending(now())) {
      const payload = JSON.parse(job.body); const a = engine.accounts.get(payload.accountId);
      const assessment = a && assess(a, config, now());
      if (!a || (payload.kind === 'warning' && (a.locked || assessment.level !== 'warning' ||
          (a.error && !assessment.usingCachedReading) || !warningIsCurrent(a, payload.warnings, config))) ||
          ['stopping', 'ready'].includes(payload.kind) ||
          (payload.kind === 'partial' && (!a.locked || a.stopStatus !== 'partial')) ||
          (payload.kind === 'paused' && (!a.locked || a.stopStatus !== 'paused')) ||
          (payload.kind === 'recovered' && (a.locked || !assessment.canResume)) || (payload.epoch !== a.epoch && payload.kind !== 'warning')) {
        store.cancel(job.key); continue;
      }
      // Settings do not create new event identities. Render pending warnings using current thresholds.
      if (payload.kind === 'warning') payload.body = `${reportText(a, config)} 打开 Paseo 的“额度保护”查看或操作。`;
      try {
        const r = await bridge('/push', { ...payload, key: job.key });
        if (!r.accepted) throw new Error('推送未被网关受理');
        store.complete(job.key);
        store.audit('push_submitted', { accountId: a.id, kind: payload.kind, delivery: 'unconfirmed' }, now());
      } catch { store.retry(job.key, job.attempts + 1, now()); }
    }
  }
  async function tick(force = false) {
    if (busy || stopped) return false;
    busy = true; tickStarted = now();
    let refreshed = false;
    try {
      const active = engine.agents.some(a => a.running) || now() - lastActivity < config.activePollMs * 2;
      if (force || now() - lastPoll >= (active ? config.activePollMs : config.idlePollMs)) {
        lastPoll = now();
        try {
          const snapshot = await bridge('/snapshot', { forceRefresh: true });
          bridgeMode = snapshot.mode ?? null;
          if (bridgeMode !== config.mode) throw new Error('监控与执行层模式不一致');
          await serial(() => {
            engine.ingest(snapshot.reports); engine.agents = snapshot.agents; engine.lastSnapshot = now();
            if (lastError) store.audit('snapshot_restored', {}, now());
            lastError = null;
            refreshed = true;
          });
        } catch (e) {
          const error = bridgeMode !== null && bridgeMode !== config.mode ? '监控与执行层模式不一致，保护未就绪' : 'Paseo 不可连接或额度采集失败';
          if (error !== lastError) store.audit('snapshot_failed', {
            reason: /超时|timed? ?out/i.test(e?.message ?? '') ? 'timeout' : error.includes('模式') ? 'mode_mismatch' : 'bridge_unavailable',
          }, now());
          lastError = error;
        }
      }
      await serial(async () => { engine.ingest([]); await stopAccounts(); await deliver(); });
    } finally { busy = false; }
    return refreshed;
  }
  const codexApi = codex ?? { read: () => readCredits(config.codexCommand), consume: (id, key) => consumeCredit(config.codexCommand, id, key) };
  const codexCredits = new Map();
  async function loadCredits(accountId) {
    const a = engine.accounts.get(accountId);
    if (!a || a.provider !== 'codex') throw new Error('不是已采集的 Codex 账户');
    const summary = { ...await codexApi.read(), fetchedAt: now() };
    // The local Codex login must be the very account shown; never redeem another account's credit.
    if (`codex:${summary.accountId}` !== accountId) throw new Error('本机 Codex 登录的账户与该账户不一致，不能读取或重置');
    codexCredits.set(accountId, summary);
    return summary;
  }
  const resetCredit = createCreditReset({ store, now, loadCredits, consume: (id, key) => codexApi.consume(id, key),
    invalidate: id => codexCredits.delete(id),
    refreshUsage: async id => {
      if (!await tick(true) || engine.require(id).error) throw new Error('额度尚未成功刷新');
    },
  });
  const server = await serve(join(home, 'guard.sock'), async (path, body) => {
    if (path === '/health') return { ok: !busy || now() - tickStarted < config.heartbeatTimeoutMs, mode: config.mode, time: now() };
    if (path === '/status') return { ...engine.status(), codexCredits: Object.fromEntries(codexCredits), lastError, bridgeMode, enforcementReady: config.enabled && config.mode === 'enforce' && bridgeMode === 'enforce' && lastError === null };
    if (path === '/settings') return serial(async () => {
      const previous = config.enabled;
      const previousFile = readSettings(home);
      if (store.getMeta('applied_settings_revision') === undefined) {
        // 防御性：写文件前确保存在变更前基线，使“文件已落盘、账户事务未提交”的退出窗口重启时可被检测重放。
        store.transaction(() => {
          store.setMeta('applied_settings_revision', config.settingsRevision ?? 0);
          store.setMeta('applied_enabled', config.enabled);
        });
      }
      const saved = saveSettings(home, config, body);
      const snapshot = new Map([...engine.accounts.values()].map(a => [a.id, { ...a }]));
      try {
        store.transaction(() => {
          engine.resetAccountsForSettings(saved.enabled, previous);
          store.audit('settings_changed', saved, now());
          store.setMeta('applied_settings_revision', saved.revision);
          store.setMeta('applied_enabled', saved.enabled);
        });
      } catch (e) {
        // 事务回滚：恢复内存账户对象与设置文件，让请求失败且不留下部分应用。
        for (const [id, snap] of snapshot) engine.accounts.set(id, { ...snap });
        restoreSettings(home, previousFile);
        throw e;
      }
      Object.assign(config, saved, { settingsRevision: saved.revision });
      engine.ingest([]);
      await stopAccounts(); await deliver();
      return engine.status();
    });
    if (path === '/admit') {
      // Read-only, never waits for a snapshot/interruption that may itself be waiting for this gate.
      lastActivity = now();
      return engine.admission(body.reportIds);
    }
    if (path === '/pause') return serial(async () => { engine.pause(body.accountId); await stopAccounts(); await deliver(); return engine.status(); });
    if (path === '/resume') {
      if (!config.enabled || config.mode !== 'enforce') throw new Error('额度保护未开启或当前为观察模式');
      const snapshot = await bridge('/snapshot', { forceRefresh: true });
      if (snapshot.mode !== config.mode) throw new Error('监控与执行层模式不一致');
      if (!snapshot.reports.some(r => r.id === body.accountId)) throw new Error('本次刷新未返回该账户，不能恢复');
      return serial(() => { engine.ingest(snapshot.reports); engine.resume(body.accountId); return engine.status(); });
    }
    if (path === '/refresh') { await tick(true); return { ...engine.status(), lastError }; }
    if (path === '/codex-credits') {
      const cached = codexCredits.get(body.accountId);
      if (!body.force && cached && now() - cached.fetchedAt < 600000) return cached;
      return loadCredits(body.accountId);
    }
    if (path === '/codex-reset') return resetCredit(body);
    if (path === '/test-push') {
      if (!config.notifications) throw new Error('通知未启用');
      return bridge('/push', { key: `test:${now()}`, title: '额度保护测试通知', body: '请打开 Paseo 的“额度保护”页面。此通知没有暂停任何任务。', kind: 'test' });
    }
    throw new Error('未知操作');
  });
  const interval = setInterval(() => tick().catch(() => { lastError = '监控循环失败'; }), config.heartbeatMs);
  await tick(true);
  return { engine, tick, close: async () => {
    stopped = true; clearInterval(interval); await server.close();
    while (busy) await new Promise(resolve => setTimeout(resolve, 20));
    await queue; store.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.QUOTA_GUARD_HOME ?? join(homedir(), '.local/state/paseo-quota-guard');
  const cfgPath = process.env.QUOTA_GUARD_CONFIG ?? fileURLToPath(new URL('../config/default.json', import.meta.url));
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const service = await startService({ home, config, bridgePath: process.env.QUOTA_GUARD_BRIDGE ?? join(home, 'paseo.sock') });
  console.log(`额度保护已启动：${config.mode}；配置 ${cfgPath}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
