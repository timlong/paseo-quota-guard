import http from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RpcInput } from '@getpaseo/plugin';
import { control } from '../shared/rpc';

export async function handleControl(input: RpcInput<typeof control>): Promise<Record<string, unknown>> {
  const socketPath = join(process.env.PASEO_QUOTA_GUARD_HOME ?? join(homedir(), '.local/state/paseo-quota-guard'), 'guard.sock');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: `/${input.action}`, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.on('data', b => { data += String(b); if (data.length > 2e6) req.destroy(new Error('状态响应过大')); });
      res.on('end', () => {
        try {
          const result = JSON.parse(data) as Record<string, unknown>;
          if (res.statusCode !== 200) reject(new Error(String(result.error ?? '操作失败'))); else resolve(result);
        } catch { reject(new Error('监控服务返回无效状态')); }
      });
    });
    req.on('error', () => reject(new Error('额度保护服务不可连接，请检查 qt38 后台服务')));
    req.setTimeout(input.action === 'codex-reset' ? 150000 : 60000, () => req.destroy(new Error('操作超时，请刷新核对结果')));
    req.end(JSON.stringify(input.action === 'settings' ? input.settings
      : { accountId: input.accountId, creditId: input.creditId, requestId: input.requestId, force: input.force }));
  });
}
