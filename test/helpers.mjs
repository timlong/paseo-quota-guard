import { readFileSync } from 'node:fs';
export const config = (extra = {}) => ({ ...JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url))), mode: 'enforce', ...extra });
export function report(provider = 'claude', used = 10, weekly = 10, now = Date.now(), account = 'a') {
  return { id: `${provider}:${account}`, sourceId: provider, sourceLabel: provider, account: { label: account }, fetchedAt: new Date(now).toISOString(),
    report: { status: 'available', windows: [
      { id: 'five_hour', usedPct: used, resetsAt: new Date(now + 18000000).toISOString() },
      { id: 'weekly', usedPct: weekly, resetsAt: new Date(now + 604800000).toISOString() },
    ] } };
}
