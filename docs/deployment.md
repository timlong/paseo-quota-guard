# 部署和回退

当前含界面设置的候选包为 `.local/release-settings`；2026-10-18 起生产插件单独切换到 `.local/release-ui/plugin`（仅界面改版，两个服务仍用 `release-settings`，代码一致），见 `.local/reports/plugin-ui-update.json`；下文 `.local/release` 为示例路径，使用新候选时同步替换服务模板、启动命令和插件路径。

用户已授权部署到生产。因当前会话也运行在生产 Paseo 内，使用独立 systemd 部署任务等待全部会话空闲后切换。最终状态以 `.local/reports/production-deployment.json` 为准；只有 `status=success` 且 `productionEnabled=true` 才表示保护已启用。

## 构建候选运行目录

```bash
cd /home/qingteng/workspace/paseo-quota-guard
npm test
npm ci --prefix plugin --ignore-scripts
npm run typecheck --prefix plugin
npm run doctor
node scripts/stage-runtime.mjs
node scripts/verify-release.mjs
```

stage 目标必须不存在；重新生成时选择新的 release 路径，保留旧版本。它复制本机固定的 Paseo 0.11.2 及依赖，用原文件哈希和锚点验证补丁，然后复制 guard 核心、配置及插件。不会启动或停止生产 daemon。

仅修改 daemon 内的 bridge 时，可使用 `scripts/upgrade-production.py --daemon-only --release <候选目录>`。该模式支持 guard 与 daemon 已处于不同发布目录，仍要求候选通过隔离验证，并拒绝遗漏任何非 bridge 的 guard 源码差异。等待全部会话稳定空闲 60 秒后，只切换和重启 daemon；guard 单元与插件路径保持原样，失败时仅回退被切换的服务。可先加 `--preflight` 做只读比较；`--self-test` 覆盖切换、失败回退及错误范围拦截。bridge 随 daemon 加载，只重启 guard 不会使这类修复生效。

## 隔离验收

在全新 Paseo home 配置独立 loopback 端口并禁用 relay。不要把生产配置、会话库或 push token 复制到测试 home。

```bash
paseo daemon config set daemon.listen 127.0.0.1:16977 --home "$PWD/.local/paseo-home"
paseo daemon config set daemon.relay.enabled false --home "$PWD/.local/paseo-home"

PASEO_HOME="$PWD/.local/paseo-home" \
PASEO_QUOTA_GUARD_HOME="$PWD/.local/qg" \
PASEO_QUOTA_GUARD_MODE=observe \
node .local/release/server/dist/scripts/supervisor-entrypoint.js
```

另一个终端：

```bash
QUOTA_GUARD_HOME="$PWD/.local/qg" \
QUOTA_GUARD_CONFIG="$PWD/config/default.json" \
node .local/release/guard/main.mjs

# 插件只能安装到明确指定的隔离 daemon。
paseo plugin install "$PWD/.local/release/plugin" --home "$PWD/.local/paseo-home"
```

全新 daemon 可能默认关闭插件。在隔离 home 的 config.json 设置 `pluginsEnabled: true`，随后 `paseo reload --home "$PWD/.local/paseo-home"` 和 `paseo plugin reload quota-guard --home "$PWD/.local/paseo-home"`。不应据 reload 返回提示就重启生产。

测试完用 `paseo daemon stop --home "$PWD/.local/paseo-home"` 关闭隔离 daemon；监控服务用自己的终端 Ctrl-C 结束。不要使用模糊的进程名批量 kill。

## 生产切换步骤

这部分会替换现有 Paseo supervisor 的启动入口，属于单独的上线步骤。切换前记录原启动方式、版本及运行会话，安排没有正在执行任务的窗口；对生产 home 做权限受限的备份。用户的原会话/登录文件不应复制进项目仓库。

