import http from 'node:http';
import { mkdirSync, chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function call(socketPath, path, body = {}, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.on('data', b => { data += b; if (data.length > 2e6) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        try { const v = JSON.parse(data); if (res.statusCode !== 200) reject(new Error(v.error ?? 'IPC 请求失败')); else resolve(v); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('IPC 请求超时')));
    req.end(JSON.stringify(body));
  });
}

export async function serve(socketPath, handler) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error('拒绝覆盖非 socket 文件');
    try { await call(socketPath, '/health', {}, 1000); throw new Error('服务已运行'); }
    catch (e) { if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT') throw e; }
    unlinkSync(socketPath);
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Error('仅支持 POST');
      let input = '';
      for await (const b of req) { input += b; if (input.length > 65536) throw new Error('请求过大'); }
      const output = await handler(req.url, JSON.parse(input || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return { close: () => new Promise(resolve => server.close(() => { if (existsSync(socketPath)) unlinkSync(socketPath); resolve(); })) };
}
