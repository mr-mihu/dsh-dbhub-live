# 需求：给插件一条「手机端收一次密钥」的通道

> 这份文件是给 [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 的 issue 草稿（功能请求），也是本插件的适配依据。dsh-Go 有「暂不接受外部 PR」的政策，所以这里只提需求、不附补丁。
> 现状核对基于 dsh-Go `main` 的 `6db08d2e2`（App `1.1.0+1`）与 DSH `0.2.2-rc.3`。

## 一句话

**让插件能在手机上收一次密钥（数据库口令、DSN、SSH 口令），收完直接交给宿主半侧，不经过面板数据、不进会话记录、不回显。** 有了这条通道，像 dsh-dbhub-live 这样的凭据型插件才可能把「添加 / 修改连接」搬出网页版。

## 现在卡在哪

dsh-dbhub-live 的手机端面板（视图协议 v1）能看状态、能测连接、能改五项不涉及密钥的设置，但**加/改一条数据库连接做不了**，因为要收两个秘密：连接串里的口令，和可选 SSH 隧道的口令。手机用户只能点「在网页版设置」绕过去。

绕不过去的原因有三条，都在协议层面，不是插件偷懒：

| 通道 | 卡在哪 | 依据 |
| --- | --- | --- |
| 面板视图（v1 / v2） | **没有密码组件**：`inputs.md` 明说「没有密码组件，也不接受 `password`、`obscureText` 或密码键盘类型」；`controls-check.js` 对这些键直接判 `broken`。v1 里唯一能「点一下设一个值」的是 `options`（值必须是字符串、且取值可枚举），收不了自由文本，更收不了秘密 | `docs/plugins/inputs.md`、`sdk/plugin-kit/lib/controls-check.js` |
| 插件配置的原生表单 | 裸 `role('secret')` **只写不读**而且**不可写**（v1 拒绝：裸密钥会落进 profile YAML），显示「需插件适配后设置」；可写的只有 `role('credential-ref')` 绑定的凭据，且 `credentials/*` 只认**范围内声明过**的 ref | `docs/design/plugin-config.md` §3/§4、`runtime/bridge/dsh-go-bridge/lib/plugin-config.js` |
| `ask_user_question` 的自由文本 | 能收文本，但**答案是明文落进会话记录的**（`AskUserQuestionItem` 没有 secret/隐藏语义，App 用普通 `TextField` 收），而且这段文本随后会进模型上下文——用它收口令等于把口令写进历史 | `packages/interaction/user-questions/src/types.ts`、`app/lib/ui/chat/widgets/question_card.dart` |

## 想要的形态（三者取一即可，按实现成本排序）

1. **最小可行：宿主侧的一次性密钥请求**
   插件在动作里返回一个「要一个秘密」的延后结果，App 弹一个**遮蔽输入**（不自动填充、不上屏、不存草稿），用户输入后值**只走 invoke 回包到宿主**，回调拿到值后用掉即丢；取消/超时等于什么都没发生。
   建议形状：`pending` 里加 `secret: { label, timeoutMs }`，回调参数 `{ secret }`；面板拿不到它，`patch` / `data` 里也永远不出现。

2. **面板内写一次：视图里的 write-only 密钥控件**
   v2 加一个 `secretField`（`bind` 只写、不回读；不进 `data`；`form.submit` 时只在 `event.value.values` 里出现一次，宿主确认后不得回写进数据模型），并用 `caps.components` 门控，老 App 退回静态文字 + 「在网页版设置」。

3. **或者：让插件配置里的裸 `role('secret')` 可写**
   在「写进 DSH 凭据库、不落 profile YAML」的前提下放开裸 secret 的写入（按条目范围 + 由宿主签发 ref），这样连表单都不必改。

## 无论哪条，请一并保证

- 值**永不**出现在视图 JSON、`data` emit、`patch`、会话日志 / 诊断包 / 崩溃上报里；日志里只留「某条目的某个字段被设置」这种不含值的一行。
- 输入控件是遮蔽的，禁自动填充 / 联想 / 剪贴板建议，截屏保护按 App 现有做法。
- 写入受 `caps` / 清单门控：App 没有这个能力时插件自动退回「在网页版设置」，不画灰色占位。
- 一次只收一个值，值有长度上限，取消即零副作用；宿主侧可校验（我们会自己再校验一遍）。
- 远程主机 / 中转模式下明确报「不支持」，别让用户以为填了生效（现在面板本来就只在本机引擎上有）。

## 有了之后我们会做什么

dsh-dbhub-live 会在面板里加「添加连接 / 改口令」两步表单（类型 / 主机 / 端口 / 库名 + 口令），走上面第 1 或第 2 种形态；**在它落地之前，本插件的手机面板保持零密钥**（沿用现在的做法，只提示去网页版），这是有意为之，不会为了功能悄悄把口令塞进视图数据。

## 现在能用的替代（说明这不是阻塞项）

App 里可以打开网页版设置页（`plugins.row.config` / 「在网页版设置」），在手机上照样能填 DSN 与口令——只是要走 WebView、体验比原生表单重。所以本 issue 的定位是**体验与安全的改进**，不是「手机端不可用」。
