# dsh-dbhub-live 6.2.0-dev.1

> ⚠️ 这是 **dev 测试版**（prerelease）。正式版请继续用 `dsh-dbhub-live@latest`（6.1.0）。
> 预发布不会抢 Release 页的 “Latest” 徽章，`npm publish` 也必须带 `--tag dev`。

## 这个版本在改什么

为满足插件市场收录审查：**缺少 DBHub 时的安装不再是静默行为，且运行时版本固定**。

- **固定 dbhub 版本**：安装串恒为 `@bytebase/dbhub@2.1.0`（`lib/runtime.mjs` 里的常量），没有 `latest`、没有版本范围、没有任何开关能改它。升级 = 改常量 + 重跑实测，随插件发版。
- **删除「自动更新」**：原来的「每 7 天自动升到最新版」整条链路（含设置项）已移除。装过之后不会自己变。
- **两条显式安装路径**（任选其一，都会用固定版本）：
  - **设置页一键安装**：连接列表上方新增「未安装 dbhub 运行时（固定 @bytebase/dbhub@2.1.0，约 75 MB）」+「安装 dbhub」按钮——零连接时也能装，不必先去对话里触发。点击即授权。
  - **对话里单次审批**：从工具调用触发时，弹一次确认（写明包名、版本、体积），同意才装。
- **boot 不再安装**：启动只探测已有可执行文件；没有就等用户决定，不联网。
- **安装形态**：`npm install @bytebase/dbhub@2.1.0 mysql2 pg mssql mariadb --omit=optional`。四个驱动作为直接根，`oracledb` / `cpu-features` / AWS SDK 不进树——否则 pnpm 11+ 会因未批准的构建脚本让**插件安装**本身失败。
- **运行时状态可见**：`/state` 新增 `dbhubRuntime`（固定版本 / 是否已装 / 是否插件装的），设置页「说明与技术详情」里直接显示。
- **用户自装优先**：PATH / mise 里的 dbhub 永远先用，且不会被替换。

## 升级后你可能看到的

- 第一次查询会弹一次「安装 dbhub 运行时」；或在设置页点「安装 dbhub」。都装完就不再多问。
- 设置页少了「dbhub 自动更新」这一项——这是有意的。

## 兼容性

- dbhub **2.1.0** 已实测：MCP 握手（2025-03-26）、`tools/list`、真实 `execute_sql`、生成的只读 TOML（`--config` + `READONLY_VIOLATION`）全部通过。
- 自装的 dbhub 1.4.0+ 仍可用（只读 / SSH 的 TOML 方言就按它写的）；`< 1.0.0` 仍然拒绝。
- DSH 版本要求不变：`>= 0.2.1`（`engines.dsh`）。
