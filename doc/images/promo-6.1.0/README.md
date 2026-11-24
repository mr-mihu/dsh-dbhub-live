# dsh-dbhub-live 6.1.0 宣传图（Web 版截图）

这组图全部在 **DSH Web 版**（`dsh web` + Chrome，1600×1000 视口、deviceScaleFactor=2）里截取，
内容是插件的真实界面，连接数据是**演示数据**（虚构的 demo 工作区、假主机名、无任何真实凭据）。

| 文件 | 尺寸 | 说明 |
|---|---|---|
| `01-overview-light.png` | 3200×2000 | 主视觉：宽屏整页布局，5 个工作区 / 9 个连接，可写·只读标记、source 别名、搜索 / 排序 / 批量测试、顶部插件设置一行全show |
| `02-connection-test.png` | 2552×298 | 连接测试成功（`✓ 连接成功（SELECT 1，1275 ms）`），适合做细节小图 |
| `03-add-connection-ssh.png` | 2576×1169 | 添加连接：DSN + 只读模式 + 高级 SSH 隧道（主机 / 端口 / 用户 / 密钥 / 口令 / ProxyJump / 测试 SSH 隧道） |
| `04-edit-connection-ssh.png` | 2552×1093 | 行内编辑已有连接：改环境名 / DSN / 只读开关，SSH 隧道已配置的值回显 |
| `05-at-datasource.png` | 1802×456 | 对话输入框里 `@` 选数据源：当前工作区的 demo / prod（只读）连接，以及「其他工作区的连接」入口 |
| `06-mobile.png` | 1170×2532 | 手机小屏自适应布局（390×844，3x） |
| `07-overview-dark.png` | 3200×2000 | 深色主题下的同一页，可配浅色图做双主题展示 |
| `08-chat-query.png` | 3200×2000 | 对话里真查一次库：提问 → `已完成，用时 27 秒 · 1 轮 8 步` → 两张结果表（AI 实际调用 `dbhub_list_sources` / `dbhub_execute_sql`） |
| `09-settings-modal.png` | 1600×1600 | 「设置 → DBHub 数据库工具」弹窗内嵌布局（左侧 DSH 设置导航 + 右侧连接列表） |

## 与 `screenshots.json` 的对应

`scripts`/发版清单里引用的五张图已按同一语义换成 6.1.0 版本：

| 原图（5.2.0） | 现图（6.1.0） |
|---|---|
| `doc/images/test-success.png` | `doc/images/promo-6.1.0/01-overview-light.png` |
| `doc/images/ssh-tunnel.png` | `doc/images/promo-6.1.0/03-add-connection-ssh.png` |
| `doc/images/settings-modal.png` | `doc/images/promo-6.1.0/09-settings-modal.png` |
| `doc/images/mobile.png` | `doc/images/promo-6.1.0/06-mobile.png` |
| `doc/images/chat-query.png` | `doc/images/promo-6.1.0/08-chat-query.png` |

## 用图建议

- 商店页 / README 头图：`01-overview-light.png`；需要深色版就换 `07-overview-dark.png`。
- 功能介绍配图：`03` → `04` → `05` 按「连上库 → 配隧道/只读 → 对话里直接用」的顺序讲故事。
- 手机端展示：`06-mobile.png` 单列。

## 复现方式（脚本未入库）

截图脚本放在仓库外的本地目录：`seed.mjs`（演示数据）、`make-demo-db.mjs`（演示 SQLite 库）、
`steps-*.json` + `drive.mjs`（CDP 驱动 headless Chrome，1600×1000 @2x）。
演示数据写入一个独立的 `DSH_HOME`，不碰真实配置；图里的库路径是虚构的 demo 目录。
