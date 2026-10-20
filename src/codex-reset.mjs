import { randomUUID } from 'node:crypto';

const OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

// Persist before dispatch: a timeout/restart must not turn a retry into another redemption.
export function createCreditReset({ store, now, loadCredits, consume, refreshUsage, invalidate }) {
  let running = false;
  async function refresh(accountId, outcome) {
    invalidate(accountId);
    const [usage, credits] = await Promise.allSettled([refreshUsage(accountId), loadCredits(accountId)]);
    return { outcome, credits: credits.status === 'fulfilled' ? credits.value : null,
      refreshIncomplete: usage.status === 'rejected' || credits.status === 'rejected' };
  }
  return async ({ accountId, creditId, requestId }) => {
    if (typeof creditId !== 'string' || !creditId.trim() || creditId.length > 256) throw new Error('请选择要使用的重置卡');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new Error('重置请求标识无效');
    if (running) throw new Error('正在重置，请稍候');
    running = true;
    try {
      const key = `credit_reset_request:${requestId}`;
      const previous = store.getMeta(key);
      if (previous && (previous.accountId !== accountId || previous.creditId !== creditId)) throw new Error('重置请求与所选账户或卡片不一致');
      if (previous?.status === 'completed') return await refresh(accountId, previous.outcome);
      // Another client may have resolved this previously uncertain attempt using the same upstream key.
      const resolved = previous && store.getMeta(`credit_reset_result:${previous.idempotencyKey}`);
      if (resolved) return await refresh(accountId, resolved.outcome);
      const summary = await loadCredits(accountId);
      const credit = summary.credits.find(c => c.id === creditId && (c.expiresAt === null || c.expiresAt > now()));
      if (!credit) {
        if (previous) return await refresh(accountId, 'unknown');
        throw new Error('所选重置卡已过期或不可用，请刷新后重新选择；不会替换为其他卡');
      }
      const pendingKey = `credit_reset_pending:${JSON.stringify([accountId, creditId])}`;
      const idempotencyKey = previous?.idempotencyKey ?? store.getMeta(pendingKey) ?? randomUUID();
      const operation = { accountId, creditId, idempotencyKey, status: 'pending', startedAt: now() };
      store.transaction(() => {
        store.setMeta(key, operation);
        store.setMeta(pendingKey, idempotencyKey);
      });
      let outcome;
      try {
        outcome = await consume(creditId, idempotencyKey);
        if (!OUTCOMES.has(outcome)) throw new Error('重置结果无效');
      } catch (error) {
        outcome = error?.code === 'CODEX_REJECTED' ? 'rejected' : 'unknown';
      }
      store.transaction(() => {
        store.setMeta(key, { ...operation, status: outcome === 'unknown' ? 'unknown' : 'completed', outcome });
        if (outcome !== 'unknown') {
          store.setMeta(`credit_reset_result:${idempotencyKey}`, { outcome });
          if (store.getMeta(pendingKey) === idempotencyKey) store.setMeta(pendingKey, null);
        }
        store.audit('reset_credit_result', { accountId, creditId, requestId, outcome, expiresAt: credit.expiresAt }, now());
      });
      // Read only after an uncertain outcome. A further consume requires another explicit user action.
      return await refresh(accountId, outcome);
    } finally { running = false; }
  };
}
