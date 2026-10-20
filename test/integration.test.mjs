import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startService } from '../src/main.mjs';
import { serve, call } from '../src/ipc.mjs';
import { startBridge, guardSession, providerRunning } from '../src/bridge.mjs';
import { patchServer } from '../scripts/patch-paseo.mjs';
import { config, report } from './helpers.mjs';

const temp = t => { const d = mkdtempSync(join(tmpdir(), 'qg-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('真实 Unix socket：预警、手动暂停、恢复、自动暂停与重启', async t => {
 const home = temp(t); let used = 80; let paused = 0; const notifications = [];
 const bridge = await serve(join(home, 'paseo.sock'), async (path, body) => {
   if (path === '/snapshot') return { mode:'enforce', reports: [report('claude', used, 10)], agents: [{ id: 'a', running: true }] };
   if (path === '/interrupt') { paused++; return { complete: true, pending: [] }; }
   if (path === '/push') { notifications.push(body.kind); return { accepted: true }; }
   if (path === '/health') return { ok: true };
   throw new Error('unknown');
 });
 t.after(() => bridge.close());
 let service = await startService({ home, config: config({ notifications: true }), bridgePath: join(home, 'paseo.sock') });
 t.after(() => service.close());
 const req = (p,b) => call(join(home, 'guard.sock'),p,b);
 assert.deepEqual(notifications,['warning']); assert.equal(paused,0);
 await req('/pause',{accountId:'claude:a'});
 assert.equal((await req('/admit',{reportIds:['claude:a']})).allowed,false);
 assert.equal(paused,1); assert.ok(notifications.includes('paused'));
 used = 1; await req('/resume',{accountId:'claude:a'});
 assert.equal((await req('/admit',{reportIds:['claude:a']})).allowed,true);
 used = 90; await service.tick(true);
 assert.equal((await req('/admit',{reportIds:['claude:a']})).allowed,false);
 await service.close();
 service = await startService({ home, config: config({ notifications:true }), bridgePath:join(home,'paseo.sock') });
 assert.equal((await req('/status')).accounts[0].locked,true);
 await assert.rejects(req('/resume',{accountId:'claude:a'}));
});

test('观察模式真正不调用 stop/push；无有效窗口也不误当作0', async t => {
 const home=temp(t); const calls=[];
 const bridge=await serve(join(home,'paseo.sock'), async path => {
   calls.push(path); return {mode:'observe',reports:[report('codex',99,99)],agents:[]};
 }); t.after(()=>bridge.close());
 const service=await startService({home,config:config({mode:'observe',notifications:true}),bridgePath:join(home,'paseo.sock')});
 t.after(()=>service.close());
 assert.deepEqual(calls,['/snapshot']);
 assert.equal((await call(join(home,'guard.sock'),'/admit',{reportIds:[]})).allowed,true);
});

test('服务端补丁：发送/续跑/steer 被拦截，独立账户与原会话保持', async t => {
 const home=temp(t); const originalHome=process.env.PASEO_QUOTA_GUARD_HOME, originalMode=process.env.PASEO_QUOTA_GUARD_MODE;
 process.env.PASEO_QUOTA_GUARD_HOME=home; process.env.PASEO_QUOTA_GUARD_MODE='enforce';
 t.after(()=>{ if(originalHome===undefined) delete process.env.PASEO_QUOTA_GUARD_HOME; else process.env.PASEO_QUOTA_GUARD_HOME=originalHome;
 if(originalMode===undefined) delete process.env.PASEO_QUOTA_GUARD_MODE; else process.env.PASEO_QUOTA_GUARD_MODE=originalMode; });
 let used=10, invoked=0, closed=0;
 const inner={ id:'native', mainTurnInFlight:false,
  usageSession:()=>({provider:'claude',sessionKey:'unique',env:{}}),
  async startTurn(){invoked++;this.mainTurnInFlight=true;}, async run(){invoked++;}, async steerActiveTurn(){invoked++;},
  async interrupt(){this.mainTurnInFlight=false;}, async close(){closed++;},
 };
 const session=guardSession(inner); const a={id:'agent',session,provider:'claude',workspaceId:'workspace'};
 const manager={agents:new Map([['agent',a]]),providerSubagents:{list:()=>[]}};
 const runtime={listUsageReports:async()=>[report('claude',used,10)]};
 const bridge=await startBridge({manager,runtime,paseoHome:home,serverId:'test',home,mode:'enforce',watchdogMs:100000});
 t.after(()=>bridge.close());
 const service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')});t.after(()=>service.close());
 await session.startTurn('hello'); assert.equal(invoked,1); assert.equal(providerRunning(inner),true);
 used=90;await service.tick(true);assert.equal(providerRunning(inner),false);
 for(const method of ['run','startTurn','steerActiveTurn']) await assert.rejects(session[method]('no'),/额度保护/);
 assert.equal(invoked,1); assert.equal(closed,0,'暂停不关闭会话进程');
 used=1;await call(join(home,'guard.sock'),'/resume',{accountId:'claude:a'});
 await session.run('continue');assert.equal(invoked,2);
 await service.close();
 await assert.rejects(session.startTurn('guard down'));
 await session.close();assert.equal(closed,1);
 // Prevent double close in cleanup after exercising service loss.
 service.close=async()=>{};
});

test('带外命令 tryHandleOutOfBand 保持同步并复用额度准入', async t => {
 const home=temp(t); const originalHome=process.env.PASEO_QUOTA_GUARD_HOME, originalMode=process.env.PASEO_QUOTA_GUARD_MODE;
 process.env.PASEO_QUOTA_GUARD_HOME=home; process.env.PASEO_QUOTA_GUARD_MODE='enforce';
 t.after(()=>{ if(originalHome===undefined) delete process.env.PASEO_QUOTA_GUARD_HOME; else process.env.PASEO_QUOTA_GUARD_HOME=originalHome;
  if(originalMode===undefined) delete process.env.PASEO_QUOTA_GUARD_MODE; else process.env.PASEO_QUOTA_GUARD_MODE=originalMode; });
 let capturedThis, capturedArgs, runs=0;
 const handler={extra:'保留', async run(...args){ capturedThis=this; capturedArgs=args; runs++; return `ok:${args.join('-')}`; }};
 const noRun={name:'无run'};
 const inner={ usageSession:()=>({provider:'codex',sessionKey:'oob',env:{}}), async close(){},
  tryHandleOutOfBand(prompt){ if(prompt==='oob') return handler; if(prompt==='undef') return undefined; if(prompt==='false') return false; if(prompt==='norun') return noRun; return null; } };
 const session=guardSession(inner); t.after(()=>session.close());
 const plain=session.tryHandleOutOfBand('普通输入'); assert.equal(plain,null); assert.ok(!(plain instanceof Promise));
 assert.equal(session.tryHandleOutOfBand('undef'),undefined);
 assert.equal(session.tryHandleOutOfBand('false'),false);
 assert.equal(session.tryHandleOutOfBand('norun'),noRun);
 const wrapped=session.tryHandleOutOfBand('oob');
 assert.ok(wrapped && typeof wrapped==='object'); assert.equal(typeof wrapped.run,'function'); assert.equal(wrapped.extra,'保留');
 await assert.rejects(wrapped.run('x',1),/额度保护尚未就绪/); assert.equal(runs,0);
 process.env.PASEO_QUOTA_GUARD_MODE='observe';
 assert.equal(await wrapped.run('a','b'),'ok:a-b'); assert.equal(capturedThis,handler); assert.deepEqual(capturedArgs,['a','b']); assert.equal(runs,1);
 process.env.PASEO_QUOTA_GUARD_MODE='enforce';
 writeFileSync(join(home,'settings.json'),JSON.stringify({enabled:false,notifications:false,revision:1,thresholds:{claude:{warn:80,pause:90},codex:{warn:90,pause:95}}}));
 assert.equal(await wrapped.run('c'),'ok:c'); assert.equal(runs,2);
});

test('带外 handler.run 在 host 就绪时按额度准入允许与拒绝', async t => {
 const home=temp(t); const originalHome=process.env.PASEO_QUOTA_GUARD_HOME, originalMode=process.env.PASEO_QUOTA_GUARD_MODE;
 process.env.PASEO_QUOTA_GUARD_HOME=home; process.env.PASEO_QUOTA_GUARD_MODE='enforce';
 t.after(()=>{ if(originalHome===undefined) delete process.env.PASEO_QUOTA_GUARD_HOME; else process.env.PASEO_QUOTA_GUARD_HOME=originalHome;
  if(originalMode===undefined) delete process.env.PASEO_QUOTA_GUARD_MODE; else process.env.PASEO_QUOTA_GUARD_MODE=originalMode; });
 let used=10, runs=0;
 const handler={ async run(){ runs++; return 'ran'; } };
 const inner={ usageSession:()=>({provider:'codex',sessionKey:'oob-ready',env:{}}),
  tryHandleOutOfBand(){ return handler; }, async interrupt(){}, async close(){} };
 const session=guardSession(inner); t.after(()=>session.close());
 const a={id:'agent',session,provider:'codex',workspaceId:'workspace'};
 const manager={agents:new Map([['agent',a]]),providerSubagents:{list:()=>[]}};
 const runtime={listUsageReports:async()=>[report('codex',used,10)]};
 const bridge=await startBridge({manager,runtime,paseoHome:home,serverId:'test',home,mode:'enforce',watchdogMs:100000});
 t.after(()=>bridge.close());
 const service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')}); t.after(()=>service.close());
 const wrapped=session.tryHandleOutOfBand(); assert.ok(wrapped && typeof wrapped.run==='function');
 assert.equal(await wrapped.run(),'ran'); assert.equal(runs,1);
 used=96; await service.tick(true);
 await assert.rejects(wrapped.run(),/额度保护/); assert.equal(runs,1);
});

test('手机推送：有效租约、受理状态和按设备去重，不声称已送达', async t => {
 const home=temp(t); let sent=0;
 writeFileSync(join(home,'push-tokens.json'),JSON.stringify({subscriptions:[{token:'ExponentPushToken[test]',expiresAt:new Date(Date.now()+100000).toISOString()}]}));
 const bridge=await startBridge({manager:{agents:new Map()},runtime:{},paseoHome:home,serverId:'test',home,mode:'enforce',watchdogMs:100000,
   fetchImpl:async()=>{sent++;return {ok:true,json:async()=>({data:[{status:'ok',id:'ticket'}]})};}});
 t.after(()=>bridge.close());
 const payload={key:'one',title:'测试',body:'测试',kind:'test'};
 assert.deepEqual(await bridge.push(payload),{accepted:true,delivery:'unconfirmed',targetAvailable:false});
 await bridge.push(payload);assert.equal(sent,1);
 writeFileSync(join(home,'push-tokens.json'),JSON.stringify({subscriptions:[]}));
 assert.equal((await bridge.push({...payload,key:'two'})).accepted,false);
});

test('补丁版本和锚点严格校验，并备份原文件', t => {
 const root=temp(t);mkdirSync(join(root,'dist/server/server/agent'),{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'@getpaseo/server',version:'0.11.2'}));
 const provider=join(root,'dist/server/server/agent/provider-registry.js');
 const ws=join(root,'dist/server/server/websocket-server.js');
 const usage=join(root,'dist/server/builtin-plugins/codex-usage-source/server/usage.ts');
 mkdirSync(join(root,'dist/server/builtin-plugins/codex-usage-source/server'),{recursive:true});
 const claude=join(root,'dist/server/builtin-plugins/claude-usage-source/server/usage.ts');
 mkdirSync(join(root,'dist/server/builtin-plugins/claude-usage-source/server'),{recursive:true});
 writeFileSync(provider,'export function wrapSessionProvider(provider, inner) {\n}\n');
 writeFileSync(ws,'        this.pushNotificationSender = pushNotificationSender ?? this.pushNotifications;\n    async close() {\n        this.prepareForShutdown();\n');
 writeFileSync(usage,'  const headers: Record<string, string> = {\n  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);');
 writeFileSync(claude,'    const fallback = { key: hashAccountKey(JSON.stringify(input.route)), harness, input };\n    if (credentials.expires !== undefined && credentials.expires <= (lookup.now ?? Date.now)()) {\n      accounts.push(fallback);\n      continue;\n    }\n    try {\n      const profile = await readProfile(\n        credentials.oauth.accessToken,\n        fetchApi,\n        lookup.now ?? Date.now,\n      );\n      accounts.push("status" in profile ? fallback : { ...profile, harness, input });\n    } catch {\n      // Keep the login visible; fetching usage reports the vendor failure.\n      accounts.push(fallback);\n    }');
 const hashes=Object.fromEntries([provider,ws,usage,claude].map(p=>[p.slice(root.length+1),createHash('sha256').update(readFileSync(p)).digest('hex')]));
 const manifest=patchServer(root,'file:///test/bridge.mjs',hashes);assert.equal(manifest.length,4);
 assert.ok(readFileSync(provider,'utf8').includes('inner = quotaGuardSession(inner)'));
 assert.ok(!readFileSync(provider+'.quota-backup','utf8').includes('quotaGuardSession'));
 assert.ok(readFileSync(claude,'utf8').includes('quotaGuardIdentity'));
 assert.ok(!readFileSync(claude+'.quota-backup','utf8').includes('quotaGuardIdentity'));
 assert.throws(()=>patchServer(root,'file:///test/bridge.mjs'),/已打补丁/);
});