1. 将默认配置复制到 `~/.config/paseo-quota-guard/config.json`，初始仍用 observe。
2. 审阅 `deploy/` 两个 systemd 模板，确认 Node 路径（qt38 当前为 `/usr/local/bin/node`）、release 路径及 Paseo home。不要与原 supervisor 同时占用同一个 home。
3. 正常停止原 supervisor，启动候选 Paseo 服务，沿用 `~/.paseo`。启动 guard。验证原会话可见、登录不变、额度读取正常。
4. 在此 daemon 安装 release 内的 quota-guard 插件；检查插件运行状态和手机“额度保护”页面。
5. 开启配置 `notifications: true`，保持 observe。用“测试手机通知”发送明确标注的测试消息，核验锁屏、后台和点击进入 Paseo。测试通知不暂停任务。
6. 手机验收和账户映射确认后，将 guard 配置及 Paseo service 的 `PASEO_QUOTA_GUARD_MODE` 同时改为 enforce。在停用模型任务的窗口重新启动，避免一边 observe、一边 enforce。
7. 用一个专门测试会话验证手动暂停与恢复；真实自动暂停可用独立测试数据源/测试账户验证，不把真实订阅额度故意消耗到阈值。确认不会自动重放旧任务。
8. 启用两个 user service 的开机启动。需要退出登录后继续运行时，核对该用户的 systemd linger 状态。

服务模板不包含启用命令的自动执行逻辑，避免开发检查意外接管生产。手机通知依赖用户在 Paseo 中开启系统通知和保持有效注册；不能以后端 HTTP 200 代替手机验收。

## 日常维护

`node scripts/control.mjs status` 查看状态，`journalctl --user -u paseo-quota-guard` 查看服务输出。正常情况下日志不包含 token。账户读数异常超过 5 分钟会保护暂停；修复登录后刷新并手动恢复。

guard mode、Paseo bridge mode 必须一致。手动恢复只解除限制；用户进入指定原会话继续。

## 回退

先记录账户暂停状态和运行任务。正常停止候选 Paseo 服务，再停止 guard，恢复原 Paseo 启动入口。保留状态数据库，禁用 quota-guard 插件以避免显示断开的旧控制界面。原生产安装目录未打补丁，因此无需反向修改其 JS 文件。

回退后自动保护不再生效，需明确通知用户。不要在候选 Paseo 还处于 enforce 时单独长期停止 guard，否则执行层会拒绝新请求并触发 watchdog。

升级 Paseo 时重新 stage 并适配 hashes、内部接口与实际客户端；哈希不符就退出，禁止自动绕过。

界面设置优先于配置文件中的阈值和通知选项，保存在 guard 状态目录 `settings.json`。日常开启/关闭保护或修改阈值直接在 Paseo“额度保护”页面完成，无需重启服务。首次仍需将 guard 和 bridge 配置为 enforce 才有执行能力。回退时备份并保留此文件，避免丢失用户选择。

## 本次生产切换

