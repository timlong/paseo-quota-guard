export function validateConfig(c) {
  if (!['observe', 'enforce'].includes(c.mode)) throw new Error('mode 必须为 observe/enforce');
  for (const p of ['claude', 'codex']) {
    const t = c.thresholds?.[p];
    if (!t || !Number.isFinite(t.warn) || !Number.isFinite(t.pause) || t.warn < 0 || t.warn >= t.pause || t.pause > 100)
      throw new Error(`${p} 阈值无效`);
    if (!['both', 'available'].includes(c.windowPolicy?.[p])) throw new Error(`${p} 窗口规则无效`);
  }
  for (const k of ['activePollMs', 'idlePollMs', 'staleMs', 'heartbeatMs', 'heartbeatTimeoutMs'])
    if (!Number.isInteger(c[k]) || c[k] < 1000) throw new Error(`${k} 无效`);
  c.codexCommand ??= `${process.env.HOME}/.local/bin/codex`; // optional, like pruneMs
  if (typeof c.codexCommand !== 'string' || !c.codexCommand.startsWith('/')) throw new Error('codexCommand 必须为绝对路径');
  c.pruneMs ??= 21600000; // optional: user configs written before this key existed must keep working
  if (!Number.isInteger(c.pruneMs) || c.pruneMs <= c.staleMs) throw new Error('pruneMs 无效');
  if (c.activePollMs > c.staleMs || c.idlePollMs > c.staleMs || c.heartbeatTimeoutMs <= c.heartbeatMs)
    throw new Error('轮询/心跳间隔与有效期不兼容');
  if (!Number.isFinite(c.recoveryMargin) || c.recoveryMargin < 0 || c.recoveryMargin > 10)
    throw new Error('恢复间隔无效');
  if (typeof c.notifications !== 'boolean') throw new Error('notifications 必须为 boolean');
  return c;
}

// Only provider-declared stable IDs, never guess duration from the reset countdown.
export function normalizeReport(entry, now, config) {
  if (!entry || !['claude', 'codex'].includes(entry.sourceId)) return null;
  const fetchedAt = Date.parse(entry.fetchedAt);
  const windows = (entry.report?.windows ?? [])
    .filter(w => w.id === 'five_hour' || w.id === 'weekly')
    .map(w => ({ id: w.id, used: w.usedPct, reset: w.resetsAt ?? null }));
  const enough = config?.windowPolicy?.[entry.sourceId] === 'available' ? windows.length >= 1 : windows.length === 2;
  const valid = entry.report?.status === 'available' && enough &&
    new Set(windows.map(w => w.id)).size === windows.length &&
    windows.every(w => typeof w.used === 'number' && Number.isFinite(w.used) && w.used >= 0 && w.used <= 100) &&
    Number.isFinite(fetchedAt) && fetchedAt <= now + 5000;
  return {
    id: entry.id, provider: entry.sourceId, label: entry.account?.label ?? entry.sourceLabel,
    fetchedAt: valid ? fetchedAt : null, windows: valid ? windows : [],
    ...(valid ? { error: null, errorCode: null } : reportProblem(entry.report)),
  };
}

// Explain why a reading is unusable without guessing; the last valid windows stay in place until staleMs.
function reportProblem(report) {
  if (report?.status === 'available') return { errorCode: 'invalid_data', error: '缺少可识别的 5 小时/周额度或读数无效' };
  if (report?.status === 'unavailable') return { errorCode: 'unavailable', error: '登录失效或额度不可用' };
  const message = typeof report?.error === 'string' ? report.error : '';
  if (/rate.?limit|429|cooling down/i.test(message)) return { errorCode: 'rate_limited', error: '额度接口限流，暂时沿用上次读数' };
  if (/timed? ?out/i.test(message)) return { errorCode: 'timeout', error: '额度读取超时，暂时沿用上次读数' };
  return { errorCode: 'read_failed', error: '额度读取失败' };
}

export function assess(account, config, now) {
  const fresh = account.fetchedAt != null && now - account.fetchedAt < config.staleMs && account.fetchedAt <= now + 5000;
  const t = config.thresholds[account.provider];
  const enough = config.windowPolicy[account.provider] === 'available' ? account.windows.length >= 1 : account.windows.length === 2;
  if (!fresh || !enough)
    return { level: 'unknown', canResume: false, reason: '额度数据缺失或过期', resumeReason: '额度数据缺失或过期，请成功刷新后恢复', usingCachedReading: false };
  const high = account.windows.reduce((a, b) => a.used >= b.used ? a : b);
  const usingCachedReading = Boolean(account.error) && ['rate_limited', 'timeout'].includes(account.errorCode);
  const resumeBelow = t.pause - Math.min(config.recoveryMargin, t.pause / 2);
  const below = account.windows.every(w => w.used < resumeBelow);
  const usable = !account.error || usingCachedReading;
  return {
    level: high.used >= t.pause ? 'pause' : high.used >= t.warn ? 'warning' : 'normal',
    canResume: usable && below,
    resumeReason: !usable ? `${account.error}，请成功刷新后恢复` : !below ? `所有受保护窗口须低于 ${resumeBelow}% 才能恢复` : null,
    usingCachedReading,
    reason: `${high.id === 'weekly' ? '周' : '5 小时'}额度已用 ${high.used}%`,
  };
}

export function reportText(a, c) {
  const name = a.provider === 'claude' ? 'Claude' : 'Codex';
  const usage = a.windows.map(w => `${w.id === 'weekly' ? '周' : '5 小时'} ${w.used}%`).join('，');
  return `${name}：${usage || '额度不可用'}。任一达到 ${c.thresholds[a.provider].pause}% 自动暂停。`;
}