test('手机推送失败不会阻止自动暂停，重试后才记为受理', async t => {
 const home=temp(t);let time=1000000000,used=80,pushOk=false,stops=0,attempts=0;
 const bridge=await serve(join(home,'paseo.sock'),async path=>{
  if(path==='/snapshot') return {mode:'enforce',reports:[report('claude',used,0,time)],agents:[{running:true}]};
  if(path==='/interrupt'){stops++;return {complete:true,pending:[]};}
  if(path==='/push'){attempts++;return {accepted:pushOk};}
  return {ok:true};
 });t.after(()=>bridge.close());
 const service=await startService({home,config:config({notifications:true}),bridgePath:join(home,'paseo.sock'),now:()=>time});t.after(()=>service.close());
 assert.equal(attempts,1);assert.equal(stops,0);
 used=90;time+=1000;await service.tick(true);assert.equal(stops,1);assert.equal(service.engine.require('claude:a').locked,true);
 assert.equal(service.engine.store.events().filter(e=>e.kind==='push_submitted').length,0);
 time+=120000;pushOk=true;await service.tick(true);
 const submitted=service.engine.store.events().filter(e=>e.kind==='push_submitted');
 assert.equal(submitted.length,1);assert.equal(submitted[0].body.kind,'paused','不重发已过时的预警');
});

