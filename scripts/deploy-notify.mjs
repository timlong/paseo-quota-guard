import { readFileSync, mkdirSync } from 'node:fs';
import { startBridge } from '../src/bridge.mjs';
const home = '/home/qingteng/.local/state/paseo-quota-deploy/notify';
mkdirSync(home, { recursive: true, mode: 0o700 });
const kind = process.argv[2];
const extra = process.argv[3];

function copy(kind, extra) {
  if (kind === 'upgrade-success') {
    const enabled = extra === 'true' ? '已开启' : '已关闭';
    return { title: 'Paseo 已升级', body: `已切换到新的发布版本。额度保护设置未改变（当前：${enabled}）。` };
  }
  if (kind === 'upgrade-failure') {
    if (extra === 'rolled_back') return { title: 'Paseo 升级未完成，已回滚', body: '已恢复原版本，请检查 qt38 的升级记录。' };
    if (extra === 'rollback_needs_attention') return { title: 'Paseo 升级未完成，需人工检查', body: '回滚未完全确认，请检查 qt38 的升级记录。' };
    if (extra === 'not_switched') return { title: 'Paseo 升级未执行', body: '准备或快照失败，未切换服务，请检查 qt38 的升级记录。' };
    return { title: 'Paseo 升级未执行', body: '无法确认空闲，未切换服务，请稍后重试。' };
  }
  const success = kind === 'success';
  return {
    title: success ? 'Paseo 额度保护已启用' : 'Paseo 额度保护部署未完成',
    body: success ? 'Claude 80% 预警 / 90% 暂停；Codex 90% / 95%。重新连接后，在侧栏底部打开“额度保护”，可调整阈值和开关。'
      : '部署未完成，请检查 qt38 的部署记录；未确认自动保护生效。',
  };
}

const bridge = await startBridge({ home, mode: 'observe', manager: { agents: new Map() }, runtime: {},
  paseoHome: '/home/qingteng/.paseo', serverId: readFileSync('/home/qingteng/.paseo/server-id', 'utf8').trim() });
try {
  const { title, body } = copy(kind, extra);
  const key = kind.startsWith('upgrade') ? `upgrade:${Date.now()}` : `deployment:${Date.now()}`;
  const result = await bridge.push({ kind: 'test', key, title, body });
  console.log(JSON.stringify(result));
} finally { await bridge.close(); }
