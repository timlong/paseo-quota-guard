// Loaded only by the version-checked, isolated Paseo 0.11.2 patch.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { call, serve } from './ipc.mjs';
import { protectionDisabled } from './settings.mjs';

const tracked = new Set();
let host = null;
const guardedMethods = new Set(['run', 'startTurn', 'steerActiveTurn', 'tryHandleOutOfBand', 'respondToPermission']);

export function protectedScope(session) {
  const s = session.usageSession?.();
  if (!s || !['claude', 'codex'].includes(s.provider)) return null;
  const env = s.env ?? {};
  const enabled = v => ['1', 'true', 'yes'].includes(String(v).toLowerCase());
  if (s.provider === 'claude' && (enabled(env.CLAUDE_CODE_USE_BEDROCK) || enabled(env.CLAUDE_CODE_USE_VERTEX) ||
      (env.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)))) return null;
  if (s.provider === 'codex' && env.OPENAI_BASE_URL) return null;
  return s;
}

function enforceAdmission(target) {
  if (process.env.PASEO_QUOTA_GUARD_MODE !== 'enforce' || protectionDisabled(process.env.PASEO_QUOTA_GUARD_HOME) || !protectedScope(target)) return;
  if (!host) throw new Error('额度保护尚未就绪，已阻止请求');
  return host.admit(target);
}

export function guardSession(inner) {
  if (!process.env.PASEO_QUOTA_GUARD_HOME) return inner;
  tracked.add(inner);
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'close') return async (...args) => { try { return await value.apply(target, args); } finally { tracked.delete(target); } };
      if (!guardedMethods.has(prop)) return value.bind(target);
      if (prop === 'tryHandleOutOfBand') return (...args) => {
        const handler = value.apply(target, args);
        if (!handler || typeof handler.run !== 'function') return handler;
        const wrapped = Object.create(handler);
        wrapped.run = async (...runArgs) => { const gate = enforceAdmission(target); if (gate) await gate; return handler.run.apply(handler, runArgs); };
        return wrapped;
      };
      return async (...args) => { const gate = enforceAdmission(target); if (gate) await gate; return value.apply(target, args); };
    },
  });
}

export function providerRunning(s) {
  return Boolean(s.mainTurnInFlight || s.currentTurnId || s.activeForegroundTurnId || s.autonomousTurn || s.pendingForegroundStart);
}