test('服务端检查发现子任务仍运行，不得宣称已暂停', async t => {
 const home=temp(t);
 const session={usageSession:()=>({provider:'claude',sessionKey:'child-test',env:{}}),interrupt:async()=>{},mainTurnInFlight:false};
 const a={id:'agent',session,provider:'claude',workspaceId:'w'};
 const bridge=await startBridge({home,mode:'enforce',manager:{agents:new Map([['agent',a]]),providerSubagents:{list:()=>[{id:'child',status:'running'}]}},
   runtime:{listUsageReports:async()=>[report()]},paseoHome:home,serverId:'test',watchdogMs:100000});t.after(()=>bridge.close());
 const result=await call(join(home,'paseo.sock'),'/interrupt',{accountId:'claude:a'});
 assert.equal(result.complete,false);assert.deepEqual(result.pending,['agent']);
 assert.match(result.failures[0], /子任务停止接口不可用/);
});

test('空闲主会话的后台任务按原生 ID 停止，收到终态后才能确认暂停', async t => {
 const home=temp(t); let status='running'; const stopped=[];
 const session={
  usageSession:()=>({provider:'claude',sessionKey:'background-native',env:{}}),
  interrupt:async()=>{}, mainTurnInFlight:false,
  taskProtocolSource:{subagentIdByTaskId:new Map([['native-background','toolu_background']])},
  query:{async stopTask(id) {
   stopped.push(id);
   assert.equal(id,'native-background');
   setTimeout(()=>{status='canceled';},25);
  }},
 };
 const a={id:'agent',session,provider:'claude',workspaceId:'w'};
 const bridge=await startBridge({home,mode:'enforce',
  manager:{agents:new Map([['agent',a]]),providerSubagents:{list:()=>[{id:'toolu_background',status}]}},
  runtime:{listUsageReports:async()=>[report()]},paseoHome:home,serverId:'test',watchdogMs:100000});
 t.after(()=>bridge.close());
 const result=await call(join(home,'paseo.sock'),'/interrupt',{accountId:'claude:a'});
 assert.deepEqual(stopped,['native-background']);
 assert.equal(status,'canceled'); assert.equal(result.complete,true); assert.deepEqual(result.pending,[]);
 assert.deepEqual(result.failures,[]);
});

