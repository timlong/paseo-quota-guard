import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClaudeIdentityCache } from '../src/claude-identity.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');
const key = secret => `${sha('route')}:${sha(secret)}`;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'qgi-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, path: join(home, 'claude-identities.json'), cache: new ClaudeIdentityCache(home) };
}
test('已验证身份跨进程保存，只写指纹和公开身份；更换凭据不沿用旧账户', t => {
  const f = fixture(t); const value = { key: 'account.org', label: 'person@example.test' };
  f.cache.set(key('test-secret'), { ...value, accessToken: 'must-not-be-written' });
  const raw = readFileSync(f.path, 'utf8');
  assert.ok(!raw.includes('test-secret') && !raw.includes('must-not-be-written'));
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const script = `import {ClaudeIdentityCache} from ${JSON.stringify(new URL('../src/claude-identity.mjs', import.meta.url).href)};
    console.log(JSON.stringify(new ClaudeIdentityCache(process.argv[1]).get(process.argv[2])));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, f.home, key('test-secret')], { encoding: 'utf8' })), value);
  assert.equal(new ClaudeIdentityCache(f.home).get(key('new-secret')), undefined);
});
test('损坏或不可信缓存不推断身份；恢复写入后可再次读取', t => {
  const f = fixture(t);
  for (const data of ['invalid', JSON.stringify({ version: 1, entries: [[key('test'), { key: 'a', token: 'bad' }]] })]) {
    writeFileSync(f.path, data);
    const c = new ClaudeIdentityCache(f.home); assert.equal(c.get(key('test')), undefined);
    c.set(key('test'), { key: 'verified' });
    assert.equal(new ClaudeIdentityCache(f.home).get(key('test')).key, 'verified');
  }
});
test('缓存有界；没有可写目录仍保留本进程已验证身份', t => {
  const f = fixture(t);
  for (let i = 0; i < 65; i++) f.cache.set(key(String(i)), { key: `a-${i}` });
  assert.equal(new ClaudeIdentityCache(f.home).get(key('0')), undefined);
  assert.equal(new ClaudeIdentityCache(f.home).get(key('64')).key, 'a-64');
  const cache = new ClaudeIdentityCache(f.path); cache.set(key('x'), { key: 'known' });
  assert.equal(cache.get(key('x')).key, 'known');
});
