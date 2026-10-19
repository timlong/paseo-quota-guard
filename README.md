# Paseo Quota Guard

运行在 qt38 的 Claude / Codex 额度保护。固定规则程序，不调用 Pi 或任何模型。

| 服务商 | 预警 | 自动暂停 | 额度窗口 |
| --- | --- | --- | --- |
| Claude | 80% | 90% | 必须有 5 小时、周额度 |
| Codex | 90% | 95% | 只保护实际返回的 5 小时/周窗口；至少一个有效窗口 |

以上为用户 2026-10-18 确认的默认阈值，可随时在界面调整。任一受控窗口达到阈值即触发。预警通过 Paseo 手机推送发送，用户可以在插件中手动暂停；未操作则到阈值自动暂停。恢复需手动操作，保留原会话，不自动向模型发送“继续”。

## 当前状态

首版代码、28 项自动化测试和隔离 Paseo 集成已完成。真实测试通知已发送，用户已确认在手机通知栏收到。**已获生产部署授权，将由独立后台任务等待会话空闲后切换。实际部署结果查看 `.local/reports/production-deployment.json`，不能以已安排任务代替已启用。** 新插件手机界面、通知点击跳转及真实模型任务的暂停/恢复仍需上线验收；测试通知送达不代表这些项目已通过。

实际额度只读验证已成功：Claude 返回 5 小时与周额度；Codex 本次只返回周额度。后者按照用户确认的“只保护已返回窗口”处理。

详见 `docs/acceptance.md`、`docs/architecture.md`、`docs/deployment.md`。

## 本地检查

要求 Node.js 24 或以上，核心使用 ESM 和内置 SQLite，不需要模型或 npm 运行依赖。

```bash
npm test
npm run demo
npm run doctor

# 插件类型检查
npm ci --prefix plugin --ignore-scripts
npm run typecheck --prefix plugin

# 可选：只读连接当前 Paseo 查询真实额度，不发送模型消息
npm run doctor -- --live
```

`demo` 在临时目录启动模拟桥接与真实监控服务，演示预警、暂停、恢复，输出 `.local/reports/demo.json`；不会接触生产 daemon 或发送真实手机推送。

## 组件

- `src/policy.mjs`：阈值、窗口识别、数据时效和恢复判断。
- `src/engine.mjs`：账户状态机、告警去重、手动暂停/恢复。
- `src/store.mjs`：SQLite 状态、通知 outbox、审计。
- `src/main.mjs`：后台服务、轮询、中断执行与通知重试。
- `src/codex-account.mjs`：经官方 Codex app-server 读取与使用重置卡。
- `src/bridge.mjs`：Paseo 0.11.2 内部桥接、发送前检查、watchdog、手机推送。
- `plugin/`：Paseo 手机/桌面 UI、`/quota` 命令和控制 RPC。
- `scripts/patch-paseo.mjs`：校验版本、SHA256 和补丁锚点，仅复制后修改。
- `scripts/stage-runtime.mjs`：复制并固定运行依赖、核心和插件，生成隔离发布目录。
- `scripts/verify-release.mjs`：验证发布文件哈希、实际 provider 包装入口、Codex 限流冷却及 Claude 身份兜底缓存。
- `deploy/`：systemd unit 模板；不会自动安装或启用。

Paseo 补丁除 Codex 429 冷却外，还修正 Claude 额度源的身份兜底：凭据过期、profile 返回 status 或抛错时，用「route 哈希 + 凭据秘密哈希」的内存指纹（有界，仅存哈希与已公开的 key/label）命中上次成功读到的真实账户，避免抖动生成无数据影子账户。秘密取 refreshToken 去空白（为空则取 accessToken 去空白），两者皆空则不读写缓存，秘密变化则回退原兜底哈希。账户清理方面，从未有过有效读数、未锁定、无暂停状态（partial/paused）、且超过 `pruneMs`（默认 6 小时）未被报告的账户会被隐藏（不删行），不参与状态展示；任何锁定账户保持可见，再次被报告即自动取消隐藏。

