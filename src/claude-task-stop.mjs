// Paseo 0.11.2 exposes canonical tool-use IDs in the subagent registry, while
// Claude's stopTask accepts task_id from task_started. Never interchange them.
export async function boundedCall(run, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('中断超时')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function stopClaudeSubtasks(session, tasks, { timeoutMs = 10000 } = {}) {
  if (!tasks.length) return [];
  const query = session.query;
  if (typeof query?.stopTask !== 'function') return ['子任务停止接口不可用'];
  // This is the live session's routing table, not a transcript or another session's IDs.
  const routing = session.taskProtocolSource?.subagentIdByTaskId;
  const failures = [];
  const taskIds = new Set();
  for (const task of tasks) {
    const ids = routing instanceof Map
      ? [...routing].filter(([id, canonicalId]) =>
        canonicalId === task.id && typeof id === 'string' && id.trim() && !id.startsWith('toolu_'))
        .map(([id]) => id)
      : [];
    if (!ids.length) failures.push('子任务原生 ID 未确认');
    for (const id of ids) taskIds.add(id);
  }
  // One unresponsive child must not hold up other children or the main-turn interrupt.
  await Promise.all([...taskIds].map(async id => {
    try { await boundedCall(() => query.stopTask(id), timeoutMs); }
    catch { failures.push('子任务中断失败或超时'); }
  }));
  return [...new Set(failures)];
}
