import { assess, normalizeReport, reportText } from './policy.mjs';
import { migrateWarnings, updateWarningCycles } from './warnings.mjs';

export class Engine {
  constructor(config, store, now = Date.now, { stopNoticeMs = 60000 } = {}) {
    this.config = config; this.store = store; this.now = now;
    this.stopNoticeMs = stopNoticeMs;
    this.accounts = store.load(); this.agents = []; this.lastSnapshot = null;
    const loadTime = this.now();
    for (const a of this.accounts.values()) if (!Number.isFinite(a.lastSeenAt)) a.lastSeenAt = loadTime;
    // Migrate atomically: retain previously warned periods and suppress legacy jitter backlog.
    this.store.transaction(() => {
      for (const a of this.accounts.values()) {
        migrateWarnings(a); a.notices ??= {};
        a.pauseCause ??= a.reason === '用户手动暂停' ? 'manual' : /^(5 小时|周)额度已用 /.test(a.reason ?? '') ? 'quota' : 'unavailable';
        if (a.locked) a.stopStartedAt ??= loadTime;
      }
      for (const row of this.store.notificationHistory().reverse()) {
        const payload = JSON.parse(row.body);
        if (['stopping', 'ready'].includes(payload.kind)) { this.store.cancel(row.key); continue; }
        if (payload.notificationVersion >= 2) continue;
        const a = this.accounts.get(payload.accountId);
        if (payload.kind === 'warning') {
          // Old settings writes cleared warned. Recover the latest known period from the outbox too.
          const prefix = `${payload.accountId}:warning:`;
          const match = row.key.startsWith(prefix) && row.key.slice(prefix.length).match(/^(five_hour|weekly):(.*):settings:\d+$/);
          if (a && match && !a.warningCycles[match[1]]) {
            const at = Date.parse(match[2]);
            a.warningCycles[match[1]] = { anchor: Number.isFinite(at) ? at : null, generation: 1, warned: true, observedAt: null };
          }
          this.store.cancel(row.key);
        }
        else if (a && payload.epoch === a.epoch) a.notices[payload.kind] = payload.epoch;
      }
      for (const a of this.accounts.values()) this.store.save(a);
    });
  }
  notice(a, kind, suffix, text, extra = {}) {
    if (this.config.mode !== 'enforce' || this.config.enabled === false) return;
    a.notices ??= {};
    if (kind !== 'warning' && a.notices[kind] === a.epoch) return;
    if (kind !== 'warning') a.notices[kind] = a.epoch;
    const details = {
      paused: a.stopDetails?.checkedCount === 0 ? '新请求已受限，本次未发现可中断的关联任务。' : '新请求已受限；本次已核验的关联任务已停止。',
      partial: '新请求已受限，部分关联任务未停止或无法确认，请打开页面检查。',
      recovered: extra.recoveryCause === 'unavailable'
        ? '额度查询已恢复，新读数满足恢复条件，已自动解除异常暂停。可以进入原会话继续，旧任务不会自动续跑。'
        : '额度已恢复到可用范围，已自动解除额度保护暂停。可以进入原会话继续，旧任务不会自动续跑。',
    };
    const context = ['paused', 'partial'].includes(kind)
      ? `${a.pauseContext?.usage ?? reportText(a, this.config)} 原因：${a.reason}。` : reportText(a, this.config);
    this.store.enqueue(`${a.id}:${kind}:${suffix}`, {
      notificationVersion: 3,
      settingsRevision: this.config.settingsRevision ?? 0,
      accountId: a.id, epoch: a.epoch, kind,
      title: `${a.provider === 'claude' ? 'Claude' : 'Codex'} ${text}`,
      body: `${context} ${details[kind] ?? ''} 打开 Paseo 的“额度保护”查看或操作。`,
      ...extra,
    }, this.now());
  }
  ingest(entries, { agents } = {}) {
    const now = this.now();
    this.store.transaction(() => {
      const refreshed = new Set();
      for (const entry of entries) {
        const r = normalizeReport(entry, now, this.config);
        if (!r || typeof r.id !== 'string' || r.id.length > 256) continue;
        let a = this.accounts.get(r.id);
        if (!a) a = { id: r.id, provider: r.provider, label: r.label, windows: [], fetchedAt: null, lastSeenAt: now,
          locked: false, reason: '', epoch: 0, ready: false, warned: {}, stopStatus: null, error: null };
        if (a.provider !== r.provider) throw new Error('账户服务商标识变化');
        a.lastSeenAt = now;
        if (r.fetchedAt !== null && a.fetchedAt !== null && r.fetchedAt < a.fetchedAt) continue;
        if (r.fetchedAt !== null) {
          a.windows = r.windows; a.fetchedAt = r.fetchedAt; a.label = r.label;
          refreshed.add(a.id);
        }
        a.error = r.error; a.errorCode = r.errorCode; this.accounts.set(a.id, a);
      }
      if (Array.isArray(agents)) {
        this.agents = agents;
        const seen = new Set(entries.filter(r => r && this.accounts.has(r.id)).map(r => r.id));
        const providers = new Set([...seen].map(id => this.accounts.get(id).provider));
        const verifiedProviders = new Set([...seen].filter(id => this.accounts.get(id).fetchedAt != null)
          .map(id => this.accounts.get(id).provider));
        const linked = new Set(agents.flatMap(a => a.reportIds ?? []));
        for (const a of this.accounts.values()) {
          const uncertain = agents.some(g => g.provider === a.provider && !g.reportIds?.length);
          const unidentifiedReplacement = a.provider === 'claude' && a.fetchedAt != null &&
            providers.has(a.provider) && !verifiedProviders.has(a.provider);
          if (seen.has(a.id) || linked.has(a.id) || uncertain || unidentifiedReplacement) delete a.historicalAt;
          else if (providers.has(a.provider) && now - a.lastSeenAt >= this.config.staleMs)
            a.historicalAt ??= now;
          // Empty/failed discovery is not evidence of removal. Heartbeats never change membership.
        }
      }
      for (const a of this.accounts.values()) this.evaluate(a, now, refreshed.has(a.id));
    });
  }
  evaluate(a, now, refreshed = false) {
    if (this.config.enabled === false) { this.store.save(a); return; }
    const q = assess(a, this.config, now);
    const health = q.level === 'unknown' ? 'unavailable' : a.errorCode ?? 'ok';
    if (a.collectionState !== health) {
      this.store.audit('collection_state', { accountId: a.id, state: health, errorCode: a.errorCode ?? null,
        lastSuccessAt: a.fetchedAt, ageMs: a.fetchedAt == null ? null : Math.max(0, now - a.fetchedAt) }, now);
      a.collectionState = health;
    }
    if (!a.locked && (q.level === 'pause' || q.level === 'unknown')) this.lock(a, q.reason, q.level === 'pause' ? 'quota' : 'unavailable');
    if (a.locked && a.pauseCause === 'unavailable' && refreshed && !a.error && q.level === 'pause') {
      a.pauseCause = 'quota'; a.reason = q.reason;
      a.pauseContext = { usage: reportText(a, this.config) };
    }
    const recovered = this.config.mode === 'enforce' && a.locked && ['quota', 'unavailable'].includes(a.pauseCause) &&
      refreshed && !a.error && q.canResume && a.fetchedAt >= a.stopStartedAt;
    if (recovered) {
      const recoveryCause = a.pauseCause;
      this.unlock(a);
      this.notice(a, 'recovered', a.epoch, recoveryCause === 'unavailable' ? '额度查询已恢复，已自动解除暂停' : '额度已恢复，已自动解除暂停', { recoveryCause });
      this.store.audit('auto_resumed', { accountId: a.id, epoch: a.epoch, cause: recoveryCause }, now);
    }
    const ready = a.locked && q.canResume;
    a.ready = ready;
    if (a.locked && a.stopStatus === 'partial') this.notifyStopProblem(a);
    const warnings = updateWarningCycles(a, this.config, now);
    if (!a.locked && q.level === 'warning' && warnings.length && this.config.mode === 'enforce') {
      if (!recovered) this.notice(a, 'warning', warnings.map(w => `${w.id}:${w.generation}`).join(','), '额度预警', { warnings });
      for (const w of warnings) a.warningCycles[w.id].warned = true;
    }
    this.store.save(a);
  }
  lock(a, reason, cause = 'manual') {
    if (a.locked) return;
    a.locked = true; a.reason = reason; a.epoch++; a.ready = false; a.stopStatus = null;
    a.stopDetails = null;
    a.pauseCause = cause; a.stopStartedAt = this.now();
    a.pauseContext = { usage: reportText(a, this.config) };
    this.store.audit('pause_requested', { accountId: a.id, reason, cause, mode: this.config.mode,
      errorCode: a.errorCode ?? null, lastSuccessAt: a.fetchedAt, windows: a.windows }, this.now());
  }
  pause(id) {
    if (this.config.enabled === false) throw new Error('额度保护已关闭');
    if (this.config.mode !== 'enforce') throw new Error('当前为观察模式，不执行暂停');
    const a = this.require(id);
    this.store.transaction(() => {
      this.lock(a, '用户手动暂停');
      // An explicit manual pause takes precedence even if quota protection already locked the account.
      a.pauseCause = 'manual'; a.reason = '用户手动暂停';
      this.store.save(a);
    });
    return a;
  }
  resume(id) {
    const a = this.require(id); const q = assess(a, this.config, this.now());
    if (!q.canResume) throw new Error(q.resumeReason);
    this.store.transaction(() => {
      this.unlock(a);
      this.store.save(a); this.store.audit('resumed', { accountId: id }, this.now());
    });
    return a;
  }
  unlock(a) {
    a.locked = false; a.reason = ''; a.ready = false; a.stopStatus = null;
    a.stopDetails = null; a.stopStartedAt = null; a.pauseCause = null;
  }
  require(id) { const a = this.accounts.get(id); if (!a) throw new Error('未知账户'); return a; }
  // 隐藏（不删行）：从未有有效读数、未锁定、无暂停状态、超过 pruneMs 未被报告。
  // 任何锁定（自动 unknown、手动暂停）或 partial/paused 状态一律不隐藏，保持故障安全可见。
  // 再次被报告时 lastSeenAt 刷新而自动取消隐藏。
  isHidden(a, now = this.now()) {
    if (!Number.isFinite(a.lastSeenAt)) return false;
    return a.fetchedAt === null && a.windows.length === 0 &&
      a.locked === false &&
      (a.stopStatus === null || a.stopStatus === undefined) &&
      now - a.lastSeenAt > this.config.pruneMs;
  }
  isHistorical(a) {
    // Unconfirmed interruption stays in the current list even if discovery has moved on.
    return a.historicalAt != null && (!a.locked || a.stopStatus === 'paused') && a.stopStatus !== 'partial';
  }
  isUnidentified(a) {
    // Presentation only: do not alias identities, transfer readings, or release either lock.
    return a.provider === 'claude' && a.fetchedAt == null && a.windows.length === 0 &&
      !this.isHistorical(a) && (!a.locked || a.stopStatus === 'paused') && a.stopStatus !== 'partial' &&
      !this.agents.some(g => g.reportIds?.includes(a.id) || g.provider === a.provider && !g.reportIds?.length) &&
      [...this.accounts.values()].some(other => other.provider === a.provider && other.fetchedAt != null && !this.isHistorical(other));
  }
  // 设置变更/启动协调对账户状态的统一重置：必须在 store.transaction 内调用。
  resetAccountsForSettings(enabled, previous) {
    for (const a of this.accounts.values()) {
      if (!enabled || !previous) {
        this.unlock(a); a.epoch++;
      }
      this.store.save(a);
    }
  }
  admission(ids) {
    if (this.config.enabled === false) return { allowed: true, mode: this.config.mode, enabled: false };
    if (this.config.mode === 'observe') return { allowed: true, mode: 'observe' };
    if (!Array.isArray(ids) || !ids.length) return { allowed: false, reason: '无法确认会话账户' };
    for (const id of ids) {
      const a = this.accounts.get(id);
      if (!a) return { allowed: false, reason: '账户尚未采集' };
      const q = assess(a, this.config, this.now());
      if (a.locked || q.level === 'pause' || q.level === 'unknown') return { allowed: false, reason: a.reason || q.reason };
    }
    return { allowed: true, mode: 'enforce' };
  }
  stopResult(id, result) {
    const a = this.require(id);
    if (!a.locked) return;
    if (!result || typeof result !== 'object') result = { complete: false, pending: [], error: '中断结果无效' };
    const status = result.complete === true && Array.isArray(result.pending) && result.pending.length === 0 &&
      !result.failures?.length && !result.error && !result.disabled ? 'paused' : 'partial';
    this.store.transaction(() => {
      a.stopDetails = result;
      if (a.stopStatus !== status) {
        a.stopStatus = status;
        if (status === 'paused') this.notice(a, status, a.epoch, '额度保护已暂停账户');
        this.store.audit('stop_result', { accountId: id, ...result }, this.now());
      }
      if (status === 'partial') this.notifyStopProblem(a);
      this.store.save(a);
    });
  }
  notifyStopProblem(a, elapsed = false) {
    const r = a.stopDetails;
    if (elapsed || r?.error || r?.failures?.length || r?.disabled || this.now() - a.stopStartedAt >= this.stopNoticeMs)
      this.notice(a, 'partial', a.epoch, '额度保护已触发，部分任务仍需检查');
  }
  stopPending(id, elapsed = false) {
    const a = this.require(id);
    if (!a.locked || a.stopStatus === 'paused') return;
    this.store.transaction(() => {
      if (elapsed || this.now() - a.stopStartedAt >= this.stopNoticeMs) {
        a.stopStatus = 'partial';
        this.notifyStopProblem(a, elapsed);
      }
      this.store.save(a);
    });
  }
  status() {
    const now = this.now();
    const rows = [...this.accounts.values()].filter(a => !this.isHidden(a, now)).map(a => {
      const assessment = assess(a, this.config, now);
      return { ...a, ready: a.locked && assessment.canResume, assessment };
    });
    return {
      mode: this.config.mode, notifications: this.config.notifications, updatedAt: now, lastSnapshot: this.lastSnapshot,
      enabled: this.config.enabled !== false, settingsRevision: this.config.settingsRevision ?? 0,
      thresholds: this.config.thresholds,
      collectionPolicy: { freshMs: this.config.staleMs },
      accounts: rows.filter(a => !this.isHistorical(a) && !this.isUnidentified(a)),
      historicalAccounts: rows.filter(a => this.isHistorical(a)),
      unidentifiedAccounts: rows.filter(a => this.isUnidentified(a)),
      agents: this.agents, events: this.store.events(),
    };
  }
}
