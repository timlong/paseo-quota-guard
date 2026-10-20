// A fixed anchor tolerates provider timestamp jitter without accumulating drift.
const RESET_TOLERANCE_MS = 60000;
const resetTime = value => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

export function migrateWarnings(account) {
  account.warningCycles ??= Object.fromEntries(Object.entries(account.warned ?? {}).map(([id, reset]) =>
    [id, { anchor: resetTime(reset), generation: 1, warned: true, observedAt: account.fetchedAt }]));
}

export function updateWarningCycles(account, config, now) {
  migrateWarnings(account);
  // Only a valid, fresh observation can establish a new period or rearm a missing-reset warning.
  if (account.error || account.fetchedAt === null || now - account.fetchedAt >= config.staleMs) return [];
  const warning = config.thresholds[account.provider].warn;
  const due = [];
  for (const w of account.windows) {
    const reset = resetTime(w.reset);
    let cycle = account.warningCycles[w.id];
    if (!cycle) cycle = account.warningCycles[w.id] = { anchor: reset, generation: 1, warned: false, observedAt: null };
    if (cycle.observedAt !== account.fetchedAt) {
      if (cycle.anchor !== null && reset !== null && reset > cycle.anchor + RESET_TOLERANCE_MS &&
          account.fetchedAt >= cycle.anchor) {
        cycle.anchor = reset; cycle.generation++; cycle.warned = false;
      } else if (cycle.anchor === null) {
        if (cycle.warned && w.used < warning) { cycle.generation++; cycle.warned = false; }
        // Gaining a reset timestamp must not repeat an already emitted warning.
        if (reset !== null) cycle.anchor = reset;
      }
      cycle.observedAt = account.fetchedAt;
    }
    if (w.used >= warning && !cycle.warned) due.push({ id: w.id, generation: cycle.generation });
  }
  return due.sort((a, b) => a.id.localeCompare(b.id));
}

export function warningIsCurrent(account, warnings, config) {
  return Array.isArray(warnings) && warnings.some(w =>
    account.warningCycles?.[w.id]?.generation === w.generation &&
    account.windows.some(current => current.id === w.id && current.used >= config.thresholds[account.provider].warn));
}