export async function startBridge({ manager, runtime, paseoHome, serverId, logger, home = process.env.PASEO_QUOTA_GUARD_HOME,
  mode = process.env.PASEO_QUOTA_GUARD_MODE ?? 'observe', fetchImpl = fetch, watchdogMs = 10000, watchdogTimeoutMs = 30000 }) {
  if (!home) return { close: async () => {} };
  if (!['observe', 'enforce'].includes(mode)) throw new Error('无效额度保护模式');
  const guardPath = join(home, 'guard.sock');
  const guard = (p, b) => call(guardPath, p, b, 5000);
  const mapping = new Map();
  let watchdogBusy = false, lastHealthy = Date.now();
  function entries() { return [...manager.agents.values()].filter(a => a.session && protectedScope(a.session)); }
  function nativeFor(a) {
    const key = a.session.usageSession?.()?.sessionKey;
    return [...tracked].find(s => s.usageSession?.()?.sessionKey === key) ?? a.session;
  }
  async function reportsFor(a, forceRefresh = false) {
    const reports = await runtime.listUsageReports({ agentId: a.id, forceRefresh });
    const filtered = reports.filter(r => ['claude', 'codex'].includes(r.sourceId));
    mapping.set(a.id, filtered.map(r => r.id));
    return filtered;
  }
  function children(a) { return manager.providerSubagents?.list(a.id).filter(c => c.status === 'running') ?? []; }
  async function interruptAgents(selected) {
    const failures = [];
    await Promise.all(selected.map(async a => {
      const inner = nativeFor(a);
      try {
        const tasks = children(a);
        if (inner.query?.stopTask) {
          for (const task of tasks) {
            try { await inner.query.stopTask(task.id); } catch { failures.push(`${a.id}:子任务中断失败`); }
          }
        }
        // Direct interrupt also catches provider work after Paseo's foreground bookkeeping settled.
        await Promise.race([inner.interrupt(), new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('中断超时')), 10000); t.unref();
        })]);
      } catch { failures.push(`${a.id}:中断未确认`); }
    }));
    const deadline = Date.now() + 5000;
    let pending;
    do {
      pending = selected.filter(a => providerRunning(nativeFor(a)) || children(a).length > 0).map(a => a.id);
      if (!pending.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return { complete: pending.length === 0 && failures.length === 0, pending, failures, checkedCount: selected.length };
  }
  async function snapshot(forceRefresh) {
    if (!runtime) throw new Error('Paseo 插件运行时不可用');
    const agents = entries();
    const reportMap = new Map();
    // Discovery first; force refresh each account only once even with many agents.
    const globalReports = await runtime.listUsageReports();
    for (const r of globalReports) if (['claude', 'codex'].includes(r.sourceId)) reportMap.set(r.id, r);
    const summaries = [];
    for (const a of agents) {
      let rs = [];
      try { rs = await reportsFor(a); for (const r of rs) reportMap.set(r.id, r); } catch { mapping.delete(a.id); }
      summaries.push({ id: a.id, workspaceId: a.workspaceId ?? null, provider: a.provider,
        running: providerRunning(nativeFor(a)) || children(a).length > 0, reportIds: rs.map(r => r.id),
        protection: rs.length ? 'mapped' : 'unmapped' });
    }
    if (forceRefresh && reportMap.size) {
      for (const r of await runtime.listUsageReports({ reportIds: [...reportMap.keys()], forceRefresh: true })) reportMap.set(r.id, r);
    }
    return { reports: [...reportMap.values()], agents: summaries, mode };
  }
  const ledgerPath = join(home, 'push-ledger.json');
  let ledger = {};
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch {}
  async function push(payload) {
    if (mode !== 'enforce' && payload.kind !== 'test') throw new Error('观察模式不推送生产通知');
    if (typeof payload.key !== 'string' || typeof payload.title !== 'string' || typeof payload.body !== 'string' ||
        payload.title.length > 100 || payload.body.length > 2000) throw new Error('通知内容无效');
    // Read through the daemon-owned subscription file; do not rotate/rewrite subscriptions.
    let subscriptions;
    try { subscriptions = JSON.parse(readFileSync(join(paseoHome, 'push-tokens.json'), 'utf8')).subscriptions ?? []; }
    catch { return { accepted: false, reason: '手机未注册推送或订阅不可读' }; }
    const tokens = [...new Set(subscriptions.filter(s => Date.parse(s.expiresAt) > Date.now()).map(s => s.token))];
    if (!tokens.length) return { accepted: false, reason: '没有有效的手机推送订阅，请打开 Paseo 并启用通知' };
    const target = entries().find(a => mapping.get(a.id)?.includes(payload.accountId) && !a.internal && a.workspaceId);
    let ok = true;
    for (const token of tokens) {
      const digest = createHash('sha256').update(payload.key + '\0' + token).digest('hex');
      if (ledger[digest]) continue;
      const response = await fetchImpl('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify([{ to: token, title: payload.title, body: payload.body, sound: 'default',
          data: { serverId, ...(target ? { workspaceId: target.workspaceId, agentId: target.id } : {}), reason: 'quota',
            pluginId: 'quota-guard', accountId: payload.accountId } }]),
      });
      if (!response.ok) { ok = false; continue; }
      const result = await response.json();
      if (result.data?.[0]?.status !== 'ok') { ok = false; continue; }
      ledger[digest] = Date.now();
      ledger = Object.fromEntries(Object.entries(ledger).filter(([, at]) => Date.now() - at < 14 * 86400000));
      writeFileSync(ledgerPath + '.tmp', JSON.stringify(ledger), { mode: 0o600 }); renameSync(ledgerPath + '.tmp', ledgerPath);
    }
    return { accepted: ok, delivery: 'unconfirmed', targetAvailable: Boolean(target) };
  }
  host = {
    async admit(session) {
      if (protectionDisabled(home)) return;
      const scope = protectedScope(session);
      if (!scope) return;
      const a = entries().find(a => a.session.usageSession?.()?.sessionKey === scope.sessionKey);
      if (!a) throw new Error('无法确定额度归属，已阻止请求');
      const rs = await reportsFor(a);
      const decision = await guard('/admit', { reportIds: rs.map(r => r.id) });
      if (decision.mode && decision.mode !== mode) throw new Error('监控与执行层模式不一致');
      if (!decision.allowed) throw new Error(`额度保护：${decision.reason}。请打开“额度保护”查看。`);
    },
  };
  const server = await serve(join(home, 'paseo.sock'), async (path, body) => {
    if (path === '/health') return { ok: true, mode, version: '0.11.2' };
    if (path === '/snapshot') return snapshot(Boolean(body.forceRefresh));
    if (path === '/push') return push(body);
    if (path === '/interrupt') {
      if (protectionDisabled(home)) return { complete: true, pending: [], disabled: true };
      if (mode !== 'enforce') throw new Error('执行层处于观察模式');
      const selected = [];
      for (const a of entries()) {
        const rs = await reportsFor(a); // Never trust a stale account-to-session mapping before stopping.
        if (rs.some(r => r.id === body.accountId)) selected.push(a);
      }
      return interruptAgents(selected);
    }
    throw new Error('未知桥接操作');
  });
  const timer = setInterval(async () => {
    if (watchdogBusy || mode !== 'enforce') return;
    if (protectionDisabled(home)) { lastHealthy = Date.now(); return; }
    watchdogBusy = true;
    try {
      try {
        const health = await guard('/health');
        if (!health.ok || health.mode !== mode) throw new Error('监控未就绪');
        lastHealthy = Date.now();
      }
      catch {
        if (!protectionDisabled(home) && Date.now() - lastHealthy >= watchdogTimeoutMs)
          await interruptAgents(entries().filter(a => providerRunning(nativeFor(a)) || children(a).length > 0));
      }
    } catch { logger?.warn('额度保护 watchdog 无法完成中断'); }
    finally { watchdogBusy = false; }
  }, watchdogMs);
  timer.unref();
  return { snapshot, push, close: async () => {
    clearInterval(timer); host = null; await server.close();
    while (watchdogBusy) await new Promise(resolve => setTimeout(resolve, 20));
  } };
}
