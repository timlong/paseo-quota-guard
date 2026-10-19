import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from './policy.mjs';

export function writeSettings(home, settings) {
  const path = join(home, 'settings.json');
  writeFileSync(path + '.tmp', JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function restoreSettings(home, previous) {
  if (previous === null) {
    try { unlinkSync(join(home, 'settings.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else {
    writeSettings(home, previous);
  }
}

export function readSettings(home) {
  try {
    const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    if (typeof s.enabled !== 'boolean' || typeof s.notifications !== 'boolean' || !Number.isSafeInteger(s.revision) || s.revision < 1)
      throw new Error('已保存的设置无效');
    for (const p of ['claude', 'codex']) {
      const t = s.thresholds?.[p];
      if (!t || !Number.isFinite(t.warn) || !Number.isFinite(t.pause) || t.warn < 0 || t.warn >= t.pause || t.pause > 100)
        throw new Error('已保存的阈值无效');
    }
    return s;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function protectionDisabled(home) {
  try { return readSettings(home)?.enabled === false; }
  catch { return false; } // Corrupt/unreadable settings must not silently disable protection.
}

export function saveSettings(home, current, input) {
  if (!input || Object.keys(input).some(k => !['revision', 'enabled', 'notifications', 'thresholds'].includes(k)) ||
      input.revision !== current.settingsRevision || typeof input.enabled !== 'boolean')
    throw new Error('设置格式无效或已被其他设备修改，请刷新后重试');
  const candidate = validateConfig({ ...current, enabled: input.enabled, notifications: input.notifications, thresholds: input.thresholds });
  const settings = { enabled: candidate.enabled, notifications: candidate.notifications,
    thresholds: candidate.thresholds, revision: current.settingsRevision + 1 };
  writeSettings(home, settings);
  return settings;
}
