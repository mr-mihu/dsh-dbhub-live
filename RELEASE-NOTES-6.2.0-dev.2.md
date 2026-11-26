# dsh-dbhub-live 6.2.0-dev.2

> dev 测试版（prerelease）。`latest` 仍是 6.1.0。

## 修什么

**写库授权弹窗不再自己超时**。

- 以前 `dbhub_execute_sql` 声明了 60 秒的工具级超时，DSH 会拿它给这次调用上闸；时间一到就中断，授权服务把「被中断」折成 `cancelled`，插件只好回「本次写入未获授权」——你只是还没看到弹窗（在忙别的窗口），模型却以为是它被拒绝了，接着换别的办法或者干脆停任务。
- 现在这两个**会等人的工具**（`dbhub_execute_sql` 的写授权、`dbhub_configure` 的口令/DSN 弹窗）都不带工具级超时：弹窗会一直挂着，直到你点「允许」或「拒绝」，或者你主动中断本轮。
- 机器侧不会因此失控：dbhub 请求本身仍有 `MCP_INIT_TIMEOUT_MS`（15s）/ `MCP_CALL_TIMEOUT_MS`（120s），探连有 25s/45s 预算，运行时安装有 180s 上限。
- 纯工具（列数据源、查对象）保留 30s/60s 上限——它们不等任何人。

实测依据：翻了你本机近三天的会话日志，**所有被取消的 dbhub 授权都卡在整 60 秒**（`approval/decided` 时间戳与 `approval/asked` 相隔 60s），与 `execute_sql` 原来的 `timeoutMs: 60000` 完全对上。

## 顺带

- 新增门禁 `test/tool-timeouts.test.mjs`：会等人的工具不得声明 `timeoutMs`，不等人的工具必须保留上限。
- 自述文档的支持版本表里不再有「⚠️ 通过（有告警）· 手工装配」这类环境性备注（6.2.0-dev.1 起用真实 `dsh plugin add` + 预装 dbhub 跑矩阵，5/5 目标 × 21 项全绿）。
