import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function patchServer(root, bridgeUrl, expectedHashes = JSON.parse(readFileSync(new URL('../config/paseo-0.11.2-hashes.json', import.meta.url), 'utf8'))) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@getpaseo/server' || pkg.version !== '0.11.2') throw new Error('仅支持 @getpaseo/server 0.11.2');
  const edits = [
    ['dist/server/server/agent/provider-registry.js', [
      ['export function wrapSessionProvider(provider, inner) {', `export function wrapSessionProvider(provider, inner) {\n    inner = quotaGuardSession(inner);`],
    ], `import { guardSession as quotaGuardSession } from ${JSON.stringify(bridgeUrl)};\n`],
    ['dist/server/server/websocket-server.js', [
      ['        this.pushNotificationSender = pushNotificationSender ?? this.pushNotifications;',
        `        this.pushNotificationSender = pushNotificationSender ?? this.pushNotifications;\n        this.quotaBridgeReady = startQuotaBridge({ manager: agentManager, runtime: pluginRuntime, paseoHome, serverId, logger }).catch(err => { logger.error({ message: err.message }, "Quota bridge failed; guarded requests remain blocked"); return null; });`],
      ['    async close() {\n        this.prepareForShutdown();', '    async close() {\n        await (await this.quotaBridgeReady)?.close();\n        this.prepareForShutdown();'],
    ], `import { startBridge as startQuotaBridge } from ${JSON.stringify(bridgeUrl)};\n`],
    ['dist/server/builtin-plugins/codex-usage-source/server/usage.ts', [
      ['  const headers: Record<string, string> = {', `  const quotaNow = (lookup.now ?? Date.now)();\n  const quotaKey = auth.accountId ?? hashAccountKey(auth.token);\n  if ((quotaGuardCooldown.get(quotaKey) ?? 0) > quotaNow) throw new Error("Codex usage API cooling down after 429");\n  const headers: Record<string, string> = {`],
      ['  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);', `  if (response.status === 429) {\n    const raw = response.headers.get("retry-after");\n    const seconds = raw ? Number(raw) : NaN;\n    const date = raw ? Date.parse(raw) : NaN;\n    const wait = Number.isFinite(seconds) ? Math.max(60000, seconds * 1000) : Number.isFinite(date) ? Math.max(60000, date - quotaNow) : 900000;\n    if (quotaGuardCooldown.size >= 128) quotaGuardCooldown.clear();\n    quotaGuardCooldown.set(quotaKey, quotaNow + wait);\n  }\n  if (!response.ok) throw new Error(\`Codex usage API returned \${response.status}\`);`],
    ], 'const quotaGuardCooldown = new Map<string, number>();\n'],
    ['dist/server/builtin-plugins/claude-usage-source/server/usage.ts', [
      [`    const fallback = { key: hashAccountKey(JSON.stringify(input.route)), harness, input };
    if (credentials.expires !== undefined && credentials.expires <= (lookup.now ?? Date.now)()) {
      accounts.push(fallback);
      continue;
    }
    try {
      const profile = await readProfile(
        credentials.oauth.accessToken,
        fetchApi,
        lookup.now ?? Date.now,
      );
      accounts.push("status" in profile ? fallback : { ...profile, harness, input });
    } catch {
      // Keep the login visible; fetching usage reports the vendor failure.
      accounts.push(fallback);
    }`,
       `    const routeKey = hashAccountKey(JSON.stringify(input.route));
    const secret = credentials.oauth.refreshToken?.trim() || credentials.oauth.accessToken.trim();
    const identityKey = secret ? \`\${routeKey}:\${hashAccountKey(secret)}\` : null;
    const fallback = () => {
      if (identityKey) {
        const cached = quotaGuardIdentity.get(identityKey);
        if (cached) return { key: cached.key, label: cached.label, harness, input };
      }
      return { key: routeKey, harness, input };
    };
    if (credentials.expires !== undefined && credentials.expires <= (lookup.now ?? Date.now)()) {
      accounts.push(fallback());
      continue;
    }
    try {
      const profile = await readProfile(
        credentials.oauth.accessToken,
        fetchApi,
        lookup.now ?? Date.now,
      );
      if ("status" in profile) {
        accounts.push(fallback());
      } else {
        if (identityKey) {
          if (quotaGuardIdentity.size >= 64) quotaGuardIdentity.clear();
          quotaGuardIdentity.set(identityKey, { key: profile.key, ...(profile.label ? { label: profile.label } : {}) });
        }
        accounts.push({ ...profile, harness, input });
      }
    } catch {
      // Keep the login visible; fetching usage reports the vendor failure.
      accounts.push(fallback());
    }`],
    ], 'const quotaGuardIdentity = new Map<string, { key: string; label?: string }>();\n'],
  ];
  const planned = edits.map(([name, replacements, prefix]) => {
    const path = join(root, name), before = readFileSync(path, 'utf8');
    if (before.includes('quotaGuardSession') || before.includes('startQuotaBridge') || before.includes('quotaGuardCooldown') || before.includes('quotaGuardIdentity')) throw new Error('目标已打补丁');
    if (createHash('sha256').update(before).digest('hex') !== expectedHashes[name]) throw new Error(`目标文件哈希不匹配：${name}`);
    let after = before;
    for (const [from, to] of replacements) {
      if (after.split(from).length !== 2) throw new Error(`补丁锚点不匹配：${name}`);
      after = after.replace(from, to);
    }
    return { path, name, before, after: prefix + after };
  });
  const manifest = [];
  for (const p of planned) {
    writeFileSync(p.path + '.quota-backup', p.before, { flag: 'wx' });
    writeFileSync(p.path, p.after);
    manifest.push({ file: p.name, before: createHash('sha256').update(p.before).digest('hex'), after: createHash('sha256').update(p.after).digest('hex') });
  }
  writeFileSync(join(root, 'quota-patch-manifest.json'), JSON.stringify({ version: pkg.version, bridgeUrl, files: manifest }, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Always stage a separate server package; never patch the live installation.
  const [source, dest] = process.argv.slice(2);
  if (!source || !dest) throw new Error('用法：node scripts/patch-paseo.mjs <server包路径> <全新副本路径>');
  if (existsSync(dest)) throw new Error('目标目录必须不存在');
  mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(source, dest, { recursive: true });
  console.log(JSON.stringify(patchServer(resolve(dest), pathToFileURL(fileURLToPath(new URL('../src/bridge.mjs', import.meta.url))).href), null, 2));
}
