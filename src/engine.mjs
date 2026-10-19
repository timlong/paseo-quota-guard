import { assess, normalizeReport, reportText } from './policy.mjs';

export class Engine {
  constructor(config, store, now = Date.now) {
    this.config = config; this.store = store; this.now = now;
    this.accounts = store.load(); this.agents = []; this.lastSnapshot = null;
    const loadTime = this.now();
    for (const a of this.accounts.values()) if (!Number.isFinite(a.lastSeenAt)) a.lastSeenAt = loadTime;
  }
  notice(a, kind, suffix, text) {
    if (this.config.mode !== 'enforce' || this.config.enabled === false) return;
    this.store.enqueue(`${a.id}:${kind}:${suffix}:settings:${this.config.settingsRevision ?? 0}`, {
      settingsRevision: this.config.settingsRevision ?? 0,
      accountId: a.id, epoch: a.epoch, kind,
      title: `${a.provider === 'claude' ? 'Claude' : 'Codex'} ${text}`,
      body: `${reportText(a, this.config)} 打开 Paseo 的“额度保护”查看或操作。`,
    }, this.now());
  }
  ingest(entries) {
    const now = this.now();
    this.store.transaction(() => {
      for (const entry of entries) {
        const r = normalizeReport(entry, now, this.config);
        if (!r || typeof r.id !== 'string' || r.id.length > 256) continue;
        let a = this.accounts.get(r.id);
        if (!a) a = { id: r.id, provider: r.provider, label: r.label, windows: [], fetchedAt: null, lastSeenAt: now,
          locked: false, reason: '', epoch: 0, ready: false, warned: {}, stopStatus: null, error: null };
        if (a.provider !== r.provider) throw new Error('账户服务商标识变化');
        a.lastSeenAt = now;
        if (r.fetchedAt !== null && (a.fetchedAt === null || r.fetchedAt >= a.fetchedAt)) {
          a.windows = r.windows; a.fetchedAt = r.fetchedAt; a.label = r.label;
        }
        a.error = r.error; this.accounts.set(a.id, a);
      }
      for (const a of this.accounts.values()) this.evaluate(a, now);
    });
  }
  evaluate(a, now) {
    if (this.config.enabled === false) { this.store.save(a); return; }
    const q = assess(a, this.config, now);
    if (!a.locked && (q.level === 'pause' || q.level === 'unknown')) this.lock(a, q.reason);
    const ready = a.locked && q.canResume && !a.error;
    if (ready && !a.ready && a.reason !== '用户手动暂停') this.notice(a, 'ready', a.epoch, '额度可恢复');
    a.ready = ready;
    if (!a.locked && q.level === 'warning') {
      for (const w of a.windows.filter(w => w.used >= this.config.thresholds[a.provider].warn)) {
        const period = w.reset ?? 'unknown';
        if (a.warned[w.id] !== period) {
          a.warned[w.id] = period;
          this.notice(a, 'warning', `${w.id}:${period}`, '额度预警');
        }
      }
    }
    this.store.save(a);
  }
  lock(a, reason) {
    if (a.locked) return;
    a.locked = true; a.reason = reason; a.epoch++; a.ready = false; a.stopStatus = null;
    this.store.audit('pause_requested', { accountId: a.id, reason, mode: this.config.mode }, this.now());
  }
  pause(id) {
    if (this.config.enabled === false) throw new Error('额度保护已关闭');
    if (this.config.mode !== 'enforce') throw new Error('当前为观察模式，不执行暂停');
    const a = this.require(id);
    this.store.transaction(() => { this.lock(a, '用户手动暂停'); this.store.save(a); });
    return a;
  }
  resume(id) {
    const a = this.require(id); const q = assess(a, this.config, this.now());
    if (!q.canResume || a.error) throw new Error('额度未满足恢复条件或数据不可用');
    this.store.transaction(() => {
      a.locked = false; a.reason = ''; a.ready = false; a.stopStatus = null;
      this.store.save(a); this.store.audit('resumed', { accountId: id }, this.now());
    });
    return a;
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
  // 设置变更/启动协调对账户状态的统一重置：必须在 store.transaction 内调用。
  resetAccountsForSettings(enabled, previous) {
    for (const a of this.accounts.values()) {
      a.warned = {};
      if (!enabled || !previous) {
        a.locked = false; a.reason = ''; a.ready = false; a.stopStatus = null; a.epoch++;
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
    const status = result.complete ? 'paused' : 'partial';
    this.store.transaction(() => {
      if (a.stopStatus !== status) {
        a.stopStatus = status;
        this.notice(a, status, a.epoch, status === 'paused' ? '已暂停' : '暂停未完成，部分任务需检查');
        this.store.audit('stop_result', { accountId: id, ...result }, this.now());
      }
      a.stopDetails = result; this.store.save(a);
    });
  }
  status() {
    const now = this.now();
    return {
      mode: this.config.mode, notifications: this.config.notifications, updatedAt: now, lastSnapshot: this.lastSnapshot,
      enabled: this.config.enabled !== false, settingsRevision: this.config.settingsRevision ?? 0,
      thresholds: this.config.thresholds,
      accounts: [...this.accounts.values()].filter(a => !this.isHidden(a, now)).map(a => ({ ...a, assessment: assess(a, this.config, now) })),
      agents: this.agents, events: this.store.events(),
    };
  }
}