test('stopTask 成功返回但后台任务仍运行时保持暂停未完成', async t => {
 const home=temp(t); let stops=0;
 const session={
  usageSession:()=>({provider:'claude',sessionKey:'background-unconfirmed',env:{}}),
  interrupt:async()=>{}, mainTurnInFlight:false,
  taskProtocolSource:{subagentIdByTaskId:new Map([['native-background','toolu_background']])},
  query:{async stopTask(id){assert.equal(id,'native-background');stops++;}},
 };
 const a={id:'agent',session,provider:'claude'};
 const bridge=await startBridge({home,mode:'enforce',
  manager:{agents:new Map([['agent',a]]),providerSubagents:{list:()=>[{id:'toolu_background',status:'running'}]}},
  runtime:{listUsageReports:async()=>[report()]},paseoHome:home,serverId:'test',watchdogMs:100000});
 t.after(()=>bridge.close());
 const result=await call(join(home,'paseo.sock'),'/interrupt',{accountId:'claude:a'});
 assert.equal(stops,1); assert.equal(result.complete,false); assert.deepEqual(result.pending,['agent']);
});

test('未知额度源及插件误用不能变成默认放行', async t => {
 const home=temp(t);let body;
 const server=await serve(join(home,'test.sock'),async(_,v)=>{body=v;return {ok:true};});t.after(()=>server.close());
 await call(join(home,'test.sock'),'/x',{value:1});assert.deepEqual(body,{value:1});
 await assert.rejects(serve(join(home,'test.sock'),()=>({})),/已运行/);
});

