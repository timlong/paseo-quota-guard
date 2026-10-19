import { cpSync, existsSync, mkdirSync, symlinkSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchServer } from './patch-paseo.mjs';

const source = resolve(process.argv[2] ?? '/home/qingteng/.local/lib/node_modules/@getpaseo/cli');
const release = resolve(process.argv[3] ?? '.local/release');
if (existsSync(release)) throw new Error('目标 release 必须不存在；保留旧版本用于回退');
mkdirSync(release, { recursive: true });
// Copy dependencies instead of following global npm updates at runtime. No install scripts execute.
cpSync(join(source, 'node_modules'), join(release, 'node_modules'), { recursive: true, mode: constants.COPYFILE_FICLONE });
cpSync(join(source, 'node_modules/@getpaseo/server'), join(release, 'server'), { recursive: true, mode: constants.COPYFILE_FICLONE });
symlinkSync('../node_modules', join(release, 'server/node_modules'));
cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(release, 'guard'), { recursive: true });
cpSync(fileURLToPath(new URL('../config', import.meta.url)), join(release, 'config'), { recursive: true });
cpSync(fileURLToPath(new URL('../plugin', import.meta.url)), join(release, 'plugin'), { recursive: true,
  filter: p => !p.split('/').includes('node_modules') });
const bridgeUrl = pathToFileURL(join(release, 'guard/bridge.mjs')).href;
patchServer(join(release, 'server'), bridgeUrl);
console.log(`隔离运行副本已生成：${release}；未启动或替换生产 Paseo。`);
