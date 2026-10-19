# Paseo Quota Guard

使用中文沟通。项目独立于 my-game，不操作游戏、ADB 或 Unity。
默认规则：Claude 80% 预警、90% 暂停；Codex 90% 预警、95% 暂停。任一 5h/周窗口触发。用户可在插件界面修改阈值、关闭或开启保护；持久设置优先于默认值。
Codex 只保护实际返回的已识别窗口，至少需要一个有效窗口；缺失窗口不得臆造为 0%。Claude 要求 5h 和周窗口。
不得将模拟测试、推送网关受理、界面 idle 误报为真实手机送达或所有 provider 子任务已停止。
生产 Paseo 的改动必须先在隔离副本验证；开发命令不得自动重启生产 daemon。
不打印凭证、push token 或完整 daemon 配置。测试不调用模型。
服务端为 Node 24 ESM，插件为 TypeScript；核心无第三方运行依赖。