- 运行目录：`.local/release-settings`；保持原来的 `~/.paseo`、服务器身份、登录配置和会话。
- 服务：`paseo-quota-daemon.service` 与 `paseo-quota-guard.service`；原启动方式保存在 `paseo-original-rollback.service`，只在回退时启动。
- 执行任务：`paseo-quota-rollout.service`。`scripts/deploy-production.py` 先等全部会话空闲，正常停止旧版，在 `~/.local/state/paseo-quota-deploy/backup-时间/` 创建权限受限的全量备份，然后启动新版、安装插件、通过认证 RPC 核验额度并打开保护。检查失败自动回退。
- 原服务环境（含密码与代理配置）保存在权限 0600 的 `~/.local/state/paseo-quota-deploy/runtime.env`，不进 Git、不输出到日志。
- 最多等待约一小时；仍有忙碌会话则不重启。任务完成后发送手机通知；网关受理与实际送达仍分开记录。
- 查看结果：`.local/reports/production-deployment.json`；该结果只包含脱敏状态。手机新界面的实际布局与点击验收不由后台检查代替。
- 当前 Paseo 继承了临时 D-Bus 地址，维护 user service 时明确使用 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`，避免连接到临时 session bus。

```bash
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user status paseo-quota-rollout paseo-quota-daemon paseo-quota-guard
cat .local/reports/production-deployment.json
```

## 升级到新发布包

`scripts/upgrade-production.py` 只改两个 systemd 单元 `ExecStart` 中的 release 路径并重启服务；不写插件、`~/.paseo/config.json`、daemon 身份文件或 guard 设置。前提是目标发布包的 `plugin/` 与当前生产插件目录逐字节相同（`release-codexfix/plugin` 与生产使用的 `release-ui/plugin` 一致）。

流程：`verify-release.mjs` 校验 → 源码、当前插件与发布包逐字节比对 → 解析单元路径 → 在 2 小时总期限内等待全部会话（含归档，`list-sessions.mjs` 并查询 provider 子代理）连续至少 60 秒保持空闲且状态不变 → 只读快照（`upgrade-status.mjs`，严格校验类型）与身份摘要 → 切换前再次确认 → 备份单元 → 原子改写单元、`daemon-reload`、依次重启 guard 与 daemon → 核验服务、会话基线、身份、插件路径与状态、enforce 模式及 `enabled/notifications/thresholds/settingsRevision` 与快照完全一致。重启后调用 `guard-reconnect.mjs` 让 guard 立即轮询执行层（未连接时每 30 秒最多一次），`bridgeMode` 为空视为暂态；验证窗口 7 分钟，长于 guard 5 分钟空闲轮询。启动暂态有限重试；设置、身份或单元不一致立即判为失败。报告写 `.local/reports/upgrade-production.json`，与首发脚本共用 `rollout.lock`。

```bash
python3 scripts/upgrade-production.py --self-test          # 内存桩，不触碰 systemd、daemon 或正式报告
python3 scripts/upgrade-production.py --release "$PWD/.local/release-codexfix" --preflight   # 只读，无 RPC、无写入

export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_RUNTIME_DIR=/run/user/1000
systemd-run --user --unit=paseo-quota-upgrade \
  --working-directory=/home/qingteng/workspace/paseo-quota-guard \
  --setenv=PATH=/usr/local/bin:/usr/bin:/bin:/home/qingteng/.local/bin --setenv=HOME=/home/qingteng \
  --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  /usr/bin/python3 /home/qingteng/workspace/paseo-quota-guard/scripts/upgrade-production.py \
  --release /home/qingteng/workspace/paseo-quota-guard/.local/release-codexfix
