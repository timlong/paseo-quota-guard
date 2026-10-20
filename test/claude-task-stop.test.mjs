import test from 'node:test';
import assert from 'node:assert/strict';
import { stopClaudeSubtasks } from '../src/claude-task-stop.mjs';

test('停止后台、嵌套子任务时使用各自原生 task_id，不传 tool_use_id', async () => {
  const stopped = [];
  const session = {
    query: { marker: true, async stopTask(id) { assert.equal(this.marker, true); stopped.push(id); } },
    taskProtocolSource: { subagentIdByTaskId: new Map([
      ['a842e4bcc1f1a38c4', 'toolu_parent'],
      ['native-nested', 'toolu_nested'],
      ['native-other', 'toolu_other'],
    ]) },
  };
  const tasks = [{ id: 'toolu_parent' }, { id: 'toolu_nested' }, { id: 'toolu_parent' }];
  assert.deepEqual(await stopClaudeSubtasks(session, tasks), []);
  assert.deepEqual(stopped, ['a842e4bcc1f1a38c4', 'native-nested']);
});

test('缺失路由或原生 ID 时报告未确认，不猜测、不阻塞其他可停止任务', async () => {
  const stopped = [];
  const session = { query: { async stopTask(id) { stopped.push(id); } } };
  assert.deepEqual(await stopClaudeSubtasks(session, [{ id: 'toolu_unknown' }]), ['子任务原生 ID 未确认']);
  session.taskProtocolSource = { subagentIdByTaskId: new Map([
    ['native-known', 'toolu_known'], ['toolu_invalid', 'toolu_invalid'],
  ]) };
  const result = await stopClaudeSubtasks(session, [
    { id: 'toolu_unknown' }, { id: 'toolu_known' }, { id: 'toolu_invalid' },
  ]);
  assert.deepEqual(result, ['子任务原生 ID 未确认']);
  assert.deepEqual(stopped, ['native-known']);
  assert.deepEqual(await stopClaudeSubtasks({}, []), []);
  assert.deepEqual(await stopClaudeSubtasks({}, [{ id: 'toolu_unknown' }]), ['子任务停止接口不可用']);
});

test('原生路由严格属于当前会话，重新映射后重试使用最新 task_id', async () => {
  const stopped = [];
  const session = {
    query: { async stopTask(id) { stopped.push(id); } },
    taskProtocolSource: { subagentIdByTaskId: new Map([['native-old', 'toolu_child']]) },
  };
  await stopClaudeSubtasks(session, [{ id: 'toolu_child' }]);
  session.taskProtocolSource.subagentIdByTaskId = new Map([['native-new', 'toolu_child']]);
  await stopClaudeSubtasks(session, [{ id: 'toolu_child' }]);
  assert.deepEqual(stopped, ['native-old', 'native-new']);
});

test('停止请求失败或超时会返回失败；卡住的子任务不阻塞其他停止请求', async () => {
  const stopped = [];
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const session = {
      query: { async stopTask(id) {
        stopped.push(id);
        if (id === 'hanging') return new Promise(() => {});
        if (id === 'failed') throw new Error('provider failure');
      } },
      taskProtocolSource: { subagentIdByTaskId: new Map([
        ['hanging', 'toolu_hanging'], ['failed', 'toolu_failed'], ['ok', 'toolu_ok'],
      ]) },
    };
    const result = await stopClaudeSubtasks(session,
      ['hanging', 'failed', 'ok'].map(id => ({ id: `toolu_${id}` })), { timeoutMs: 20 });
    assert.deepEqual(stopped, ['hanging', 'failed', 'ok']);
    assert.deepEqual(result, ['子任务中断失败或超时']);
  } finally { clearInterval(keepAlive); }
});
