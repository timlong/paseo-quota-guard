import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// Usage: node scripts/verify-plugin-compat.mjs <fixture-dir> <app-version> <plugin-dir>...
// fixture-dir contains version-matched npm dependencies and upstream host/*.ts.
// UI primitives and transport are simulated; the SDK, evaluator and registry are real.
const [fixtureArg, version, ...directories] = process.argv.slice(2);
assert.ok(fixtureArg && version && directories.length, '需要 fixture、客户端版本和候选插件目录');
const fixture = resolve(fixtureArg), require = createRequire(join(fixture, 'package.json'));
const dependency = name => import(pathToFileURL(require.resolve(name)).href);
const React = await dependency('react'), jsxRuntime = await dependency('react/jsx-runtime');
const sharedSdk = await dependency('@getpaseo/plugin'), clientSdk = await dependency('@getpaseo/plugin/client');
const hostSdk = await dependency('@getpaseo/plugin/client/host');
const { PluginRpcProvider } = hostSdk;
const compatibility = await dependency('@getpaseo/protocol/plugin-requirements');
const Zod = await dependency('zod');
const { default: TestRenderer, act } = await dependency('react-test-renderer');
const ts = require('typescript');
assert.equal(JSON.parse(readFileSync(join(fixture, 'node_modules/@getpaseo/plugin/package.json'))).version, version);
assert.equal(JSON.parse(readFileSync(join(fixture, 'node_modules/@getpaseo/protocol/package.json'))).version, version);
const { compilePlugin } = await import('/home/qingteng/.local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const native={StyleSheet:{create:x=>x,flatten:x=>x},View:'View',Text:'Text',Pressable:'Pressable',Switch:'Switch',Image:'Image'};
const hostNative={Icon:'Icon',ScrollView:'ScrollView',TextInput:'TextInput'};
function loadTs(file, dependencies) {
 const exports={};
 const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(source,{exports,require:id=>{if(id in dependencies)return dependencies[id];throw Error('Unexpected dependency '+id);},console,AbortController,setInterval,clearInterval,setTimeout,clearTimeout},{filename:file});
 return exports;
}
const root=join(fixture,'host')+'/';
const icons=loadTs(root+'icons.ts',{react:React,'lucide-react-native':{},'@getpaseo/plugin':sharedSdk,'@/components/provider-icons':{SvgIcon:'SvgIcon'}});
const evaluator=loadTs(root+'evaluate.ts',{
 '@/utils/open-external-url':{openExternalUrl:()=>{}},'./react-native/ui':hostNative,'@getpaseo/plugin/client/host':hostSdk,'@/hooks/use-revealed-text':{useRevealedText:x=>x},'./settings/use-settings':{useSettings:()=>{}},
 '@getpaseo/plugin':sharedSdk,'@getpaseo/plugin/client':clientSdk,react:React,'react/jsx-runtime':jsxRuntime,
 'react-native':native,'@tanstack/react-query':{},zod:Zod,'./icons':icons,
 './react-native/runtime':{pluginReactNativeRuntime:hostNative},'./themes':{parsePluginThemeContribution:x=>x},
});
const {PluginRegistry}=loadTs(root+'registry.ts',{
 react:React,'@getpaseo/plugin/client/host':hostSdk,'@/i18n/i18next':{i18n:{language:'zh-CN',on(){},off(){}}},'@tanstack/react-query':{QueryClient:class{clear(){}}},
 '@getpaseo/client':{createPaseoApi:()=>({dispose:async()=>{}})},
 '@getpaseo/protocol/plugin-requirements':compatibility,'@/utils/app-version':{resolveAppVersion:()=> version},
 './client-runtime':{createPluginClientRuntime:()=>({})},'./evaluate':evaluator,
});
assert.match(version, /^\d+\.\d+\.\d+$/, '使用正式客户端版本验证');
const [major, minor] = version.split('.').map(Number);
const nextMinor = `${major}.${minor + 1}.0`;
const old={id:'quota-guard',requirements:{paseo:`>=0.11.2 <${version}`}};
assert.throws(()=>compatibility.assertPluginCompatibility({...old,version,runtime:'app'}),/requires Paseo/);
const results=[];
for(const directoryArg of directories) {
 const directory=resolve(directoryArg);
 const fixed=JSON.parse(readFileSync(join(directory,'paseo-plugin.json'),'utf8'));
 for(const v of ['0.11.2','0.12.0',version])compatibility.assertPluginCompatibility({...fixed,version:v,runtime:'app'});
 assert.throws(()=>compatibility.assertPluginCompatibility({...fixed,version:nextMinor,runtime:'app'}));
 const bundles=await compilePlugin({client:directory+'/index.client.tsx',server:directory+'/index.server.ts'});
 const calls=[], opened=[];
 const snapshot={enabled:true,mode:'enforce',notifications:true,enforcementReady:true,settingsRevision:0,
  thresholds:{claude:{warn:80,pause:85,windows:{five_hour:{warn:75,pause:80},weekly:{warn:80,pause:90}}},codex:{warn:90,pause:95}},agents:[],accounts:[{
   id:'claude:test',provider:'claude',label:'test',locked:false,reason:'',stopStatus:null,error:null,ready:false,
   windows:[{id:'five_hour',used:35,reset:null},{id:'weekly',used:20,reset:null}],assessment:{level:'normal',canResume:true},
  }]};
 snapshot.historicalAccounts = [{...snapshot.accounts[0], id:'claude:previous', label:'历史测试账户',
   locked:true, reason:'用户手动暂停', pauseCause:'manual', stopStatus:'paused', lastSeenAt:Date.now()-86400000}];
 let savedSettings;
 const client={invokePluginRpc:async(id,method,input)=>{
  assert.equal(id,'quota-guard');assert.equal(method,'quota.control');
  assert.ok(['status','settings'].includes(input.action));calls.push(input.action);
  if(input.action==='settings'){savedSettings=input.settings;snapshot.thresholds=input.settings.thresholds;snapshot.settingsRevision++;}
  return {...snapshot};
 }};
 const registry=new PluginRegistry({version,localeSource:{getLocale:()=> 'zh-CN',subscribe:()=>()=>{}},createRuntime:installation=>({i18n:installation.i18n,rpc:installation.invoke,openScreen:p=>opened.push(p),hosts:{}})});
 const warn=console.warn;
 try {
  console.warn=()=>{}; // Expected rejection: reproduce the disappearing entry before reload.
  registry.installCatalog('test-host',[{...old,clientBundle:bundles.clientBundle}],{client,audio:{play:()=>{}}});
 } finally {console.warn=warn;}
 assert.equal(registry.getSnapshot().length,0);
 assert.match(registry.getEvaluationError('test-host','quota-guard'),/requires Paseo/);
 registry.installCatalog('test-host',[{...fixed,clientBundle:bundles.clientBundle}],{client,audio:{play:()=>{}}});
 assert.equal(registry.getEvaluationError('test-host','quota-guard'),undefined);
 const installations=registry.getSnapshot();assert.equal(installations.length,1);
 const p=installations[0];assert.equal(p.surfaces[0].id,'dashboard');assert.equal(p.sidebarItems.footer[0].id,'quota-guard');
 assert.equal(p.clientSlashCommands[0].name,'quota');
 p.clientSlashCommands[0].onSubmit({openScreen:x=>opened.push(x)});assert.equal(opened[0].screenId,'dashboard');
 let view;
 const props={theme:{colors:new Proxy({},{get:()=> '#cccccc'})},layout:{compact:false},openScreen:x=>opened.push(x)};
 await act(async()=>{view=TestRenderer.create(React.createElement(PluginRpcProvider,{invoke:p.invoke},
  React.createElement(React.Fragment,null,React.createElement(p.sidebarItems.footer[0].Component,props),React.createElement(p.surfaces[0].Component,props))));});
 assert.ok(calls.length>=2);const rendered=JSON.stringify(view.toJSON());assert.match(rendered,/Claude/);assert.match(rendered,/35/);
 assert.ok(!rendered.includes('历史测试账户'), '历史记录默认折叠');
 const historyButton=view.root.findAllByType('Pressable').find(n=>n.props.accessibilityLabel==='展开历史账户');
 assert.ok(historyButton);await act(async()=>historyButton.props.onPress());
 assert.match(JSON.stringify(view.toJSON()),/历史测试账户/);
 assert.match(JSON.stringify(view.toJSON()),/用户手动暂停/);
 const collapse=view.root.findAllByType('Pressable').find(n=>n.props.accessibilityLabel==='收起历史账户');
 assert.equal(collapse.props.accessibilityState.expanded,true);
 await act(async()=>collapse.props.onPress());assert.ok(!JSON.stringify(view.toJSON()).includes('历史测试账户'));
 const sidebarButton=view.root.findAllByType('Pressable').find(n=>String(n.props.accessibilityLabel).startsWith('额度保护'));
 assert.ok(sidebarButton);await act(async()=>sidebarButton.props.onPress());assert.equal(opened.at(-1).screenId,'dashboard');
 const settingsButton=view.root.findAllByType('Pressable').find(n=>n.props.accessibilityLabel==='展开设置');
 assert.ok(settingsButton);await act(async()=>settingsButton.props.onPress());
 const inputs=view.root.findAllByType('TextInput');
 const five=inputs.find(n=>n.props.accessibilityLabel==='Claude · 5 小时 自动暂停百分比');
 const weekly=inputs.find(n=>n.props.accessibilityLabel==='Claude · 周 自动暂停百分比');
 assert.ok(five && weekly);assert.equal(five.props.value,'80');assert.equal(weekly.props.value,'90');
 await act(async()=>five.props.onChangeText('82'));
 await act(async()=>weekly.props.onChangeText('95'));
 const save=view.root.findAllByType('Pressable').find(n=>n.props.accessibilityLabel==='保存阈值');
 assert.ok(save && !save.props.disabled);await act(async()=>save.props.onPress());
 assert.equal(savedSettings.thresholds.claude.windows.five_hour.pause,82);
 assert.equal(savedSettings.thresholds.claude.windows.weekly.pause,95);
 assert.equal(savedSettings.thresholds.claude.windows.five_hour.warn,75);
 assert.equal(savedSettings.thresholds.codex.pause,95);
 await act(async()=>view.unmount());registry.removeHost('test-host');assert.equal(registry.getSnapshot().length,0);
 registry.installCatalog('test-host',[{...fixed,clientBundle:bundles.clientBundle}],{client,audio:{play:()=>{}}});
 assert.equal(registry.getEvaluationError('test-host','quota-guard'),undefined);
 assert.equal(registry.getSnapshot().length,1,'重连后应重新安装入口');
 registry.removeHost('test-host');
 results.push({directory,sdk:version,loader:`v${version} registry.ts and evaluate.ts`,bundled:true,registered:true,renderedWithHostAdapter:true,statusRpc:true,sidebarNavigation:true,slashCommand:true,independentWindowSettings:true,historicalAccountsDisclosure:true,manifestReloadRestoresEntry:true,reconnect:true,cleanup:true});
}
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const report={version,modelsCalled:false,realMacDisplayConfirmed:false,
 sourceTag:`https://github.com/getpaseo/paseo/tree/v${version}/packages/app/src/plugins`,
 sourceHashes:Object.fromEntries(['registry.ts','evaluate.ts','icons.ts'].map(f=>[f,digest(root+f)])),results};
writeFileSync(join(fixture,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