```

终态：`success`、`deferred`（期限内无法确认稳定空闲，未切换）、`not_switched`（准备或快照失败，未切换）、`rolled_back`、`rollback_needs_attention`。成功或失败通过 `deploy-notify.mjs upgrade-*` 推送，仅表示网关受理。

已接受的残余风险（写入报告 `residualRisks`）：切换期间无法阻止新任务进入，稳定空闲确认后新开的任务可能被重启中断；空子代理列表不能证明所有 provider 后台工作已结束；会话枚举与子代理查询会使服务端加载会话；空闲判定与会话基线基于目录接口，不包含 provider 不可用或无项目归属的会话。

## 升级回退

失败时脚本按 `switchProgress` 恢复已改写的单元（回读校验）。恢复或 `daemon-reload` 失败时不重启任何服务，记 `rollback_needs_attention` 并在 `serviceStates` 记录各服务实际状态；若候选 daemon 已启动失败，此时可能没有可用的 Paseo，需要人工处理。否则只重启本次已重启过的服务，再按同一标准核验旧版本；全部确认才记 `rolled_back`。手动回退：从 `~/.local/state/paseo-quota-deploy/backup-upgrade-*/` 恢复两个单元文件，`systemctl --user daemon-reload`，依次重启 guard 与 daemon 并确认状态。

## 2026-10-20 Mac 0.12.0 插件兼容修复

生产插件仍位于 `.local/release-recovery-notify-20261020/plugin`。经隔离验证，将该目录的 `paseo-plugin.json` 中 `requirements.paseo` 从 `>=0.11.2 <0.12.0` 改为 `>=0.11.2 <0.13.0`，通过插件 reload 热加载。生产仅这一文件变化，客户端 bundle 字节不变，daemon/guard PID、daemon 配置和保护设置均未变化，状态 RPC 与 enforce 核验通过。原 manifest 已备份；记录见 `.local/reports/plugin-compat-012/deployment.json`。之前本地的逐卡 Reset、暂停通知合并和自动恢复逻辑未随此兼容修复发布。Mac 实际显示需由客户端确认。

## 额度恢复与逐卡 Reset 发布

当 `src/bridge.mjs` 与正在运行的 Paseo release 完全一致时，可以仅发布新的 guard 与插件，不重启 Paseo daemon：

1. 完整测试、插件类型检查、0.12.0 加载验证通过后提交代码；把该提交的 `src/`、`plugin/`、`config/` 复制到独立 release，记录提交和文件哈希。
2. 在临时 SQLite、独立 socket 和模拟桥接上验证候选 guard 的暂停通知合并、自动恢复及逐卡 Reset。测试不调用模型或真实推送。
3. 持有 `rollout.lock`，备份 guard 单元、插件登记配置、guard 状态库和设置；只替换 guard 单元的入口路径并快速重启 guard，确认健康和 enforce 连接。Paseo 主进程保持不变。
4. 将 quota-guard 插件登记切换到已验证的新目录；确认 running、目录内容与候选一致、Mac 0.12.0 兼容、状态 RPC 正常，以及原阈值/开关/daemon 身份未改变。失败时恢复旧插件目录和 guard 单元。
5. 使用部署报告记录完成状态；客户端重新获取 catalog 后显示新界面。服务端验证不能代替 Mac 实际显示及手机通知送达确认。

此次发布包含逐卡 Reset、暂停通知合并、额度恢复通知和自动解除额度保护暂停；保留手动暂停，不自动续跑旧任务。

## 2026-10-25 Mac 0.13.0 插件兼容修复

本次入口消失发生在客户端升级到 0.13.0 后；服务端插件仍为 running，保护仍在 enforce。原因是旧 manifest 声明 `>=0.11.2 <0.13.0`，客户端 registry 在安装 catalog 时拒绝加载。重装同一声明不能解决问题。

已在独立目录安装官方 `@getpaseo/plugin` / `@getpaseo/protocol` 0.13.0，并使用 [v0.13.0 源码](https://github.com/getpaseo/paseo/tree/v0.13.0/packages/app/src/plugins) 中实际的 `registry.ts`、`evaluate.ts`、`icons.ts` 验证。SDK、加载器和注册逻辑为真实实现；原生 UI 组件及 RPC 传输采用测试适配，不调用模型，也不代表已经观察到 Mac 屏幕。验证覆盖旧声明拒绝、新声明热加载恢复、侧栏与页面渲染、status RPC、侧栏导航、`/quota`、断开清理与重连注册。

源码与生产 manifest 的兼容范围均更新为 `>=0.11.2 <0.14.0`。在持有生产变更锁并备份 manifest 后，reload `quota-guard`，确认新 catalog 可由 0.13.0 接受、插件 running、保护 ready。只修改 manifest，客户端 bundle、daemon/guard PID、daemon 配置与用户设置均保持不变。报告：`.local/reports/plugin-compat-013/result.json` 和 `deployment.json`。这里只验证客户端兼容性，服务端 bridge 仍绑定已适配的 0.11.2，不代表可以直接升级服务端。

隔离检查入口已经纳入仓库，便于今后升级时复现加载问题。准备 fixture 的依赖与官方 tag 源码后执行：

```bash
# fixture/package.json 和 node_modules 中安装对应版本的 SDK/protocol；
# 另需 react、react-test-renderer、typescript、zod。
# fixture/host/ 下放该 tag 的 registry.ts、evaluate.ts、icons.ts 原文件。
# plugin-dir 为隔离候选目录，不能为未修改的生产目录。
node scripts/verify-plugin-compat.mjs /tmp/paseo-plugin-compat-013 0.13.0 \
  /tmp/paseo-plugin-compat-013/production /tmp/paseo-plugin-compat-013/development
