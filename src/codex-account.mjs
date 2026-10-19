// Codex rate-limit reset credits via the official Codex app-server (JSON-RPC over stdio).
// Methods: account/rateLimits/read and account/rateLimitResetCredit/consume (codex-cli 0.162 protocol).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

export function codexRpc(command, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let child, buffer = '', done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); child?.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex 服务响应超时')), timeoutMs);
    try { child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return finish(new Error('无法启动 Codex')); }
    const write = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Error('无法启动 Codex')));
    child.on('exit', () => finish(new Error('Codex 服务意外退出')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4e6) return finish(new Error('Codex 响应过大'));
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error('Codex 初始化失败'));
          write({ method: 'initialized' });
          write({ id: 2, method, params });
        } else if (m.id === 2) {
          return m.error ? finish(new Error('Codex 拒绝了请求')) : finish(null, m.result);
        }
      }
    });
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'paseo-quota-guard', title: null, version: '0.1.0' }, capabilities: null } });
  });
}

/** Normalizes account/rateLimits/read; only available credits are listed, earliest expiry first. */
export function summarize(result, now = Date.now()) {
  if (!result || typeof result !== 'object') throw new Error('Codex 额度响应无效');
  const rl = result.rateLimits ?? {};
  const rc = result.rateLimitResetCredits;
  const credits = (Array.isArray(rc?.credits) ? rc.credits : [])
    .filter(c => c && typeof c.id === 'string' && c.status === 'available')
    .map(c => ({ id: c.id, title: typeof c.title === 'string' ? c.title : null,
      grantedAt: Number.isFinite(c.grantedAt) ? c.grantedAt * 1000 : null,
      expiresAt: Number.isFinite(c.expiresAt) ? c.expiresAt * 1000 : null }))
    .filter(c => c.expiresAt === null || c.expiresAt > now)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const count = Number(rc?.availableCount);
  const balance = Number(rl.credits?.balance);
  return {
    accountId: typeof result.accountId === 'string' ? result.accountId : null,
    planType: typeof rl.planType === 'string' ? rl.planType : null,
    creditBalance: Number.isFinite(balance) ? balance : null,
    // Reset credits only apply once a limit is hit; never infer this from percentages.
    limitReached: result.ordinaryUsageAllowed === false || rl.rateLimitReachedType != null,
    availableCount: Number.isFinite(count) ? count : credits.length,
    credits, fetchedAt: now,
  };
}

export async function readCredits(command, timeoutMs) {
  return summarize(await codexRpc(command, 'account/rateLimits/read', {}, timeoutMs));
}

export async function consumeCredit(command, creditId, timeoutMs) {
  const result = await codexRpc(command, 'account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID(), creditId }, timeoutMs);
  if (!OUTCOMES.has(result?.outcome)) throw new Error('Codex 重置结果无效');
  return result.outcome;
}
