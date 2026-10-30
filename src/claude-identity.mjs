import { readFileSync as identityRead, writeFileSync as identityWrite, renameSync as identityRename,
  mkdirSync as identityMkdir, unlinkSync as identityUnlink } from 'node:fs';
import { join as identityJoin } from 'node:path';
import { randomUUID as identityUuid } from 'node:crypto';

// Contains only a route/credential fingerprint and a previously verified public account identity.
// Never infer account identity from a route alone, a label, or the existence of one old account.
export class ClaudeIdentityCache {
  constructor(home) {
    this.home = home;
    this.entries = new Map();
    if (!home) return;
    try {
      const data = JSON.parse(identityRead(identityJoin(home, 'claude-identities.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 64) return;
      for (const [fingerprint, account] of data.entries) {
        if (!this.valid(fingerprint, account)) { this.entries.clear(); return; }
        this.entries.set(fingerprint, account);
      }
    } catch { this.entries.clear(); }
  }
  valid(fingerprint, account) {
    return typeof fingerprint === 'string' && /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(fingerprint) &&
      account && typeof account.key === 'string' && account.key.length > 0 && account.key.length <= 256 &&
      (account.label === undefined || typeof account.label === 'string' && account.label.length <= 256) &&
      Object.keys(account).every(key => ['key', 'label'].includes(key));
  }
  get(fingerprint) { return this.entries.get(fingerprint); }
  set(fingerprint, account) {
    const value = { key: account.key, ...(account.label ? { label: account.label } : {}) };
    if (!this.valid(fingerprint, value)) return;
    if (JSON.stringify(this.entries.get(fingerprint)) === JSON.stringify(value)) return;
    if (this.entries.size >= 64 && !this.entries.has(fingerprint)) this.entries.clear();
    this.entries.set(fingerprint, value);
    if (!this.home) return;
    const path = identityJoin(this.home, 'claude-identities.json');
    const temp = `${path}.${identityUuid()}.tmp`;
    try {
      identityMkdir(this.home, { recursive: true, mode: 0o700 });
      identityWrite(temp, JSON.stringify({ version: 1, entries: [...this.entries] }), { mode: 0o600, flag: 'wx' });
      identityRename(temp, path);
    } catch {
      // Read-only/missing storage must not turn a verified profile into a failed reading.
      try { identityUnlink(temp); } catch {}
    }
  }
}