配置默认是 `observe`，只计算、不发送生产预警、不暂停任务。生产启用需要监控服务和 Paseo 执行层同时设置为 `enforce`。

## 用户操作

Paseo 侧栏底部打开“额度保护”，或者在 agent 会话输入 `/quota`。手机先展开侧栏。界面显示账户、窗口用量、更新时间、预警/暂停阈值和暂停状态。

页面顶部提供“启用额度保护”和“手机额度通知”开关；下方分别编辑 Claude/Codex 的预警与自动暂停百分比，点击“保存阈值”即时生效，无需重启。阈值要求 `0 ≤ 预警 < 暂停 ≤ 100`，支持小数。各服务商的一组阈值应用于其受控的 5 小时和周窗口。

关闭保护会解除额度拦截，停止额度预警及自动暂停，仍显示用量；不会自动续跑旧任务。重新开启会按最新有效读数立即检查，无有效数据时进入保护暂停。调低暂停线可能立即中断任务；调高阈值后已暂停的账户仍需手动恢复。设置在重启后保留，多端同时修改会提示刷新以防覆盖。

首次部署仍需按部署文档接入执行层：观察部署中打开开关只保存意图，页面明确显示不会执行暂停。

“暂停此账户”覆盖这台受控 Paseo daemon 中使用该账户的原生 Claude/Codex 会话。界面可能显示“正在暂停”或“暂停未完成”，不会仅凭普通 agent 状态变成 idle 就报告成功。

“恢复此账户”重新采集后才解除封锁。默认要求读数低于暂停线 2 个百分点：Claude <88%，Codex <93%。自定义暂停线很低时，恢复余量最多取暂停线的一半，以保证 0% 可以恢复。恢复后进入需要的原会话继续，不会自动启动全部历史任务。

CLI 维护入口：

```bash
node scripts/control.mjs status
node scripts/control.mjs refresh
node scripts/control.mjs pause '<账户报告ID>'
node scripts/control.mjs resume '<账户报告ID>'
node scripts/control.mjs test-push
```

通过 `QUOTA_GUARD_HOME` 选择实例；默认 `~/.local/state/paseo-quota-guard`。API 仅监听本地 Unix socket，不开放 TCP 管理端口。

## Codex 重置卡

Codex 卡片显示套餐、Credit 余额、主动重置次数及每张重置卡的过期时间（GMT+8）。数据通过官方 Codex app-server 的 `account/rateLimits/read` 读取，缓存 10 分钟，“刷新额度”强制重读。

“重置额度”调用 `account/rateLimitResetCredit/consume`，默认使用最早到期的一张，需二次确认，不可撤回。只有本机 Codex 登录账户与卡片账户一致、且 Codex 后端确认额度已触顶（`ordinaryUsageAllowed=false` 或返回了触顶类型）时才会执行；未触顶时按钮不可用且不消耗重置卡。重置后立即重读用量；已被保护暂停的账户仍需手动恢复。每次使用写入审计 `reset_credit_consumed`。该协议在 codex-cli 中标为实验性，升级 Codex 后需复核。

## 限制

额度有采样延迟，在途模型请求可能继续消耗，阈值不是计费硬上限。只控制接入补丁的 Paseo 原生 Claude/Codex 会话；网页、其他电脑、手工终端启动的 CLI，以及其他 harness 不在首版控制范围内。

现有 provider 的中断未能结束后台子任务时，保留封锁并报告部分失败，不擅自强杀进程。独立运行的 shell 命令和已经发生的文件修改不会回滚。

手机推送复用 Paseo 的 Expo 订阅。点击先进入 Paseo；能否精确跳转到关联会话需要手机验收，不承诺原生通知栏“一键暂停”。在 App 中通过“额度保护”操作。手机系统通知权限、订阅有效性和网络状态影响送达，但不影响自动暂停规则。
