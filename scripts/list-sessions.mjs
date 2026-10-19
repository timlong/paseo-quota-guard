// Read-only full session enumeration for upgrade idle checks.
// Paginates the global agent list (including archived) and checks provider subagent status.
// Exits non-zero on malformed responses; never treats a missing field as an empty list.
import assert from 'node:assert/strict';
import { connectToDaemon } from '/home/qingteng/.local/lib/node_modules/@getpaseo/cli/dist/utils/client.js';

const HOME = '/home/qingteng/.paseo';
const PAGE_LIMIT = 200;
const MAX_PAGES = 1000;

// 仅当会话可能仍有后台子代理时才查询子代理；closed/running/initializing 无需查询。
function needsSubagentCheck(agent) {
  if (agent.status === 'closed' || agent.status === 'running' || agent.status === 'initializing') return false;
  return true; // idle / error / archived-但未关闭
}

function busyFor(agent, runningSubagents, subagentStatus) {
  if (agent.archivedAt && agent.status === 'closed') return false; // 归档且已关闭：确定无后台任务
  if (agent.status === 'running' || agent.status === 'initializing') return true;
  if (agent.status === 'closed') return false;
  // idle / error / archived-未关闭：依据子代理判定
  if (subagentStatus === 'unknown') return true;
  return runningSubagents > 0;
}

const client = await connectToDaemon({ target: { kind: 'instance', home: HOME } });
try {
  const agents = [];
  let cursor = null;
  for (let pages = 0; ; pages += 1) {
    assert.ok(pages < MAX_PAGES, '会话分页超过上限');
    const page = { limit: PAGE_LIMIT };
    if (cursor) page.cursor = cursor;
    const payload = await client.fetchAgents({ filter: { includeArchived: true }, page });
    assert.ok(payload && Array.isArray(payload.entries), '会话列表响应缺少 entries');
    assert.ok(payload.pageInfo && typeof payload.pageInfo.hasMore === 'boolean', '会话列表响应缺少 pageInfo.hasMore');
    for (const entry of payload.entries) {
      const a = entry && entry.agent;
      assert.ok(a && typeof a.id === 'string' && typeof a.status === 'string' && typeof a.updatedAt === 'string', '会话条目结构无效');
      agents.push(a);
    }
    if (!payload.pageInfo.hasMore) break;
    assert.ok(typeof payload.pageInfo.nextCursor === 'string' && payload.pageInfo.nextCursor, '会话分页声明 hasMore 但缺少 nextCursor');
    cursor = payload.pageInfo.nextCursor;
  }

  const rows = [];
  let busy = 0;
  for (const a of agents) {
    let runningSubagents = 0;
    let subagentStatus = 'ok';
    if (needsSubagentCheck(a)) {
      try {
        const sub = await client.listProviderSubagents(a.id);
        assert.ok(sub && Array.isArray(sub.subagents), '子代理列表结构无效');
        runningSubagents = sub.subagents.filter(s => s && s.status === 'running').length;
      } catch {
        subagentStatus = 'unknown';
      }
    }
    if (busyFor(a, runningSubagents, subagentStatus)) busy += 1;
    rows.push({ id: a.id, status: a.status, updatedAt: a.updatedAt, archivedAt: a.archivedAt ?? null,
      runningSubagents, subagentStatus });
  }
  console.log(JSON.stringify({ total: agents.length, busy, agents: rows }));
} finally {
  await client.close();
}