test('监控服务失联：watchdog 主动中断运行任务', async t => {
 const home=temp(t);let interrupts=0;
 const session={mainTurnInFlight:true,usageSession:()=>({provider:'claude',sessionKey:'wd',env:{}}),
  async interrupt(){interrupts++;this.mainTurnInFlight=false;}};
 const a={id:'agent',provider:'claude',session};
 const bridge=await startBridge({home,mode:'enforce',paseoHome:home,serverId:'test',
  manager:{agents:new Map([['agent',a]]),providerSubagents:{list:()=>[]}},runtime:{},watchdogMs:10,watchdogTimeoutMs:20});
 t.after(()=>bridge.close());
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(interrupts,1);
});

test('配置/执行模式不一致不能显示保护就绪；恢复必须本次找到账户', async t => {
 const home=temp(t);let bridgeMode='observe',present=true;
 const bridge=await serve(join(home,'paseo.sock'),async path=>{
  if(path==='/snapshot')return {mode:bridgeMode,reports:present?[report('claude',1,1)]:[],agents:[]};
  if(path==='/interrupt')return {complete:true,pending:[]};
  return {ok:true};
 });t.after(()=>bridge.close());
 const service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')});t.after(()=>service.close());
 let status=await call(join(home,'guard.sock'),'/status');assert.equal(status.enforcementReady,false);assert.match(status.lastError,/模式不一致/);
 bridgeMode='enforce';await service.tick(true);
 await call(join(home,'guard.sock'),'/pause',{accountId:'claude:a'});
 present=false;await assert.rejects(call(join(home,'guard.sock'),'/resume',{accountId:'claude:a'}),/未返回/);
});