```

检查会保存上游源码哈希和结果到 fixture/result.json。升级客户端前应验证实际加载器与 SDK，再更新经过验证的兼容范围；无需重复安装插件。此命令不修改生产，不自动放行未验证的未来版本。

## 2026-10-26 分窗口阈值与异常恢复

调查发现 07:14、07:21、07:50、07:56 的暂停均为数据过期，暂停记录中的 Claude 5h 16–18%、周 79–80%，Codex 周 2%，未达到当时暂停线。07:23 的 daemon 日志出现多个额度源的 discovery RPC 超时。Codex 429 冷却为 15 分钟，长于 guard 的 10 分钟缓存；因此该冷却期间可能按过期规则暂停。现有证据不足以将每次失败都归因于 429。

根据用户最终确认，保留 10 分钟有效期，不增加宽限；从最后一次成功读取起满 10 分钟仍未更新即暂停。失败重试或重启不延长有效期，新有效读数满足所有窗口恢复线后自动解除异常暂停并通知。15 分钟限流期间仍可能暂停，这是当前明确保留的保守策略。手动暂停不自动解除。增加脱敏采集状态审计，便于后续区分超时、限流与桥接失败。Claude 5h/周阈值独立配置，任一触线暂停，恢复同时检查两个窗口。

本次用户配置为 Claude 5h 预警 75% / 暂停 80%，周预警 80% / 暂停 90%；Codex 保留 90% / 95%。仓库的通用默认值与旧设置不自动覆盖，由生产设置 RPC 按 revision 保存本次用户选择。

候选目录为 `.local/release-window-thresholds-20261026`。隔离验证覆盖 缓存到期前读取失败不暂停、恰满 10 分钟失败暂停、新读数自动恢复、重启与通知去重、分窗口设置持久化，以及官方 0.13.0 加载器上的界面独立编辑。测试使用模拟采集/中断/推送，不调用模型。验证报告：`.local/reports/window-threshold-verification.json`、`window-threshold-plugin-compat.json`。

部署使用 guard 与插件热更新流程，先校验候选 bridge 与**正在运行的 daemon release** 相同（不能用旧插件目录推断 daemon 版本），备份后仅重启 guard、替换插件目录。生产结果写入 `.local/reports/window-threshold-deployment.json`；daemon 无需重启，Mac 实际显示仍需客户端确认。

## 2026-10-30 Mac 0.14.0 插件兼容修复

用户确认 Mac 已升级到 0.14.0。生产插件仍为 running，保护 ready；入口隐藏的原因是 manifest 的 `>=0.11.2 <0.14.0` 不接受新客户端。此前修复只覆盖至 0.13.x，并没有建立未来版本的自动兼容保证。该上限限制客户端加载，与插件是否已安装、后台保护是否运行是两件事。

在隔离目录安装官方 0.14.0 SDK/protocol，并获取 v0.14.0 的实际 registry/evaluate/icons 源码；三份源码哈希与 0.13.0 一致。使用真实 SDK 和加载器、模拟 UI/传输适配，验证当前生产插件副本与仓库插件：旧版本范围拒绝、新范围加载、侧栏/页面、status RPC、分窗口设置、导航、`/quota`、清理和重连均通过；未调用模型或真实推送。验证脚本将旧范围与下一未支持版本边界改为依据目标版本计算，避免检查程序固定在 0.13/0.14。

源码与生产 manifest 更新为 `>=0.11.2 <0.15.0`。持有部署锁并备份后 reload 插件，确认仅 manifest 变化，客户端 bundle、daemon/guard PID、daemon 配置、阈值、开关与设置 revision 均不变。报告在 `.local/reports/plugin-compat-014/result.json`、`deployment.json`。Mac 实际屏幕未验证；重新连接可重新获取 catalog。0.15 及以后仍需独立兼容验证，不通过删除上限宣称支持未知 SDK。