test('界面设置：阈值即时生效、关闭后放行、开启重新检查、重启持久化', async t => {
 const home=temp(t);let stops=0,pushes=0;
 const bridge=await serve(join(home,'paseo.sock'),async path=>{
  if(path==='/snapshot')return {mode:'enforce',reports:[report('claude',85,10)],agents:[]};
  if(path==='/interrupt'){stops++;return {complete:true,pending:[]};}
  if(path==='/push'){pushes++;return {accepted:true};}
 });t.after(()=>bridge.close());
 let service=await startService({home,config:config({notifications:true}),bridgePath:join(home,'paseo.sock')});t.after(()=>service.close());
 const req=(p,b)=>call(join(home,'guard.sock'),p,b);
 const settings=async changes=>{const s=await req('/status');return req('/settings',{revision:s.settingsRevision,enabled:s.enabled,notifications:s.notifications,thresholds:s.thresholds,...changes});};
 assert.equal(stops,0);
 await settings({thresholds:{claude:{warn:70,pause:80},codex:{warn:90,pause:95}}});
 assert.equal(stops,1);assert.equal((await req('/admit',{reportIds:['claude:a']})).allowed,false);
 await settings({thresholds:{claude:{warn:80,pause:95},codex:{warn:90,pause:95}}});
 assert.equal((await req('/status')).accounts[0].locked,true,'调高阈值不会自动恢复');
 await settings({enabled:false});const n=stops,notifications=pushes;
 await service.tick(true);assert.equal(stops,n);assert.equal(pushes,notifications);
 assert.equal((await req('/admit',{reportIds:[]})).allowed,true);
 assert.equal((await req('/status')).enforcementReady,false);
 await service.close();service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')});
 let status=await req('/status');assert.equal(status.enabled,false);assert.equal(status.thresholds.claude.pause,95);
 assert.equal(status.notifications,true);assert.equal(stops,n);
 await settings({enabled:true,thresholds:{claude:{warn:70,pause:80},codex:{warn:90,pause:95}}});
 assert.equal(stops,n+1);assert.equal((await req('/admit',{reportIds:['claude:a']})).allowed,false);
});

test('设置校验和多端冲突：无效修改不写盘，不覆盖其他设备的新设置', async t => {
 const home=temp(t);
 const bridge=await serve(join(home,'paseo.sock'),async()=>({mode:'enforce',reports:[report()],agents:[]}));t.after(()=>bridge.close());
 const service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')});t.after(()=>service.close());
 const req=(p,b)=>call(join(home,'guard.sock'),p,b);
 const original=await req('/status');
 const input={revision:original.settingsRevision,enabled:true,notifications:false,thresholds:original.thresholds};
 await assert.rejects(req('/settings',{...input,thresholds:{claude:{warn:90,pause:80},codex:{warn:90,pause:95}}}),/阈值无效/);
 assert.equal((await req('/status')).settingsRevision,0);
 await req('/settings',{...input,enabled:false});
 await assert.rejects(req('/settings',input),/其他设备修改/);
 assert.equal((await req('/status')).enabled,false);
 assert.equal(JSON.parse(readFileSync(join(home,'settings.json'),'utf8')).enabled,false);
});

test('关闭保护后服务失联仍可继续，watchdog 不暂停；设置损坏不静默放行', async t => {
 const home=temp(t);let interrupts=0,invoked=0;
 const originalHome=process.env.PASEO_QUOTA_GUARD_HOME,originalMode=process.env.PASEO_QUOTA_GUARD_MODE;
 process.env.PASEO_QUOTA_GUARD_HOME=home;process.env.PASEO_QUOTA_GUARD_MODE='enforce';
 t.after(()=>{if(originalHome===undefined)delete process.env.PASEO_QUOTA_GUARD_HOME;else process.env.PASEO_QUOTA_GUARD_HOME=originalHome;
 if(originalMode===undefined)delete process.env.PASEO_QUOTA_GUARD_MODE;else process.env.PASEO_QUOTA_GUARD_MODE=originalMode;});
 const inner={mainTurnInFlight:true,usageSession:()=>({provider:'claude',sessionKey:'disabled',env:{}}),
  async run(){invoked++;},async interrupt(){interrupts++;this.mainTurnInFlight=false;},async close(){}};
 const session=guardSession(inner);t.after(()=>session.close());
 const bridge=await startBridge({home,mode:'enforce',paseoHome:home,serverId:'test',
  manager:{agents:new Map([['a',{id:'a',session,provider:'claude'}]]),providerSubagents:{list:()=>[]}},
  runtime:{listUsageReports:async()=>[report()]},watchdogMs:10,watchdogTimeoutMs:20});t.after(()=>bridge.close());
 const service=await startService({home,config:config(),bridgePath:join(home,'paseo.sock')});
 const s=await call(join(home,'guard.sock'),'/status');
 await call(join(home,'guard.sock'),'/settings',{revision:s.settingsRevision,enabled:false,notifications:false,thresholds:s.thresholds});
 await service.close();await session.run();assert.equal(invoked,1);
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(interrupts,0);
 writeFileSync(join(home,'settings.json'),'{}');
 await assert.rejects(session.run());
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(interrupts,1);
});
