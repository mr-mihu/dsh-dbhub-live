// dsh-dbhub-live — browser half (hand-authored lazy-CJS client bundle).
//
// Packaging contract: the Node client-modules scanner serves
// `exports["./client"]` for every Loader entry declaring `dsh.client`; the
// script must register a lazy CJS factory through `window.__ModuleLoader__.load`
// whose `id` equals the Loader entry name. The factory receives the shared
// `require` (React is a seeded baseline module) and returns the Cordis plugin
// object — `name` / `inject` / `apply`.
//
// The page renders the plugin's live status + configurable options + workspace
// connections from the plugin's own authenticated `/api/dsh-dbhub-live/*`
// bridge. It carries the whole view and accepts the same kind of writes:
// `enabled` (toggle), the UI options, and one-way workspace connection commands.
// Passwords never leave the Host — the view only carries METADATA summaries
// (host/port/database).
//
// Layout: the connection list groups workspace×environment rows by workspace
// PATH. When every workspace carries exactly one environment the rows are
// tiled (nothing hidden, one compact row per connection); as soon as one
// workspace owns several environments they fold per workspace instead, with
// click-to-expand group heads. `source` is a copy button, never an inline
// handle line.

window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  var react = require("react");
  // Short alias for the element factory (the page tree is deep).
  var h = react.createElement;
  // Product icon primitives (a baseline platform module). Every icon falls back
  // to a text glyph when a name is missing, so a dsh rename cannot break the
  // page; icons ride `currentColor`, so they follow the active theme.
  var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  function pickIcon(name, glyph) {
    var Icon = primitives && primitives[name];
    return typeof Icon === "function" ? Icon : function () { return h("span", { "aria-hidden": true }, glyph); };
  }
  var ChevronIcon = pickIcon("IconChevronDownOutline14", "▼");
  var CopyIcon = pickIcon("IconCopyOutline16", "⧉");
  var CloseIcon = pickIcon("IconCloseOutline16", "✕");
  // Row-action glyphs are drawn here instead of taken from the icon set: at 1x the
  // bundled edit glyph reads as an unidentifiable dash, while these three shapes
  // (filled play, pencil, lidded trash) stay recognisable at 16px on any DPI.
  var svgIcon = function (children) {
    return function (props) {
      var size = (props && props.size) || 16;
      return h("svg", {
        className: "dbh-svgicon",
        width: size, height: size, viewBox: "0 0 16 16",
        fill: "none", stroke: "currentColor", strokeWidth: "1.5",
        strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true, focusable: false,
      }, children);
    };
  };
  var RunIcon = svgIcon(h("path", {
    key: "play", d: "M5.2 3.3v9.4L12.6 8 5.2 3.3z",
    fill: "currentColor", stroke: "none",
  }));
  var EditIcon = svgIcon([
    h("path", { key: "body", d: "M10.9 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .7.7-3 7.6-7.6z" }),
    h("path", { key: "tip", d: "M9.7 3.8l2.3 2.3" }),
  ]);
  var TrashIcon = svgIcon([
    h("path", { key: "lid", d: "M3 4.5h10" }),
    h("path", { key: "handle", d: "M6.3 4.5V3.1h3.4v1.4" }),
    h("path", { key: "body", d: "M4.5 4.5l.6 8.6h5.8l.6-8.6" }),
    h("path", { key: "line1", d: "M6.6 7v4.2" }),
    h("path", { key: "line2", d: "M9.4 7v4.2" }),
  ]);
  // Read-only state: the user asked for the universally recognised emoji lock
  // pair — 🔓 when writable, 🔒 when writes are blocked. The hand-drawn 16px
  // shackle was too small to tell open from closed at a glance.
  // The refresh glyph is the update check's affordance: a named primitive when
  // the running dsh ships it, a text glyph otherwise (a rename must not blank
  // the button).
  var RefreshIcon = pickIcon("IconRefreshOutlineRegular", "↻");
  // The platform's own toggle: same geometry, tokens and 120ms thumb animation
  // as the harness settings pages, so it follows every theme/skin. A local
  // fallback with the same geometry keeps the control alive if a baseline build
  // predates the primitive.
  var SwitchPrimitive = primitives && typeof primitives.Switch === "function" ? primitives.Switch : null;

  var NS = "dsh-dbhub-live";

  // Locale dictionaries (dsh UI language) + fallback zh translator.
  var LOCALE_ZH = {
    title: "DBHub 数据库工具",
    "phase.running": "运行中",
    "phase.initializing": "初始化中",
    "phase.error": "异常",
    "phase.disabled": "已禁用",
    "tools.fixed": "{n} 个工具（固定）",
    // The host is older than the plugin's supported minimum (0.1.x is no longer
    // supported). A warning on the card, never a blocked page.
    "dsh.tooOldTitle": "DSH 版本过旧",
    "dsh.tooOld": "此插件需要 DSH {min} 或更高版本（当前 {v}）。请先升级 DSH；升级前工具仍可使用。",
    "dsh.tooOldShort": "需要 DSH {min}+",
    "desc.unconfigured": "未配置连接",
    "desc.environments": "{n} 个环境 · 已保存 {m}",
    "conn.title": "连接",
    "conn.total": "{n} 条 · {m} 个工作区",
    "grp.envs": "{n} 环境 · {m} 已保存",
    "cfg.policyHint": "开启后，系统提示词会声明「本插件已配置的连接一律走 dbhub_* 工具，不要用命令行客户端/脚本/驱动或其它插件绕过」，并说明本插件不支持的库可以用你安装的其它数据库插件。关闭只是不再注入这段文字——工具、只读与其它设置全部照常工作。",
    "cfg.sidebarHint": "关闭后左侧栏不再出现「DBHub 数据库工具」快捷入口——但插件照常工作（工具仍可用），本设置页与插件页也始终可进入。注意：点「禁用」会让入口无条件消失，与这个开关无关。",
    "cfg.updateHint": "dbhub 可执行文件的自动更新间隔（天）；0 = 不自动更新。",
    // Modern surfaces (5.2 redesign): one compact status line, DSH-style settings
    // rows, an on-demand update link, and a collapsed technical-details block.
    "status.conns": "{n} 个连接",
    "settings.title": "插件设置",
    "settings.toggle": "设置",
    "settings.more": "说明与技术详情",
    "settings.notes": "说明",
    "settings.less": "收起说明",
    "row.enable": "启用插件",
    "row.sidebar": "侧边栏入口",
    "row.policy": "向模型注入访问策略",
    "row.update": "dbhub 自动更新",
    "state.enable": "启用",
    "state.disable": "停用",
    "state.show": "显示",
    "state.hide": "隐藏",
    "state.on": "开启",
    "state.off": "关闭",
    "unit.days": "天",
    "note.tools": "模型侧固定 {n} 个工具；每次调用使用一次性 dbhub 进程，无常驻服务。",
    "note.update": "“dbhub 自动更新”只控制 dbhub 可执行文件；插件自身的版本更新走页头的升级提示。",
    "note.sidebar": "关闭侧边栏入口只是隐藏快捷入口，插件仍然工作；停用插件才会让模型无法调用工具。",
    "note.policy": "开启后，系统提示词会声明「本插件已配置的连接一律走 dbhub_* 工具，不要用命令行客户端/脚本/驱动或其它插件绕过」，并说明本插件不支持的库可以用你安装的其它数据库插件。关闭只是不再注入这段文字，工具、只读与其它设置全部照常工作。",
    "note.version": "插件 v{plugin} · DSH {dsh} · {runtime}",
    "ver.link": "可升级到 {v}",
    // The link EXPANDS the detail panel (the copy button lives inside it), so its
    // tooltip must describe that, not the copy.
    "ver.linkHint": "展开升级说明与安装命令",
    "ro.chipOnHint": "只读已开启，模型无法写入；点此关闭",
    "ro.chipOffHint": "开启只读，阻止模型写入（模型只能开、不能关）",
    "ro.writable": "可写",
    "ver.copySpec": "点击复制 dsh-dbhub-live@{v}",
    "ver.check": "检查更新",
    "ver.checking": "检查中…",
    "ver.checkFailed": "检查更新失败",
    "ver.checkedAgo": "检查于 {n} 分钟前",
    "ver.webHint": "Web 版：在终端执行 dsh plugin --profile web up dsh-dbhub-live@{v}，然后重启 dsh web。",
    "ver.desktopHint": "桌面版：打开左侧菜单 → 插件，卸载 dsh-dbhub-live 后重新安装最新版；连接与凭据保存在 ~/.dsh/storages/dsh-dbhub-live，不会被删除。",
    "ver.genericHint": "Web 版执行 dsh plugin --profile web up dsh-dbhub-live@{v} 后重启 dsh web；桌面版在插件页卸载后重新安装。",
    "ver.releaseNotes": "更新说明",
    "ver.copy": "复制",
    "ver.copyCmd": "复制命令",
    "ver.runtimeDesktop": "桌面版",
    "ver.runtimeWeb": "Web 版",
    "ro.turnOn": "开启只读",
    "ro.turnOff": "关闭只读",
    "cap.tooOld": "dbhub {v} 不支持只读 / SSH 隧道（需要 1.4.0 及以上）",
    "cap.untested": "dbhub {v} 未经验证（只读 / SSH 在 1.4.0+ 实测）",
    "add.readOnly": "只读模式",
    "ro.chip": "只读",
    "ro.title": "只读模式：dbhub 只放行只读语句，写操作会被拒绝（READONLY_VIOLATION）",
    "ro.sshTitle": "SSH 隧道 {host}:{port}（用户 {user}）",
    "add.adv": "高级：SSH 隧道",
    "adv.enable": "经 SSH 隧道连接",
    "adv.host": "SSH 主机",
    "adv.port": "端口",
    "adv.user": "SSH 用户",
    "adv.auth": "认证方式",
    "adv.auth.key": "密钥",
    "adv.auth.password": "密码",
    "adv.keyPath": "密钥路径",
    "adv.passphrase": "密钥口令",
    "adv.password": "SSH 密码",
    "adv.proxyJump": "ProxyJump（可选，单跳）",
    "adv.keepSecret": "留空 = 保持原值",
    "adv.hostHint": "主机名请填域名或 IP（不要填 ~/.ssh/config 里的别名）；库地址仍来自 DSN，要写“从跳板机看过去”的地址。",
    "adv.slow": "SSH 隧道首次连接较慢，请稍候。",
    "btn.testConn": "测试该配置",
    "btn.testSsh": "测试 SSH 隧道",
    "adv.testSshHint": "只测 SSH 层：先看跳板机端口通不通、密钥文件在不在，再让 dbhub 真的建一次隧道（故意连一个必然关闭的端口——数据库那步失败才说明隧道通了）。",
    "adv.testSshNeedFields": "请先填 SSH 主机与用户（并选择认证方式），再测试隧道。",
    "btn.saveOpts": "保存选项",
    "btn.save": "保存配置",
    "btn.add": "添加连接",
    "btn.addConn": "＋ 添加连接",
    "btn.addEnv": "＋ 环境",
    "btn.expandAll": "全部展开",
    "btn.collapseAll": "全部折叠",
    "btn.copy": "复制 source 值",
    "copy.ok": "已复制",
    "btn.edit": "修改",
    "btn.cancel": "取消",
    "btn.saved": "保存",
    "btn.delete": "删除",
    "btn.test": "测试",
    "test.testing": "测试中…",
    "test.elapsed": "测试中… {s}s",
    "test.timeout": "测试超时未返回",
    "saved.ok": "已保存 ✓",
    // Write feedback. The Host's refusal text is shown verbatim; a transport
    // failure (401 / offline / a dead fetch) has no Host text, so it becomes
    // this line — the page never claims a write it could not deliver.
    "error.write": "写入失败：宿主没有确认这次保存",
    "test.notSent": "测试命令未能送达宿主",
    "state.failed": "读取不到插件状态",
    "btn.retry": "重试",
    "cfg.badInterval": "更新间隔必须是 0–365 之间的整数天",
    "del.title": "删除这个连接？",
    "del.body": "环境「{env}」已保存的连接会被删除，删除后无法撤销；要恢复只能重新填写 DSN 保存一次。",
    "del.cancel": "取消",
    "del.confirm": "确认删除",
    "badge.saved": "已保存",
    "badge.auto": "自动",
    "ws.env": "环境",
    "ws.source": "来源",
    "ws.srcHint": "点此复制 source 值（模型查询时用它定位这条连接）",
    "ws.autoHint": "（自动发现、未保存；编辑并保存后转为已保存）",
    "ws.empty": "暂无连接。点上方「＋ 添加连接」，或让模型调用 dbhub_configure。",
    "ws.placeholder": "工作区路径或标题；留空 = 默认当前工作区",
    "env.placeholder": "如 prod / dev / test / 线上 / 测试；默认 default（支持中文）",
    "env.newPlaceholder": "环境名（可改中文名；留空保存为 default）",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "完整 DSN（密码勿泄露给模型）",
    "add.ws": "工作区",
    "add.env": "环境名",
    "add.dsn": "连接串 DSN",
    "src.user": "已保存·用户",
    "src.collected": "已保存·扫描",
    "src.copied": "已保存·复制",
    "src.promoted": "已保存·选项提升",
    "src.mise": "自动·mise env",
    "src.env": "自动·.env",
    "pretest.title": "校验并保存连接",
    "pretest.checking": "正在测试连接…",
    "pretest.askTest": "测试连接",
    "pretest.skip": "跳过测试直接保存",
    "pretest.saveOk": "保存",
    "pretest.cancel": "取消",
    "pretest.failHint": "测试未通过，但你仍然可以保存（已知晓问题）。",
    "ovr.title": "该环境已存在，是否覆盖？",
    "ovr.body": "工作区「{ws}」的环境「{env}」已有一条连接：{conn}。继续保存会覆盖它——原连接的凭据会被替换，且无法撤销。",
    "ovr.bodyAmbiguous": "环境「{env}」已存在于：{list}。工作区留空时由插件默认选定工作区；若命中的正是其中之一，保存会覆盖原连接。",
    "ovr.cancel": "取消（我改个名字）",
    "ovr.confirm": "覆盖并保存",
  };

  var LOCALE_EN = {
    title: "DBHub Database Tools",
    "phase.running": "Running",
    "phase.initializing": "Initializing",
    "phase.error": "Error",
    "phase.disabled": "Disabled",
    "tools.fixed": "{n} tools (fixed)",
    "dsh.tooOldTitle": "DSH version too old",
    "dsh.tooOld": "This plugin requires DSH {min} or later (currently {v}). Upgrade DSH first; the tools keep working until you do.",
    "dsh.tooOldShort": "requires DSH {min}+",
    "desc.unconfigured": "no connections configured",
    "desc.environments": "{n} environments · {m} saved",
    "conn.title": "Connections",
    "conn.total": "{n} · {m} workspaces",
    "grp.envs": "{n} env · {m} saved",
    "cfg.policyHint": "When on, the system prompt states that this plugin's configured connections go through the dbhub_* tools (no command-line client, script, driver or other plugin detour) and that databases it does not cover may use your other database plugin. Turning it off only removes that text — tools, read-only and every other setting keep working.",
    "cfg.sidebarHint": "When off, the “DBHub Database Tools” shortcut no longer appears in the sidebar — the plugin keeps working (its tools stay available) and this settings page plus the Plugins row stay reachable. Note: pressing Disable hides the entry unconditionally, independently of this switch.",
    "cfg.updateHint": "Auto-update interval (days) for the dbhub executable; 0 = never update automatically.",
    "status.conns": "{n} connections",
    "settings.title": "Plugin settings",
    "settings.toggle": "Settings",
    "settings.more": "Details & diagnostics",
    "settings.notes": "Details",
    "settings.less": "Hide details",
    "row.enable": "Enable plugin",
    "row.sidebar": "Sidebar entry",
    "row.policy": "Inject database access policy into the model",
    "row.update": "dbhub auto-update",
    "state.enable": "Enabled",
    "state.disable": "Disabled",
    "state.show": "Shown",
    "state.hide": "Hidden",
    "state.on": "On",
    "state.off": "Off",
    "unit.days": "days",
    "note.tools": "The model always sees {n} tools; every call runs a one-shot dbhub process (no resident service).",
    "note.update": "The dbhub auto-update interval only controls the dbhub executable; the plugin's own update is offered by the header link.",
    "note.sidebar": "Hiding the sidebar entry only removes the shortcut — the plugin keeps working. Only disabling the plugin stops the model from calling its tools.",
    "note.policy": "When on, the system prompt states that every connection configured here goes through the dbhub_* tools (no CLI clients, scripts, drivers or other plugins), and that databases this plugin does not support may use other database plugins the user installed. Turning it off removes only that text; tools, read-only and every other setting keep working.",
    "note.version": "Plugin v{plugin} · DSH {dsh} · {runtime}",
    "ver.link": "Upgrade to {v}",
    "ver.linkHint": "Show the upgrade details and the install command",
    "ro.chipOnHint": "Read-only is on and the model cannot write; click to turn it off",
    "ro.chipOffHint": "Turn read-only on to block model writes (the model can only turn it on, never off)",
    "ro.writable": "Writable",
    "ver.copySpec": "Click to copy dsh-dbhub-live@{v}",
    "ver.check": "Check for updates",
    "ver.checking": "Checking…",
    "ver.checkFailed": "Update check failed",
    "ver.checkedAgo": "Checked {n} min ago",
    "ver.webHint": "Web: run dsh plugin --profile web up dsh-dbhub-live@{v} in a terminal, then restart dsh web.",
    "ver.desktopHint": "Desktop: open Plugins in the left menu, uninstall dsh-dbhub-live, then install the latest version again. Connections and credentials live in ~/.dsh/storages/dsh-dbhub-live and are preserved.",
    "ver.genericHint": "Web: run dsh plugin --profile web up dsh-dbhub-live@{v} and restart dsh web. Desktop: uninstall the plugin on the Plugins page, then reinstall it.",
    "ver.releaseNotes": "Release notes",
    "ver.copy": "Copy",
    "ver.copyCmd": "Copy command",
    "ver.runtimeDesktop": "Desktop",
    "ver.runtimeWeb": "Web",
    "ro.turnOn": "Turn read-only on",
    "ro.turnOff": "Turn read-only off",
    "cap.tooOld": "dbhub {v} does not support read-only / SSH tunnels (1.4.0 or newer required)",
    "cap.untested": "dbhub {v} is untested (read-only / SSH were measured on 1.4.0+)",
    "add.readOnly": "Read-only mode",
    "ro.chip": "RO",
    "ro.title": "Read-only mode: dbhub only allows read statements and rejects writes (READONLY_VIOLATION)",
    "ro.sshTitle": "SSH tunnel {host}:{port} (user {user})",
    "add.adv": "Advanced: SSH tunnel",
    "adv.enable": "Connect through an SSH tunnel",
    "adv.host": "SSH host",
    "adv.port": "Port",
    "adv.user": "SSH user",
    "adv.auth": "Auth",
    "adv.auth.key": "Key",
    "adv.auth.password": "Password",
    "adv.keyPath": "Key path",
    "adv.passphrase": "Key passphrase",
    "adv.password": "SSH password",
    "adv.proxyJump": "ProxyJump (optional, single hop)",
    "adv.keepSecret": "blank = keep the stored value",
    "adv.hostHint": "Use a domain or IP (never an ~/.ssh/config alias); the database address still comes from the DSN and must be the one the bastion sees.",
    "adv.slow": "The first connection through an SSH tunnel is slow — please wait.",
    "btn.testConn": "Test this configuration",
    "btn.testSsh": "Test SSH tunnel",
    "adv.testSshHint": "Tests the SSH layer ONLY: first whether the bastion's port is reachable and the key file exists, then whether dbhub can bring the tunnel up (it deliberately aims at a port that must be closed — the database step failing is what proves the tunnel worked).",
    "adv.testSshNeedFields": "Fill in the SSH host and user first (and pick an auth method), then test the tunnel.",
    "btn.saveOpts": "Save options",
    "btn.save": "Save",
    "btn.add": "Add connection",
    "btn.addConn": "＋ Add connection",
    "btn.addEnv": "＋ Environment",
    "btn.expandAll": "Expand all",
    "btn.collapseAll": "Collapse all",
    "btn.copy": "Copy source value",
    "copy.ok": "Copied",
    "btn.edit": "Edit",
    "btn.cancel": "Cancel",
    "btn.saved": "Save",
    "btn.delete": "Delete",
    "btn.test": "Test",
    "test.testing": "testing…",
    "test.elapsed": "testing… {s}s",
    "test.timeout": "no test result (timed out)",
    "saved.ok": "Saved ✓",
    "error.write": "write failed — the host did not confirm the save",
    "test.notSent": "the test command never reached the host",
    "state.failed": "the plugin state could not be read",
    "btn.retry": "Retry",
    "cfg.badInterval": "the update interval must be a whole number of days between 0 and 365",
    "del.title": "Delete this connection?",
    "del.body": "The stored connection for environment “{env}” is deleted and there is no undo — restoring it means entering the DSN again.",
    "del.cancel": "Cancel",
    "del.confirm": "Delete",
    "badge.saved": "saved",
    "badge.auto": "auto",
    "ws.env": "env",
    "ws.source": "source",
    "ws.srcHint": "click to copy the source value the model uses to target this connection",
    "ws.autoHint": "(auto-discovered, not saved — edit and save to keep it)",
    "ws.empty": "No connections yet. Use “＋ Add connection” above, or ask the model to run dbhub_configure.",
    "ws.placeholder": "workspace path or title; blank = the current workspace",
    "env.placeholder": "e.g. prod / dev / test; default = default",
    "env.newPlaceholder": "Environment name (Chinese is fine; blank defaults to default)",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "full DSN (do not reveal the password to the model)",
    "add.ws": "Workspace",
    "add.env": "Environment",
    "add.dsn": "DSN",
    "src.user": "saved · user",
    "src.collected": "saved · scan",
    "src.copied": "saved · copied",
    "src.promoted": "saved · promoted",
    "src.mise": "auto · mise env",
    "src.env": "auto · .env",
    "pretest.title": "Validate & Save Connection",
    "pretest.checking": "Testing connection…",
    "pretest.askTest": "Test connection",
    "pretest.skip": "skip test & save",
    "pretest.saveOk": "Save",
    "pretest.cancel": "Cancel",
    "pretest.failHint": "Connection test failed — you can still save (acknowledge the issue).",
    "ovr.title": "That environment already exists — overwrite it?",
    "ovr.body": "Workspace “{ws}” already has a connection in environment “{env}”: {conn}. Saving now overwrites it — the stored credentials are replaced and this cannot be undone.",
    "ovr.bodyAmbiguous": "Environment “{env}” already exists in: {list}. A blank workspace is resolved by the plugin; if it resolves to one of those, saving overwrites the existing connection.",
    "ovr.cancel": "Cancel (rename it)",
    "ovr.confirm": "Overwrite & save",
  };

  function tForZh(key, params) {
    var s = LOCALE_ZH[key] || key;
    if (params) {
      for (var k in params) { if (Object.prototype.hasOwnProperty.call(params, k)) s = s.split("{" + k + "}").join(String(params[k])); }
    }
    return s;
  }

  /**
   * Translator over this bundle's own dictionaries. Used when the shared locale
   * service is absent, or already owns this namespace (a hot-reloaded instance
   * whose dictionaries were never released). Keeps the page fully localized
   * instead of degrading to raw keys.
   */
  function localTranslator(localeSvc) {
    return function (key, params) {
      var active = "";
      try {
        var snap = localeSvc && typeof localeSvc.getLocale === "function" ? localeSvc.getLocale() : null;
        active = snap && typeof snap.active === "string" ? snap.active : "";
      } catch (e) { /* keep the zh default */ }
      var dict = active.indexOf("en") === 0 ? LOCALE_EN : LOCALE_ZH;
      var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : (LOCALE_ZH[key] || key);
      if (params) {
        for (var k in params) { if (Object.prototype.hasOwnProperty.call(params, k)) s = s.split("{" + k + "}").join(String(params[k])); }
      }
      return s;
    };
  }

  var PHASE_META = {
    initializing: { key: "phase.initializing", emoji: "🟡" },
    running: { key: "phase.running", emoji: "🟢" },
    error: { key: "phase.error", emoji: "🔴" },
    disabled: { key: "phase.disabled", emoji: "⚪" },
  };

  var SOURCE_LABEL_ZH = {
    "persisted(user)": "src.user",
    "persisted(collected)": "src.collected",
    "persisted(copied)": "src.copied",
    // An auto-discovered row that the user (or the model) explicitly gave an
    // option to is persisted with this provenance (D10).
    "persisted(promoted)": "src.promoted",
    "工作区 mise env": "src.mise",
    "工作目录 .env": "src.env",
  };

  function valueOf(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return {};
    var value = snapshot.value;
    return value && typeof value === "object" ? value : {};
  }

  /**
   * The options draft the Host snapshot implies. Shared by the initial state,
   * the "follow the Host while nothing is edited locally" effect and the failed
   * write rollback, so the three can never disagree about what "stored" means.
   */
  function draftFromValue(value) {
    var v = value && typeof value === "object" ? value : {};
    return {
      updateIntervalDays: typeof v.updateIntervalDays === "number" ? String(v.updateIntervalDays) : "7",
      // The user's own "hide the shortcut" preference. Independent of the
      // plugin's enabled state: hiding the entry does NOT disable anything.
      showSidebarEntry: v.showSidebarEntry !== false,
      // The user's own "let the plugin announce its access policy" preference.
      // Independent of everything else: off removes one prompt section only.
      announceAccessPolicy: v.announceAccessPolicy !== false,
    };
  }

  function workspacesOf(value) {
    try {
      var parsed = JSON.parse(typeof value.workspaces === "string" ? value.workspaces : "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  // ── styles ────────────────────────────────────────────────────────────────
  //
  // One scoped stylesheet, injected once per page from `apply()`. Hover/focus
  // states need real pseudo-classes (an inline style cannot express them), and
  // a single sheet keeps the density rules in one place.
  //
  // Theme contract: every colour comes from a `--dsw-alias-*` token, and the
  // fallbacks are deliberately NEUTRAL AND TRANSLUCENT (rgba greys / transparent)
  // — never opaque whites or brand colours. A theme plugin (or a translucent
  // skin) may redefine the tokens or leave some undefined; in that case surfaces
  // must inherit/keep the page background instead of painting a hard block, and
  // borders must stay visible. Never write an opaque literal colour here.

  var STYLE_ID = "dsh-dbhub-live-style";

  // Client-side watchdogs for a connection probe. The Host answers every probe
  // (success, failure, or its own timeout), so these only cover "the report
  // never arrived". The tunnelled tier is longer because SSH setup is slow; the
  // HOST budget (adhoc.mjs PROBE_TIMEOUT_MS / PROBE_TIMEOUT_SSH_MS) stays
  // strictly below its client counterpart — asserted in test/adhoc-toml.test.mjs.
  var PRETEST_WATCHDOG_MS = 30000;
  var PRETEST_WATCHDOG_SSH_MS = 60000;
  var TEST_WATCHDOG_MS = 30000;
  var TEST_WATCHDOG_SSH_MS = 60000;

  // Ceiling for ONE bridge write (POST /enabled, /options, /op). A hung bridge
  // (a proxy that accepts the connection and never answers, a dead tunnel) left
  // every write pending FOREVER: no tick, no error, no retry — the click simply
  // vanished. This is deliberately LONGER than every probe watchdog above,
  // because a `{op:'test'}` POST may legitimately spend a full SSH budget before
  // it answers: the write ceiling must never fire on a healthy slow probe. It
  // adds no new semantics — a timeout is just the failure it already renders
  // (localized `error.write`, draft rollback, no tick); the Host may still have
  // applied the write, and the next read shows the truth.
  var WRITE_TIMEOUT_MS = 90000;

  // Probe/report nonces. `Date.now()` alone collides for two clicks in the same
  // millisecond, and two probes sharing a nonce means one report answers the
  // other request (the row silently keeps "testing…").
  var nonceCounter = 0;
  function uniqueNonceId() {
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (e) { /* an old browser: fall through to the counter */ }
    nonceCounter += 1;
    return "n" + nonceCounter + "-" + Date.now();
  }

  var CSS_TEXT = [
    ".dbh-wrap{box-sizing:border-box;height:100%;width:100%;overflow:auto;padding:22px clamp(14px,3vw,32px) 44px;color:var(--dsw-alias-label-primary);font-family:inherit;}",
    // Content column: capped at 960px, which also caps the tile grid at 3 columns.
    ".dbh-inner{display:flex;flex-direction:column;gap:10px;width:100%;max-width:960px;margin:0 auto;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);font-family:inherit;}",
    ".dbh-error{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-all;max-height:54px;overflow:auto;}",
    // Toolbar buttons (rarer, text-labelled): quiet surface + border.
    ".dbh-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;font-size:12px;font-family:inherit;line-height:1;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .14s,border-color .14s,color .14s;white-space:nowrap;}",
    ".dbh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6));}",
    ".dbh-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-btn:disabled{opacity:.55;cursor:default;}",
    ".dbh-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}",
    ".dbh-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);}",
    ".dbh-btn-danger{color:var(--dsw-alias-state-error-primary);}",
    ".dbh-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}",
    // Row actions: bare 24px icon buttons — no border, no label, no width cost.
    ".dbh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;flex:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .14s,color .14s;}",
    ".dbh-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
    ".dbh-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-iconbtn:disabled{cursor:default;}",
    ".dbh-iconbtn-busy{opacity:.5;}",
    ".dbh-iconbtn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);}",
    ".dbh-sect{display:flex;align-items:center;gap:8px;padding:14px 0 2px;flex-wrap:wrap;}",
    ".dbh-secttitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.01em;}",
    ".dbh-sectcount{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
    ".dbh-grow{flex:1;min-width:0;}",
    // Level 1: one bordered card per workspace. Transparent surface + hairline
    // border + a whisper of shadow = layering that survives any theme.
    ".dbh-group{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;background:transparent;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05);}",
    ".dbh-groupheadwrap{display:flex;align-items:center;gap:8px;padding-right:8px;}",
    ".dbh-grouphead{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:8px 10px 8px 12px;border:0;background:transparent;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;}",
    ".dbh-grouphead:hover{background:var(--dsw-alias-interactive-bg-hover);}",
    ".dbh-grouphead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}",
    ".dbh-grouptitle{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-groupmeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".dbh-chev{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s;}",
    ".dbh-chev.open{transform:rotate(180deg);}",
    // Level 2: the environment list is indented behind a guide rule, so a group
    // head and its environment rows can never read as the same kind of row.
    ".dbh-groupbody{margin:0 8px 8px 14px;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));}",
    ".dbh-envwrap{padding:1px 0;}",
    ".dbh-envwrap+.dbh-envwrap{border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.3));}",
    ".dbh-envrow{display:flex;align-items:center;gap:8px;min-height:30px;flex-wrap:wrap;}",
    // Environment name: deliberately narrow and light — the database name is the
    // strongest text on the row, the environment is just its qualifier.
    ".dbh-envname{flex:none;max-width:96px;font-size:11px;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    // Connection metadata: the host/port prefix absorbs truncation, the database
    // name never does.
    ".dbh-conn{display:flex;align-items:baseline;flex:1 1 auto;min-width:80px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;}",
    ".dbh-conn-pre{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);}",
    ".dbh-conn-db{flex:none;color:var(--dsw-alias-label-primary);font-weight:600;}",
    ".dbh-acts{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto;}",
    ".dbh-svgicon{display:block;flex:none;pointer-events:none;}",
    // The source handle: dashed outline + copy glyph says "id, click to copy".
    ".dbh-src{display:inline-flex;align-items:center;gap:4px;flex:none;height:22px;padding:0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;cursor:pointer;transition:background .14s,border-color .14s,color .14s;}",
    ".dbh-src:hover{background:var(--dsw-alias-interactive-bg-hover);border-style:solid;color:var(--dsw-alias-label-primary);}",
    ".dbh-src:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-src-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);border-style:solid;}",
    ".dbh-srcid{max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-editrow{display:flex;align-items:center;gap:6px;padding:4px 0 6px;flex-wrap:wrap;}",
    // Editor block: the input row plus its advanced (SSH) section, so the row
    // still contributes exactly ONE sibling to the environment wrapper.
    ".dbh-editbox{display:flex;flex-direction:column;gap:6px;padding:4px 0 6px;}",
    // Read-only marker inside the environment chip: an attribute that differs
    // per row and CHANGES the semantics of every query, so it must be visible
    // at a glance (the origin/source is the opposite case and stays a tooltip).
    ".dbh-ro{flex:none;margin-left:4px;font-size:10px;font-weight:500;color:var(--dsw-alias-state-warn-primary);}",
    // Checkboxes are styled by the platform's own input rendering; only the
    // accent colour is themed, and the neutral fallback is a translucent grey.
    ".dbh-checkbox{flex:none;accent-color:var(--dsw-alias-brand-primary,rgba(127,127,127,.8));}",
    ".dbh-adv{display:flex;flex-direction:column;gap:6px;}",
    ".dbh-advtoggle{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;font-size:12px;font-family:inherit;line-height:1;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
    ".dbh-advtoggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
    ".dbh-advtoggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-advbody{display:flex;flex-direction:column;gap:6px;margin-left:6px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));}",
    ".dbh-advrow{display:flex;align-items:center;gap:8px;}",
    ".dbh-advlabel{flex:0 0 92px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
    ".dbh-advrow .dbh-input{flex:1;}",
    ".dbh-input{box-sizing:border-box;height:28px;min-width:0;padding:0 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;}",
    ".dbh-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}",
    ".dbh-envinput{flex:0 0 130px;}",
    ".dbh-field .dbh-input{flex:1;}",
    // Tiles: auto-fill inside the 960px column ⇒ at most 3 columns, and it
    // degrades to 2 and then 1 on narrower panel columns without overflow.
    ".dbh-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;}",
    ".dbh-tile{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;background:transparent;box-shadow:0 1px 2px rgba(0,0,0,.05);}",
    ".dbh-tile:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45));}",
    ".dbh-tilehead{display:flex;align-items:center;gap:6px;}",
    ".dbh-tiletitle{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-tilemeta{display:flex;align-items:center;gap:6px;min-width:0;}",
    ".dbh-tileacts{display:flex;justify-content:flex-end;}",
    ".dbh-addpanel{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent);}",
    ".dbh-field{display:flex;align-items:center;gap:8px;}",
    ".dbh-label{flex:0 0 64px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
    ".dbh-target{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-addfoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;}",
    ".dbh-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
    ".dbh-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;}",
    ".dbh-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;}",
    ".dbh-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:8px 0;}",
    ".dbh-saved{font-size:12px;color:var(--dsw-alias-state-success-primary);}",
    ".dbh-test-ok{font-size:12px;color:var(--dsw-alias-state-success-primary);word-break:break-word;white-space:pre-wrap;}",
    ".dbh-test-fail{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word;white-space:pre-wrap;}",
    ".dbh-pretest{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);}",
    ".dbh-pretest-title{font-weight:600;font-size:13px;color:var(--dsw-alias-state-error-primary);}",
    // Overwrite confirmation: a warning, not an error — the write is still the
    // user's to make, they just have to make it knowingly.
    ".dbh-warncard{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-state-warn-primary,rgba(127,127,127,.6));border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);}",
    ".dbh-warncard-title{font-weight:600;font-size:13px;color:var(--dsw-alias-state-warn-primary);}",
    ".dbh-summary{font-size:12px;color:var(--dsw-alias-label-secondary);}",
    // ── layout surfaces (dialog / wide page / phone) ────────────────────────
    // One component, three surfaces: the settings dialog (narrow, unchanged from
    // the 0.1.x layout), the wide page reached from the left menu / the Plugins
    // row, and a phone browser. The page classes come from the MEASURED
    // container width, so a docked desktop window degrades like a phone does.
    ".dbh-titlebar{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:2px 0 2px;}",
    ".dbh-title{margin:0;font-size:18px;font-weight:600;line-height:1.25;color:var(--dsw-alias-label-primary);}",
    ".dbh-ver{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}",
    // Update affordance: a quiet text link (brand colour only) that expands into a
    // neutral panel on demand — never a red/error-styled banner.
    ".dbh-updatelink{display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 4px;font-size:12px;font-family:inherit;line-height:1;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-brand-text);cursor:pointer;}",
    ".dbh-updatelink:hover{text-decoration:underline;}",
    ".dbh-updatelink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-vercheck{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;font-size:11px;font-family:inherit;line-height:1;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}",
    ".dbh-vercheck:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
    ".dbh-vercheck:disabled{cursor:default;opacity:.7;}",
    ".dbh-vercheck:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    // One status line: running/disabled + how many connections. Tool count and the
    // one-shot execution mode are implementation facts and live in the notes.
    ".dbh-statusline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:0 0 6px;}",
    ".dbh-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);}",
    ".dbh-dot-off{background:var(--dsw-alias-state-idle-primary);}",
    ".dbh-statussep{color:var(--dsw-alias-label-tertiary);}",
    ".dbh-linkbtn{display:inline-flex;align-items:center;gap:3px;padding:0 4px;height:20px;border:1px solid transparent;border-radius:6px;background:transparent;font-family:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;}",
    ".dbh-linkbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
    ".dbh-linkbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-updatepanel{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);}",
    ".dbh-updaterow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}",
    ".dbh-spec{flex:1 1 auto;min-width:0;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-link{font-size:11px;color:var(--dsw-alias-brand-text);text-decoration:none;align-self:flex-start;}",
    ".dbh-link:hover{text-decoration:underline;}",
    // Settings: the harness's own row pattern — title left, control right, thin
    // separators, no card/grid, no coloured chrome of our own.
    ".dbh-inner.dbh-wide{max-width:1320px;gap:12px;}",
    ".dbh-wide .dbh-tiles{grid-template-columns:repeat(auto-fill,minmax(320px,1fr));}",
    ".dbh-settings{display:flex;flex-direction:column;}",
    ".dbh-settings-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;padding:2px 0 2px;}",
    // Wide page: all four controls on one quiet line — the labels stay attached
    // to their switches instead of a label at the far left and a control at the
    // far right with half a screen of empty middle.
    ".dbh-settingsbar{padding:0 0 2px;}",
    ".dbh-barline{display:flex;align-items:center;gap:8px 22px;flex-wrap:wrap;padding:2px 0 4px;}",
    ".dbh-bartitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;margin-right:2px;}",
    ".dbh-bargroup{display:inline-flex;align-items:center;gap:6px;flex:none;}",
    ".dbh-barlabel{font-size:12px;color:var(--dsw-alias-label-secondary);}",
    ".dbh-barstate{font-size:12px;color:var(--dsw-alias-label-tertiary);}",
    ".dbh-settingsbar [role=\"switch\"]{transform:scale(.85);}",
    // Narrow desktop column: drop the section title and the state words, tighten
    // the gaps, so the four controls still flow on one/two lines instead of
    // collapsing into a vertical list.
    ".dbh-barnarrow .dbh-barline{gap:6px 12px;}",
    ".dbh-barnarrow .dbh-bartitle{display:none;}",
    ".dbh-barnarrow .dbh-barstate{display:none;}",
    ".dbh-barnarrow .dbh-barlabel{font-size:11px;}",
    ".dbh-barnarrow .dbh-srow-input{width:50px;}",
    // Narrow surfaces: the same controls as compact rows (weak by design — the
    // connection list below is the main content).
    ".dbh-srow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));}",
    ".dbh-srow:last-child{border-bottom:none;}",
    ".dbh-srow-main{min-width:0;}",
    ".dbh-srow-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
    ".dbh-srow-ctl{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:nowrap;}",
    ".dbh-srow-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:2.4em;text-align:right;white-space:nowrap;}",
    ".dbh-srow-input{width:58px;height:26px;flex:none;text-align:center;}",
    ".dbh-srow-unit{font-size:12px;color:var(--dsw-alias-label-secondary);}",
    ".dbh-btn-sm{height:26px;padding:0 10px;font-size:12px;}",
    ".dbh-settings-foot{display:flex;align-items:center;gap:8px;padding:6px 0 2px;}",
    ".dbh-notes{display:flex;flex-direction:column;gap:4px;margin:2px 0 4px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);}",
    // Read-only toggle: a quiet chip on the connection row, in EVERY layout, so it
    // can be flipped while reading the list instead of opening the edit form.
    ".dbh-rochip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;flex:none;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:inherit;line-height:1;cursor:pointer;transition:background .12s,border-color .12s,color .12s;}",
    ".dbh-rochip:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6));color:var(--dsw-alias-label-secondary);}",
    ".dbh-rochip-on{border-style:solid;border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);}",
    ".dbh-rochip:disabled{opacity:.55;cursor:default;}",
    ".dbh-rochip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-roemoji{font-size:13px;line-height:1;}",
    // Fallback switch only when the baseline predates the Switch primitive: same
    // 36x20 geometry and token colours as the platform control.
    ".dbh-fbswitch{position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.45));cursor:pointer;transition:background .12s;}",
    ".dbh-fbswitch-on{background:var(--dsw-alias-brand-primary);}",
    ".dbh-fbswitch:disabled{opacity:.5;cursor:default;}",
    ".dbh-fbswitch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}",
    ".dbh-fbswitch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease;}",
    ".dbh-fbswitch-on .dbh-fbswitch-thumb{transform:translateX(16px);}",
    // Phone browser: one column, touch-sized controls, actions on their own row.
    ".dbh-inner.dbh-mobile{font-size:13px;gap:8px;}",
    ".dbh-mobile .dbh-titlebar{gap:6px;}",
    ".dbh-mobile .dbh-title{font-size:16px;}",
    ".dbh-mobile .dbh-statusline{font-size:12px;}",
    ".dbh-mobile .dbh-updatepanel{padding:8px 10px;}",
    ".dbh-mobile .dbh-envrow{gap:6px;}",
    ".dbh-mobile .dbh-envname{max-width:120px;}",
    ".dbh-mobile .dbh-conn{flex:1 1 100%;order:1;min-width:0;}",
    ".dbh-mobile .dbh-rochip{height:24px;padding:0 8px;order:2;}",
    ".dbh-mobile .dbh-roemoji{font-size:14px;}",
    ".dbh-mobile .dbh-acts{order:3;width:100%;margin-left:0;justify-content:flex-end;gap:6px;padding:2px 0 0;}",
    ".dbh-mobile .dbh-iconbtn{width:32px;height:32px;}",
    ".dbh-mobile .dbh-btn{height:30px;padding:0 12px;}",
    ".dbh-mobile .dbh-tiles{grid-template-columns:1fr;}",
    ".dbh-mobile .dbh-srow{gap:8px;padding:6px 0;}",
    ".dbh-mobile .dbh-srow-title{font-size:12px;}",
    ".dbh-mobile .dbh-srow-state{font-size:11px;min-width:2.2em;}",
    ".dbh-mobile .dbh-srow [role=\"switch\"]{transform:scale(.8);}",
    ".dbh-mobile .dbh-btn-sm{height:24px;padding:0 8px;font-size:11px;}",
    ".dbh-mobile .dbh-groupbody{margin:0 4px 6px 8px;padding-left:8px;}",
    ".dbh-mobile .dbh-editrow .dbh-envinput{flex:1 1 100%;}",
    ".dbh-mobile .dbh-editrow .dbh-input{flex:1 1 100%;}",
    ".dbh-mobile .dbh-srcid{max-width:72px;}",
    ".dbh-mobile .dbh-updatehead{align-items:flex-start;}",
  ].join("");

  function ensureStyle() {
    if (typeof document === "undefined" || !document.head || !document.createElement) return;
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS_TEXT;
    document.head.appendChild(el);
  }

  // ── the settings page (this plugin's own section) ────────────────────────

  // A database-cylinder glyph drawn inline: the sidebar owns the button, the
  // label and the selected state, and an inline SVG cannot break when a
  // primitive icon is renamed between dsh versions.
  function PanelIcon(props) {
    var size = props && typeof props.size === "number" ? props.size : 16;
    return react.createElement("svg", {
      width: size, height: size, viewBox: "0 0 16 16",
      fill: "none", stroke: "currentColor", strokeWidth: "1.2",
      strokeLinecap: "round", "aria-hidden": true,
      style: { display: "block" },
    },
      react.createElement("ellipse", { cx: "8", cy: "3.7", rx: "5", ry: "2.1" }),
      react.createElement("path", { d: "M3 3.7v8.6c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V3.7" }),
      react.createElement("path", { d: "M3 8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1" }));
  }

  // The settings section's page (also the sidebar panel's body): the same
  // management page the Plugins page renders in its 'page' view, wrapped in its
  // own scroll container. The Plugins-row mount keeps the shell's container.
  // `surface` names the MOUNT, not the width: the settings dialog is a 760px
  // modal, the left-menu entry and the Plugins row are full pages, and the
  // card itself still measures its column before choosing a layout.
  function ConfigPanel(props) {
    ensureStyle();
    var surface = props && typeof props.surface === "string" ? props.surface : "modal";
    return h("div", { className: "dbh-wrap" },
      h(StatusCard, Object.assign({}, props, { view: "page", surface: surface })));
  }

  /** Settings -> DBHub dialog (narrow, unchanged density). */
  function SettingsSectionPanel(props) {
    return h(ConfigPanel, Object.assign({}, props, { surface: "modal" }));
  }

  /** Left-menu DBHub panel: a full page with most of the viewport available. */
  function MainPanel(props) {
    return h(ConfigPanel, Object.assign({}, props, { surface: "main" }));
  }

  // ── pure layout helpers ───────────────────────────────────────────────────

  /**
   * Group the flat workspace×environment rows by workspace PATH. A title is not
   * identity (two workspaces may share one, and look-alike connections in
   * different workspaces are different targets); rows whose titles collide are
   * marked `dup` so the view can disambiguate them with the path.
   * @returns [{ key, title, path, envs, saved, dup }]
   */
  function groupRows(rows) {
    var order = [];
    var byKey = {};
    var titleCount = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var key = String(r.path || r.title || "");
      var g = byKey[key];
      if (!g) {
        g = { key: key, title: String(r.title || ""), path: String(r.path || ""), envs: [], saved: 0, dup: false };
        byKey[key] = g;
        order.push(g);
        titleCount[g.title] = (titleCount[g.title] || 0) + 1;
      }
      g.envs.push(r);
      if (r.persisted) g.saved++;
    }
    for (var j = 0; j < order.length; j++) order[j].dup = titleCount[order[j].title] > 1;
    return order;
  }

  /**
   * Layout decision, deliberately threshold-free: when every workspace carries
   * exactly one environment the flat tile grid is strictly better (nothing is
   * hidden, nothing has to be expanded); as soon as one workspace has several
   * environments the rows fold per workspace instead.
   * @returns 'empty' | 'tiled' | 'grouped'
   */
  function layoutModeOf(groups) {
    if (!groups || groups.length === 0) return "empty";
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].envs.length > 1) return "grouped";
    }
    return "tiled";
  }

  /**
   * Split a connection metadata label (`type://host:port/db`) so the half a
   * person actually reads — the database name — can stay visible while the
   * host/port prefix absorbs whatever truncation the column forces.
   * @returns `{ prefix, tail }` (tail empty when the label has no such shape)
   */
  function splitConn(conn) {
    var text = String(conn || "");
    var m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*\/)(.+)$/i.exec(text);
    if (m) return { prefix: m[1], tail: m[2] };
    return { prefix: text, tail: "" };
  }

  /**
   * Short display form of a source handle (`<slug>_<wsHash>[_<envSlug>]`). Short
   * handles are shown whole; long ones keep the two segments that tell look-alike
   * handles apart — the workspace hash plus the environment suffix — because
   * that is the part a person compares (the full handle rides the tooltip).
   */
  function shortHandle(id) {
    var text = String(id || "");
    if (text.length <= 14) return text;
    var parts = text.split("_");
    var tail = parts.length >= 3 ? parts.slice(-2).join("_") : (parts.length === 2 ? parts[1] : text.slice(-8));
    if (tail.length > 14) tail = tail.slice(-14);
    return "…" + tail;
  }

  /** Separator/ case-insensitive path comparison (Windows and POSIX spellings). */
  function samePath(a, b) {
    var norm = function (p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); };
    var x = norm(a);
    return !!x && x === norm(b);
  }

  /** Length cap mirrored from the Host's `normalizeEnvName` (an env name is a store key). */
  var ENV_NAME_MAX = 64;

  /**
   * Env-name normalization mirrored from the Host (`config.mjs`
   * `normalizeEnvName`): control characters dropped, trimmed, blank collapsing
   * to `default`, capped. The page must compare the name the Host will actually
   * store, not the raw text the user typed.
   */
  function normalizeEnvForCompare(name) {
    var raw = String(name === undefined || name === null ? "" : name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return raw ? raw.slice(0, ENV_NAME_MAX) : "default";
  }

  /**
   * Would this write land on an environment that already holds a connection?
   * The page only sees MIRRORED rows, so:
   *   · an explicit workspace (path or title) decides it exactly — rows of other
   *     workspaces never collide, because each source belongs to one workspace;
   *   · a blank workspace means "the Host picks": its resolver falls back to the
   *     FIRST registered workspace, whose first mirrored row is the closest proxy
   *     available. When the env exists only elsewhere the caller receives
   *     `confident: false` and warns instead of asserting.
   * @returns `{ rows, confident }`, or null when nothing would be overwritten
   */
  function envCollision(rows, wsRef, envName) {
    var env = normalizeEnvForCompare(envName);
    var wanted = String(wsRef === undefined || wsRef === null ? "" : wsRef).trim();
    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      if (normalizeEnvForCompare(r.env) === env) hits.push(r);
    }
    if (hits.length === 0) return null;
    if (wanted) {
      var exact = [];
      for (var j = 0; j < hits.length; j++) {
        var title = String(hits[j].title || "").trim().toLowerCase();
        if (samePath(hits[j].path, wanted) || (title && title === wanted.toLowerCase())) exact.push(hits[j]);
      }
      return exact.length ? { rows: exact, confident: true } : null;
    }
    var firstPath = rows.length > 0 ? String(rows[0].path || "") : "";
    var guess = [];
    for (var k = 0; k < hits.length; k++) {
      if (firstPath && samePath(hits[k].path, firstPath)) guess.push(hits[k]);
    }
    return guess.length ? { rows: guess, confident: true } : { rows: hits, confident: false };
  }

  /**
   * The workspace the user worked in most recently, read from the Workspace
   * snapshot the section owner supplies as a standard prop. The settings panel
   * is global — no "current session" is exposed to it — so the most recently
   * updated workspace is the closest available equivalent.
   * @returns '' when the hook is absent (Plugins-row / sidebar mounts).
   */
  function recentWorkspacePath(snapshot) {
    try {
      var items = snapshot && snapshot.items ? snapshot.items : [];
      var best = "";
      var bestAt = "";
      for (var i = 0; i < items.length; i++) {
        var at = String((items[i] && items[i].updatedAt) || "");
        if (at && at >= bestAt) { bestAt = at; best = String((items[i] && items[i].path) || ""); }
      }
      return best;
    } catch (e) {
      return "";
    }
  }

  /** Badge text: where the connection came from, localized. */
  function sourceLabelOf(w, t) {
    var key = SOURCE_LABEL_ZH[w && w.source];
    if (key) return t(key);
    if (w && w.source) return String(w.source);
    return t(w && w.persisted ? "badge.saved" : "badge.auto");
  }

  // Expanded groups / add panel / settings strip survive a remount inside the
  // same page session (switching settings sections, opening the sidebar panel)
  // and reset on reload. Deliberately not persisted anywhere: it is view state,
  // not configuration.
  var uiMemory = { expanded: {}, addOpen: false, addTarget: "", settingsOpen: false, advOpen: false };

  /**
   * Upstream dbhub capabilities, published by the Host as a JSON string.
   * `''` (the probe has not finished) means "assume supported": the controls stay
   * usable and a genuine incompatibility surfaces as a dbhub error, whereas
   * disabling them on a guess would block a working setup.
   */
  function capsOf(value) {
    var raw = value && typeof value.capabilities === "string" ? value.capabilities : "";
    if (!raw) return { version: "", readonlyTools: true, ssh: true, warning: "" };
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { version: "", readonlyTools: true, ssh: true, warning: "" };
      return {
        version: typeof parsed.version === "string" ? parsed.version : "",
        readonlyTools: parsed.readonlyTools !== false,
        ssh: parsed.ssh !== false,
        warning: typeof parsed.warning === "string" ? parsed.warning : "",
      };
    } catch (e) {
      return { version: "", readonlyTools: true, ssh: true, warning: "" };
    }
  }

  /** Localized one-line explanation of a capability warning ('' when fine). */
  function capabilityHint(caps, t) {
    if (!caps || !caps.warning) return "";
    if (caps.warning === "tooOld") return t("cap.tooOld", { v: caps.version || "?" });
    if (caps.warning === "untested") return t("cap.untested", { v: caps.version || "?" });
    return "";
  }

  /**
   * Build the option half of a write payload from one form draft.
   *
   * Secrets follow the "blank = keep the stored value" rule: an empty password /
   * passphrase / key path is simply OMITTED, and the Host merges it with what is
   * already stored (a user must never have to re-type a password to flip the
   * read-only checkbox). `sshOn === false` is the explicit "no tunnel" signal and
   * must survive as a defined `null` — otherwise it would read as "unchanged".
   *
   * @returns `{ readOnly, ssh? , sshOff? }` (spread into a configOp payload).
   */
  function connDraftOf(form) {
    var f = form || {};
    var out = { readOnly: f.ro === true };
    var host = String(f.sshHost || "").trim();
    var user = String(f.sshUser || "").trim();
    var keyPath = String(f.sshKeyPath || "").trim();
    var password = String(f.sshPassword || "");
    var passphrase = String(f.sshPassphrase || "");
    var requested = !!host || !!user || !!keyPath || !!password || f.sshOn === true;
    if (f.sshOn !== true) {
      if (requested === false) return out;
      out.ssh = null;
      return out;
    }
    var auth = f.sshAuthKind === "password" ? "password" : "key";
    var ssh = {
      host: host,
      port: String(f.sshPort || "").trim(),
      user: user,
      auth: auth,
      proxyJump: String(f.sshProxyJump || "").trim(),
    };
    if (auth === "password") {
      if (password) ssh.password = password;
    } else {
      if (keyPath) ssh.keyPath = keyPath;
      if (passphrase) ssh.passphrase = passphrase;
    }
    out.ssh = ssh;
    return out;
  }

  /** The option draft behind a write form: forms built for a write carry the
   *  originating form under `_draft`, editing forms ARE the draft. */
  function draftOf(form) {
    return form && form._draft ? form._draft : form;
  }

  /** Spread `connDraftOf` into one configOp payload. */
  function withConnDraft(op, form) {
    var d = connDraftOf(draftOf(form));
    op.readOnly = d.readOnly === true;
    if (d.ssh === null) op.ssh = null;
    else if (d.ssh) op.ssh = d.ssh;
    return op;
  }

  /** Empty draft fields for the advanced (SSH) section. */
  function sshDraftOf(row) {
    var ssh = row && row.ssh && typeof row.ssh === "object" ? row.ssh : null;
    return {
      sshOn: !!ssh,
      sshHost: ssh ? String(ssh.host || "") : "",
      sshPort: ssh && ssh.port ? String(ssh.port) : "",
      sshUser: ssh ? String(ssh.user || "") : "",
      sshAuthKind: ssh && ssh.authKind === "password" ? "password" : "key",
      sshKeyPath: "",
      sshPassword: "",
      sshPassphrase: "",
      sshProxyJump: ssh ? String(ssh.proxyJump || "") : "",
    };
  }

  /**
   * Parse the Host's transient update snapshot (a JSON string). Always returns
   * the full shape so render code never has to guard field by field.
   * @returns `{ latest, latestSpec, hasUpdate, checkedAt, source, error }`
   */
  function parseUpdate(value) {
    var out = { latest: "", latestSpec: "", hasUpdate: false, checkedAt: 0, source: "", error: "" };
    var raw = value && typeof value.update === "string" ? value.update : "";
    if (!raw) return out;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return out;
      out.latest = typeof parsed.latest === "string" ? parsed.latest.trim() : "";
      out.latestSpec = typeof parsed.latestSpec === "string" && parsed.latestSpec
        ? parsed.latestSpec
        : (out.latest ? "dsh-dbhub-live@" + out.latest : "");
      out.hasUpdate = parsed.hasUpdate === true && !!out.latest;
      out.checkedAt = typeof parsed.checkedAt === "number" && parsed.checkedAt > 0 ? parsed.checkedAt : 0;
      out.source = typeof parsed.source === "string" ? parsed.source : "";
      out.error = typeof parsed.error === "string" ? parsed.error : "";
    } catch (e) {
      /* a malformed snapshot is simply "no update information" */
    }
    return out;
  }

  /**
   * Measured width of the page's own content column. The same component serves a
   * 500px settings dialog, a full page and a phone browser, so the layout is
   * decided by how much room it actually has.
   *
   * The observer is attached by the CALLBACK REF (this factory), never by an
   * effect that reads `ref.current`: such an effect ran once with an empty
   * dependency list and never re-armed, so a column that attached after the first
   * commit (a surface switch, a remount, a deferred mount) left the width at 0 for
   * the rest of the mount and the layout silently fell back to `window.innerWidth`.
   * A ResizeObserver is absent in older browsers and in the offscreen render gate;
   * then nothing is attached and the caller falls back to the viewport.
   *
   * No timer and no interval: the observer lives exactly as long as the node.
   * `state` = `{ innerRef, observerRef, setWidth }`.
   */
  function attachMeasuredWidth(state) {
    var innerRef = state.innerRef;
    var observerRef = state.observerRef;
    var setWidth = state.setWidth;
    return function (node) {
      // Same node twice is a no-op: re-subscribing on every commit would churn
      // the observer (and, in the offscreen render gate, never settle).
      if (innerRef.current === node) return;
      innerRef.current = node;
      if (observerRef.current) {
        try { observerRef.current.disconnect(); } catch (e) { /* disposal must never throw */ }
        observerRef.current = null;
      }
      if (!node || typeof ResizeObserver !== "function") return;
      var observer = new ResizeObserver(function (entries) {
        var entry = entries && entries[0];
        var w = entry && entry.contentRect ? entry.contentRect.width : 0;
        if (w > 0) setWidth(Math.round(w));
      });
      try {
        observer.observe(node);
      } catch (e) {
        return;
      }
      observerRef.current = observer;
    };
  }

  /**
   * The 显示/隐藏 style switch used by the settings surfaces. A native checkbox
   * stays in the DOM (keyboard + screen-reader semantics, and the offscreen gate
   * can drive it); the track/knob are decoration.
   */
  function switchControl(opts) {
    var o = opts || {};
    var label = o.ariaLabel || o.label || "";
    if (SwitchPrimitive) {
      return h(SwitchPrimitive, {
        checked: o.checked === true,
        onChange: function (next) { if (typeof o.onChange === "function") o.onChange(next); },
        label: label,
        disabled: o.disabled === true,
        title: o.title || "",
        className: o.className,
        key: o.key,
      });
    }
    // Fallback with the same 36x20 geometry and token colours as the primitive.
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": o.checked === true,
      "aria-label": label,
      title: o.title || "",
      disabled: o.disabled === true,
      className: "dbh-fbswitch" + (o.checked === true ? " dbh-fbswitch-on" : "") + (o.className ? " " + o.className : ""),
      key: o.key,
      onClick: function () { if (typeof o.onChange === "function") o.onChange(o.checked !== true); },
    }, h("span", { className: "dbh-fbswitch-thumb" }));
  }

  // ── the page ──────────────────────────────────────────────────────────────

  function StatusCard(props) {
    ensureStyle();
    var loaded = react.useState(function () { return valueOf(props.getSnapshot()); });
    var value = loaded[0];
    var setValue = loaded[1];

    react.useEffect(function () {
      // `live: true` asks the HTTP face to keep the view fresh while the page is
      // mounted; the plugin's own sidebar-sync subscription does not, so a
      // closed panel costs no polling.
      return props.subscribe(function () { setValue(valueOf(props.getSnapshot())); }, { live: true });
    }, []);

    // The face reports `{ status, value }`. `status === 'error'` means the last
    // read did not come back, so `value` may be empty or old — the card used to
    // ignore it and simply render nothing, with no way back. It is read off the
    // face at render time (the face is the only holder of that flag) and every
    // publish re-renders the card; the error publish carries a fresh value
    // object for exactly that reason (React bails out on an identical ref).
    var faceSnap = null;
    try { faceSnap = typeof props.getSnapshot === "function" ? props.getSnapshot() : null; } catch (e) { faceSnap = null; }
    var snapshotFailed = !!(faceSnap && typeof faceSnap === "object" && faceSnap.status === "error");

    // The plugins page asks every configuration entry for two views: `summary`
    // is the one-liner under the plugin title, `page` is the whole management
    // page. BOTH views run through EVERY hook below and the one-liner is chosen
    // at the return: returning here made `summary` consume two hooks and `page`
    // thirty, so a mounted instance switching views threw
    // "Rendered more hooks than during the previous render".
    var isPage = props.view !== "summary";
    var t = props.t || tForZh;
    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "running") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    // A refused card command (unknown workspace, an empty DSN, a rename that
    // would overwrite another environment, an incomplete tunnel). The Host
    // publishes one transient line per command — '' once it succeeds — because
    // the browser half does not read op response bodies: without this a refused
    // click looked exactly like a saved one.
    var opNotice = "";
    try {
      var noticeJson = typeof value.opNotice === "string" ? value.opNotice : "";
      if (noticeJson) {
        var noticeValue = JSON.parse(noticeJson);
        if (noticeValue && typeof noticeValue.message === "string") opNotice = noticeValue.message;
      }
    } catch (e) { opNotice = ""; }
    var workspaces = workspacesOf(value);
    var caps = capsOf(value);
    var capHint = capabilityHint(caps, t);
    var roSupported = caps.readonlyTools !== false;
    var sshSupported = caps.ssh !== false;
    var savedCount = workspaces.filter(function (w) { return w.persisted; }).length;
    var groups = groupRows(workspaces);
    var layout = layoutModeOf(groups);

    var surface = props.surface === "main" || props.surface === "modal" || props.surface === "page"
      ? props.surface
      : "page";
    var pluginVersion = typeof value.pluginVersion === "string" ? String(value.pluginVersion).trim() : "";
    var dshVersion = typeof value.dshVersion === "string" ? String(value.dshVersion).trim() : "";
    var dshMinVersion = typeof value.dshMinVersion === "string" ? String(value.dshMinVersion).trim() : "";
    // The Host decided this from the RUNNING dsh version (lib/meta.mjs). It is a
    // visible WARNING, not a gate: every tool and every control keeps working, so
    // an old host gets a full page plus one honest sentence — never a blank card.
    var dshTooOld = value.dshTooOld === true;
    var runtime = value.runtime === "desktop" ? "desktop" : value.runtime === "web" ? "web" : "";
    var update = parseUpdate(value);

    var summaryNode = h("span", { className: "dbh-summary" },
      meta.emoji + " " + t(meta.key) + " · " + t("tools.fixed", { n: String(toolCount) }) + " · "
      + (workspaces.length > 0
        ? t("desc.environments", { n: String(workspaces.length), m: String(savedCount) })
        : t("desc.unconfigured"))
      + (dshTooOld ? " · " + t("dsh.tooOldShort", { min: dshMinVersion }) : ""));
    var innerRef = react.useRef(null);
    // The measured column: ONE callback-ref identity per mount, publishing the
    // width through state (`attachMeasuredWidth` owns the observer). `useCallback`
    // is not part of the baseline react surface this bundle may require, so the
    // identity is frozen in a ref — a fresh function each render would make React
    // detach and re-attach the node on every pass.
    var widthState = react.useState(0);
    var measuredWidth = widthState[0];
    var setMeasuredWidth = widthState[1];
    var widthObserver = react.useRef(null);
    var widthCbRef = react.useRef(null);
    if (!widthCbRef.current) {
      widthCbRef.current = attachMeasuredWidth({
        innerRef: innerRef, observerRef: widthObserver, setWidth: setMeasuredWidth,
      });
    }
    var innerRefCb = widthCbRef.current;
    // Unmount teardown: the callback ref cannot run once the tree is gone, so the
    // observer would otherwise outlive the page (a leaked listener).
    react.useEffect(function () {
      return function () {
        if (!widthObserver.current) return;
        try { widthObserver.current.disconnect(); } catch (e) { /* disposal must never throw */ }
        widthObserver.current = null;
      };
    }, []);
    var viewportWidth = 0;
    try {
      if (typeof window !== "undefined" && window && typeof window.innerWidth === "number") viewportWidth = window.innerWidth;
    } catch (e) { /* an embedded webview may restrict access */ }
    var contentWidth = measuredWidth > 0 ? measuredWidth : viewportWidth;
    // Phone browser = the VIEWPORT is small. A narrow settings dialog on a
    // desktop is not a phone: its column is small but the window is not.
    var isMobile = viewportWidth > 0 ? viewportWidth < 700 : (contentWidth > 0 && contentWidth < 600);
    var isWide = !isMobile && surface !== "modal" && (contentWidth === 0 || contentWidth >= 720);
    var checkingState = react.useState(false);
    var checking = checkingState[0];
    var setChecking = checkingState[1];
    // The update explanation is progressive disclosure: the header only shows the
    // quiet "可升级到 x" link, and this state opens the neutral detail panel.
    var updateOpenState = react.useState(false);
    var updateOpen = updateOpenState[0];
    var setUpdateOpen = updateOpenState[1];
    // Implementation details (tool count, one-shot mode, policy text, versions)
    // start collapsed: the settings page is for acting, not reading.
    var notesState = react.useState(false);
    var notesOpen = notesState[0];
    var setNotesOpen = notesState[1];
    // What the update snapshot looked like when the check was dispatched. The
    // Host answers a check in TWO shapes — success advances `checkedAt`, failure
    // only writes `error` (it deliberately leaves the reuse window alone) — so the
    // baseline records the whole update string, not just the timestamp.
    var checkBaseline = react.useRef({ raw: undefined, checkedAt: 0, error: "" });
    var checkTimer = react.useRef(null);
    // The update check is fire-and-forget: the Host writes the outcome into the
    // view (`update.error`) and the header renders it, so its transport failure
    // is not a write the user must be told about — but the rejection MUST be
    // caught, or a dead bridge turns every page open into an unhandled
    // rejection (which is a hard failure in Node).
    var kickUpdateCheck = function (force) {
      if (typeof props.configOp !== "function") return;
      try {
        var p = props.configOp({ op: "updateCheck", force: force === true });
        if (p && typeof p.then === "function") p.then(function () {}, function () {});
      } catch (e) { /* an offline host is not a page failure */ }
    };
    var runUpdateCheck = function (force) {
      setChecking(true);
      checkBaseline.current = { raw: value.update, checkedAt: update.checkedAt, error: update.error };
      if (checkTimer.current) clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(function () {
        checkTimer.current = null;
        setChecking(false);
      }, 20000);
      kickUpdateCheck(force === true);
    };
    // Opening the page asks the Host for a (throttled) update check; the Host
    // owns the network call and the cache, so a refresh here costs nothing.
    react.useEffect(function () {
      kickUpdateCheck(false);
      return undefined;
    }, []);
    react.useEffect(function () {
      if (!checking) return;
      // The Host answered this request as soon as the update snapshot changes AT
      // ALL — a newer `checkedAt` (success), a different `error` line (failure), or
      // simply a new snapshot string. Watching `checkedAt` alone meant a FAILED
      // check cleared nothing: the button stayed disabled and the tooltip stayed on
      // 「检查中…」 until the 20s watchdog, which hid the very error the Host had
      // just written (`update.error` renders through `checkLabel`).
      var base = checkBaseline.current || {};
      var answered = value.update !== base.raw
        || update.error !== base.error
        || (update.checkedAt > 0 && update.checkedAt !== base.checkedAt);
      if (!answered) return;
      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
        checkTimer.current = null;
      }
      setChecking(false);
    }, [value.update, checking]);

    // ── view state (page only) ───────────────────────────────────────────────
    //
    // `useWorkspaces` is a standard prop of root-scoped slots: it tells us which
    // workspace was touched last so that group opens by default. Absent mounts
    // (Plugins row, sidebar panel) simply fall back to all-folded.
    var useWs = props && typeof props.useWorkspaces === "function" ? props.useWorkspaces : null;
    var wsSnap = useWs ? useWs(function (s) { return s; }) : null;
    var recentPath = recentWorkspacePath(wsSnap);

    var settingsState = react.useState(function () { return uiMemory.settingsOpen === true; });
    var settingsOpen = settingsState[0];
    var setSettingsOpen = settingsState[1];
    var expandedState = react.useState(function () { return uiMemory.expanded || {}; });
    var expanded = expandedState[0];
    var setExpandedState = expandedState[1];
    var addPanelState = react.useState(function () { return uiMemory.addOpen === true; });
    var addOpen = addPanelState[0];
    var setAddOpen = addPanelState[1];
    var addTargetState = react.useState(function () { return uiMemory.addTarget || ""; });
    var addTarget = addTargetState[0];
    var setAddTarget = addTargetState[1];
    var copiedState = react.useState("");
    var copiedKey = copiedState[0];
    var setCopiedKey = copiedState[1];
    var copyTimer = react.useRef(null);

    var groupOpen = function (g) {
      if (typeof expanded[g.key] === "boolean") return expanded[g.key];
      // One workspace opens by itself; with several, the most recently used one
      // opens and the rest stay folded.
      if (groups.length === 1) return true;
      return !!recentPath && samePath(g.path, recentPath);
    };
    var toggleGroup = function (g) {
      var patch = {};
      patch[g.key] = !groupOpen(g);
      var next = Object.assign({}, expanded, patch);
      uiMemory.expanded = next;
      setExpandedState(next);
    };
    var allOpen = groups.length > 0 && groups.every(groupOpen);
    var toggleAll = function () {
      var next = {};
      for (var i = 0; i < groups.length; i++) next[groups[i].key] = !allOpen;
      uiMemory.expanded = next;
      setExpandedState(next);
    };
    var toggleSettings = function () {
      var next = !settingsOpen;
      uiMemory.settingsOpen = next;
      setSettingsOpen(next);
    };
    var setAdd = function (open, target) {
      var nextTarget = open ? String(target || "") : "";
      uiMemory.addOpen = open;
      uiMemory.addTarget = nextTarget;
      setAddOpen(open);
      setAddTarget(nextTarget);
    };

    // ── write feedback (every surface shares it) ─────────────────────────────
    //
    // A write that fails MUST be visible. The face used to resolve every POST
    // (`noop` as the rejection handler), so `saveConfig().then(setSaved(true))`
    // printed 已保存 for a 401, for a Host refusal and for a dead network alike,
    // and a refused delete/configOp simply vanished. `writeError` is the one
    // place a failure lands; `.dbh-writefail` (role=alert) renders it on both
    // faces, and `saved` is never set by a failed write.
    var writeState = react.useState("");
    var writeError = writeState[0];
    var setWriteError = writeState[1];
    // The interval is a FORM field: an invalid value is its own error line and
    // no request is sent at all.
    var invalidState = react.useState("");
    var invalid = invalidState[0];
    var setInvalid = invalidState[1];
    var valueRef = react.useRef(value);
    valueRef.current = value;

    // Both messages the card may show are already safe: the Host scrubbed its
    // own refusal text, and everything else is a local dictionary string. The
    // DSN the user typed rides these POST bodies and is NEVER interpolated.
    var failureTextOf = function (e) {
      var m = e && typeof e.message === "string" ? e.message.trim() : "";
      return m || t("error.write");
    };
    // A probe command that never reached the Host is a TRANSPORT failure, not a
    // database failure: it must not read as "the connection timed out".
    var probeFailText = function (e) {
      var m = e && typeof e.message === "string" ? e.message.trim() : "";
      return e && e.hostText === true && m ? m : t("test.notSent");
    };
    // One rollback path: drop the tick and put the controls back on the value the
    // store still holds (a switch reading 隐藏 while the store says 显示 is a lie
    // the user cannot see through).
    var onWriteFail = function (e) {
      draftEdited.current = false;
      setDraft(draftFromValue(valueRef.current));
      setSaved(false);
      setWriteError(failureTextOf(e));
    };
    var callFace = function (call) {
      try { return Promise.resolve(call()); } catch (e) { return Promise.reject(e); }
    };
    // Option writes (interval / sidebar switch / policy switch).
    var runOptionWrite = function (call) {
      return callFace(call).then(function () {
        draftEdited.current = false;
        setWriteError("");
        setSaved(true);
      }, onWriteFail);
    };
    // The enable switch has no draft to roll back (its state lives in the Host
    // snapshot), so it only surfaces the failure.
    var runSettingWrite = function (call) {
      return callFace(call).then(function () { setWriteError(""); }, function (e) {
        setWriteError(failureTextOf(e));
      });
    };
    // A refused configOp (unknown workspace, rename collision, transport error)
    // must not look applied either. `onOk` runs only when the Host accepted the
    // command, so a form that carries user input (a typed DSN, a rename) stays
    // open on failure — closing it would also throw the retry away.
    var runConfigOp = function (payload, onOk) {
      return callFace(function () { return props.configOp(payload); }).then(function () {
        setWriteError("");
        if (typeof onOk === "function") onOk();
      }, function (e) { setWriteError(failureTextOf(e)); });
    };
    // A probe is fire-and-forget, but its DISPATCH is not: when the bridge
    // refuses the command (401 / offline) the Host never saw it. Waiting out the
    // 30s/60s watchdog and then reporting "test timed out" blames the connection
    // for a transport fault, so a rejected dispatch settles the probe right away.
    var dispatchProbe = function (payload, onFail) {
      var p;
      try { p = props.configOp(payload); } catch (e) { p = Promise.reject(e); }
      if (p && typeof p.then === "function") {
        p.then(function () { /* the report arrives through the mirror */ }, function (e) {
          if (typeof onFail === "function") onFail(e);
        });
      }
    };

    // The only action that can fix a failed read: ask the face for one fresh
    // snapshot. The HTTP face publishes the answer; a failure is not a page
    // failure here.
    var retrySnapshot = function () {
      try {
        if (typeof props.refresh !== "function") return;
        var p = props.refresh();
        if (p && typeof p.then === "function") p.then(function () {}, function () {});
      } catch (e) { /* a face without a refresh entry point is not a page failure */ }
    };

    // ── config draft (interval + the sidebar switch + the policy switch) ──────
    //
    // The Host value is the source of truth. The draft follows it while the user
    // has no unsaved edit; a local edit stays put until its write settles —
    // success keeps it, failure rolls it back (see `onWriteFail`).
    var draftState = react.useState(function () { return draftFromValue(value); });
    var draft = draftState[0];
    var setDraft = draftState[1];
    // Does a local edit outrank the Host snapshot? Cleared when a write settles.
    var draftEdited = react.useRef(false);
    var savedState = react.useState(false);
    var saved = savedState[0];
    var setSaved = savedState[1];

    react.useEffect(function () {
      // Follow the Host while nothing local is pending: a write from another
      // surface (the model, the settings form, a second window) becomes visible
      // here instead of the page freezing on the value it mounted with.
      if (draftEdited.current) return;
      var next = draftFromValue(value);
      setDraft(function (prev) {
        if (prev && prev.updateIntervalDays === next.updateIntervalDays
          && prev.showSidebarEntry === next.showSidebarEntry
          && prev.announceAccessPolicy === next.announceAccessPolicy) return prev;
        return next;
      });
    }, [value.updateIntervalDays, value.showSidebarEntry, value.announceAccessPolicy]);

    // The interval is validated HERE, before any request: `Number("")` is 0, so
    // an empty box used to save "never auto-update" and still print 已保存, and
    // 1.5 sailed through every check the Host applies.
    var parseInterval = function (raw) {
      var text = raw === undefined || raw === null ? "" : String(raw).trim();
      if (!text) return null;
      var n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > 365) return null;
      return n;
    };

    var saveConfig = function () {
      var days = parseInterval(draft.updateIntervalDays);
      if (days === null) {
        setSaved(false);
        setInvalid(t("cfg.badInterval"));
        return;
      }
      setInvalid("");
      runOptionWrite(function () {
        return props.saveConfig({
          updateIntervalDays: days,
          showSidebarEntry: draft.showSidebarEntry !== false,
          announceAccessPolicy: draft.announceAccessPolicy !== false,
        });
      });
    };

    // The switch applies immediately (no Save round-trip), like it always has.
    var toggleSidebar = function (next) {
      draftEdited.current = true;
      setSaved(false);
      setDraft(Object.assign({}, draft, { showSidebarEntry: next }));
      runOptionWrite(function () { return props.saveConfig({ showSidebarEntry: next }); });
    };

    // Same immediate-apply contract for the policy announcement.
    var togglePolicy = function (next) {
      draftEdited.current = true;
      setSaved(false);
      setDraft(Object.assign({}, draft, { announceAccessPolicy: next }));
      runOptionWrite(function () { return props.saveConfig({ announceAccessPolicy: next }); });
    };

    // ── pre-test + confirm dialog for add/edit ────────────────────────────────
    //
    // Both the add form and the edit form gate saves behind a live connection
    // probe. Flow (unchanged from the original design):
    //   1. User clicks 添加 / 保存 → dispatch op:"test" with the raw DSN (the
    //      Host accepts `dsn` in a test op so no row has to exist yet).
    //   2. The form stays visible; the status line shows "正在测试连接…".
    //   3. Host answers → ok saves immediately; a failure shows an inline
    //      confirm card ("连接失败，是否仍要保存？") with the reason.
    //   4. 仍要保存 (force) or 取消 → clear the pretest state.
    var pretestState = react.useState(null);
    var pretest = pretestState[0];
    var setPretest = pretestState[1];
    // The pretest report is consumed through the SAME effect that handles the
    // per-row tests (the proven path). `pretestRef` mirrors the current pretest
    // state so the effect always sees the latest shape; a stale report for an
    // already-finished pretest is ignored by the nonce guard.
    var pretestRef = react.useRef(null);
    pretestRef.current = pretest;

    var addState = react.useState(Object.assign({ ws: "", env: "default", dsn: "", ro: false, adv: false }, sshDraftOf(null)));
    var addForm = addState[0];
    var setAddForm = addState[1];
    var addDsn = function () {
      if (!addForm.dsn.trim()) return;
      // The read-only switch and the tunnel ride the SAME write as the DSN, so
      // one click produces one atomic store write (and one op for the
      // single-field command channel). `_draft` keeps the originating form
      // reachable for the pre-test payload and the final save.
      requestWrite(withConnDraft({
        ws: addTarget || addForm.ws.trim(),
        env: addForm.env.trim() || "default",
        dsn: addForm.dsn.trim(),
        _draft: addForm,
      }, addForm), true);
    };

    var editState = react.useState(null);
    var editing = editState[0];
    var setEditing = editState[1];
    var updateEditing = function (patch) {
      setEditing(function (prev) { return prev ? Object.assign({}, prev, patch) : prev; });
    };
    // Does the draft differ from the row's mirrored OPTIONS? Secrets are not
    // comparable (a blank input means "keep"), so only the non-secret fields and
    // the read-only flag take part.
    var optionsDiffer = function (row, form) {
      var d = connDraftOf(form);
      if ((row.ro === true) !== (d.readOnly === true)) return true;
      var had = row.ssh || null;
      var want = d.ssh === undefined ? had : d.ssh;
      if (!had && !want) return false;
      if (!had || !want) return true;
      return String(had.host || "") !== String(want.host || "")
        || String(had.port || "") !== String(want.port || "")
        || String(had.user || "") !== String(want.user || "")
        || String(had.authKind || "") !== String(want.auth || "")
        || String(had.proxyJump || "") !== String(want.proxyJump || "");
    };
    // An edit can change the DSN, the environment NAME, the options, or any
    // combination. A name-only change is a rename (no connection data to verify);
    // a DSN change keeps the pre-test gate and carries the rename along in the
    // SAME host op — two configOp writes would race on the single `configOp`
    // namespace field.
    var saveEdit = function (row) {
      if (!editing) return;
      var newEnv = String(editing.env || "").trim() || "default";
      var dsn = String(editing.dsn || "").trim();
      // Compare normalized names: the Host stores the normalized form, so
      // "prod " or an over-long name is not a rename onto a different env.
      var renaming = normalizeEnvForCompare(newEnv) !== normalizeEnvForCompare(row.env);
      if (!dsn) {
        var optionsChanged = optionsDiffer(row, editing);
        if (!renaming && !optionsChanged) { setEditing(null); return; } // nothing changed
        if (!optionsChanged) {
          // Pure rename: nothing to probe, but landing on an existing
          // environment still replaces that connection, so it goes through the
          // same overwrite gate as a connection write.
          requestWrite({ op: "rename", _opKind: "rename", ws: row.path, env: newEnv, dsn: "", _editRow: row, _renameFrom: row.env }, true);
          return;
        }
        if (!renaming) {
          // Options-only write on a row that keeps its name: no DSN to verify
          // and no name that could collide.
          runConfigOp(withConnDraft({ op: "options", workspace: row.path, env: row.env }, editing), function () { setEditing(null); });
          return;
        }
        // Renamed AND re-optioned: one atomic `options` command carrying newEnv.
        requestWrite(withConnDraft({ op: "options", _opKind: "options", ws: row.path, env: newEnv, dsn: "", _editRow: row, _renameFrom: row.env }, editing), true);
        return;
      }
      // Editing the connection of the SAME environment is not an overwrite
      // question (it is the point of the edit); renaming onto another one is.
      requestWrite(withConnDraft({ ws: row.path, env: newEnv, dsn: dsn, _editRow: row, _renameFrom: renaming ? row.env : "" }, editing), renaming);
    };

    // ── overwrite gate ───────────────────────────────────────────────────────
    //
    // Writing into an environment that already exists REPLACES its connection
    // (the Host's setWorkspaceEnv is an unconditional store write), so the page
    // asks first and only then runs the normal pre-test + save. Cancelling
    // writes nothing and leaves the form alone so the user can rename.
    var overwriteState = react.useState(null);
    var overwrite = overwriteState[0];
    var setOverwrite = overwriteState[1];

    var executeWrite = function (form) {
      if (form._editRow && !String(form.dsn || "").trim()) {
        // a name/option-only change carries no connection data to probe
        var op;
        if (form._opKind === "rename") {
          op = { op: "rename", workspace: form.ws, env: form._editRow.env, newEnv: form.env };
        } else {
          op = withConnDraft({ op: "options", workspace: form.ws, env: form._editRow.env }, draftOf(form));
          if (form._renameFrom && normalizeEnvForCompare(form._renameFrom) !== normalizeEnvForCompare(form.env)) op.newEnv = form.env;
        }
        // The Host refuses a rename onto an existing environment unless the user
        // confirmed it in the warning card: the flag is the confirmation.
        if (form._confirmed === true) op.overwrite = true;
        runConfigOp(op, function () { setEditing(null); });
        return;
      }
      dispatchPretest(form);
    };
    var requestWrite = function (form, check) {
      var hit = check ? envCollision(workspaces, form.ws, form.env) : null;
      if (hit) {
        setOverwrite({ form: form, hit: hit });
        return;
      }
      executeWrite(form);
    };
    var confirmOverwrite = function () {
      if (!overwrite) return;
      // `_confirmed` rides the SAME form object through the pre-test and the
      // save, so the Host learns that this particular write was approved.
      var form = Object.assign({}, overwrite.form, { _confirmed: true });
      setOverwrite(null);
      executeWrite(form);
    };
    var cancelOverwrite = function () { setOverwrite(null); };

    // ── delete gate ──────────────────────────────────────────────────────────
    //
    // Removing a connection used to be one unconfirmed click straight to the
    // Host — the only write on the page that skipped a "did you mean it?" step,
    // and the only irreversible one. It now asks first with the same
    // `.dbh-warncard`; cancelling writes nothing at all.
    var removeState = react.useState(null);
    var pendingRemove = removeState[0];
    var setPendingRemove = removeState[1];
    // One-shot guard for the IRREVERSIBLE write (R5). Two clicks in the same tick
    // both see the closure's `pendingRemove`, and `setPendingRemove(null)` only
    // takes effect on the next render — so the card used to dispatch TWO removes
    // for one user action. A ref is set synchronously, before the render, which is
    // the ordering that makes the second click a no-op.
    var removeInFlight = react.useRef(false);
    var askRemove = function (w) {
      removeInFlight.current = false;
      setPendingRemove({ w: w });
    };
    var cancelRemove = function () { setPendingRemove(null); };
    var confirmRemove = function () {
      var target = pendingRemove;
      if (!target) return;
      if (removeInFlight.current) return;
      removeInFlight.current = true;
      setPendingRemove(null);
      var done = function () { removeInFlight.current = false; };
      var p = runConfigOp({ op: "remove", workspace: target.w.path, env: target.w.env });
      // A failure re-arms the guard: "click again" stays a real retry.
      if (p && typeof p.then === "function") p.then(done, done);
      else removeInFlight.current = false;
    };

    // Dispatch a raw-DSN pre-test and record the nonce so the test-result
    // mirror callback can route it back here. Pretest nonces are prefixed
    // "pretest:" so the regular effect branch skips them. The payload carries
    // the draft's options too, so "试连" really validates the tunnel/read-only
    // combination the user is about to save.
    var dispatchPretest = function (form) {
      // The nonce must not collide: two saves in the same millisecond used to
      // receive the same `Date.now()` suffix and the second report was routed
      // into the first request's state.
      var nonce = "pretest:" + (form.ws || "") + "|" + (form.env || "default") + "|" + uniqueNonceId();
      nonceKeys.current[nonce] = nonce;
      setPretest({ form: form, pendingNonce: nonce, failMessage: null });
      var draft = connDraftOf(draftOf(form));
      var payload = { op: "test", dsn: form.dsn, workspace: form.ws || undefined, env: form.env || "default", nonce: nonce };
      // An edit validates the options the row already has; a brand-new form only
      // asserts what it actually carries (so it cannot clear a stored tunnel).
      if (form._editRow || draft.readOnly === true) payload.readOnly = draft.readOnly === true;
      if (draft.ssh === null) payload.ssh = null;
      else if (draft.ssh) payload.ssh = draft.ssh;
      // Watchdog tier: an SSH handshake is slower than a direct connect, so a
      // tunnelled validation gets a longer leash (host side is tiered to match
      // and stays strictly below this).
      var leash = draft.ssh ? PRETEST_WATCHDOG_SSH_MS : PRETEST_WATCHDOG_MS;
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        delete nonceKeys.current[nonce];
        setPretest(function (prev) {
          if (!prev || prev.pendingNonce !== nonce) return prev;
          var next = Object.assign({}, prev);
          next.failMessage = t("test.timeout");
          next.pendingNonce = null;
          return next;
        });
      }, leash);
      // A refused dispatch never reaches the Host: clear the watchdog and say
      // "not delivered" now instead of spinning for 30-60s and then reporting a
      // timeout (which the user reads as "the connection is down").
      dispatchProbe(payload, function (e) {
        clearTestTimer(nonce);
        delete nonceKeys.current[nonce];
        setPretest(function (prev) {
          if (!prev || prev.pendingNonce !== nonce) return prev;
          return Object.assign({}, prev, { pendingNonce: null, failMessage: probeFailText(e) });
        });
      });
    };

    /** The `add` payload for one save (options included). */
    var saveOpOf = function (f) {
      var op = withConnDraft({
        op: "add", workspace: f.ws || undefined, env: f.env || "default", dsn: String(f.dsn || "").trim(),
      }, draftOf(f));
      if (f._renameFrom) op.renameFrom = f._renameFrom;
      // Approved in the overwrite card: the Host requires the flag before it will
      // replace the environment this write renames onto.
      if (f._confirmed === true) op.overwrite = true;
      return op;
    };

    /** Close the add panel and clear it after a successful save. */
    var finishAddPanel = function (form) {
      if (form && form._editRow) { setEditing(null); return; }
      setAddForm(Object.assign({ ws: "", env: "default", dsn: "", ro: false, adv: uiMemory.advOpen === true }, sshDraftOf(null)));
      setAdd(false, "");
    };

    var confirmSave = function () {
      if (!pretest) return;
      var f = pretest.form;
      // The form closes only after the Host accepted the write: on a failure the
      // panel (with the typed DSN) stays put and one more click retries.
      runConfigOp(saveOpOf(f), function () { finishAddPanel(f); });
      setPretest(null);
    };
    var cancelPretest = function () { setPretest(null); };

    var openAdd = function (target) {
      setAddForm(Object.assign({ ws: String(target || ""), env: "default", dsn: "", ro: false, adv: uiMemory.advOpen === true }, sshDraftOf(null)));
      setEditing(null);
      setPretest(null);
      setAdd(true, target || "");
    };
    var closeAdd = function () { setPretest(null); setAdd(false, ""); };

    // ── end pre-test ─────────────────────────────────────────────────────────

    // ── connection test (transient feedback) ──
    //
    // The host answers every `{op:"test"}` with a one-shot report keyed by the
    // nonce WE dispatched: unknown/stale nonces are ignored, results auto-fade,
    // and a reload drops the whole local map — the outcome (success or failure)
    // is feedback for this click only, never a persisted status.
    var testState = react.useState({});
    var tests = testState[0];
    var setTests = testState[1];
    var nonceKeys = react.useRef({}); // nonce -> row key of a pending dispatch
    var testTimers = react.useRef({}); // id -> timeout handle (watchdog / auto-hide)
    var clearTestTimer = function (id) {
      if (testTimers.current[id]) {
        clearTimeout(testTimers.current[id]);
        delete testTimers.current[id];
      }
    };
    var finishTest = function (key, nonce, ok, message) {
      clearTestTimer(nonce);
      delete nonceKeys.current[nonce];
      setTests(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = { phase: "done", ok: ok, message: message, nonce: nonce };
        return next;
      });
      // A moment, not a status: fade the report out by itself.
      testTimers.current["hide:" + nonce] = setTimeout(function () {
        clearTestTimer("hide:" + nonce);
        setTests(function (prev) {
          if (!prev[key] || prev[key].nonce !== nonce) return prev;
          var next = Object.assign({}, prev);
          delete next[key];
          return next;
        });
      }, 10000);
    };
    var startTest = function (row, key) {
      var cur = tests[key];
      if (cur && cur.phase === "testing") return;
      var nonce = key + "|" + uniqueNonceId();
      nonceKeys.current[nonce] = key;
      setTests(function (prev) {
        var next = Object.assign({}, prev);
        // `startedAt` drives the elapsed readout: a probe really can take several
        // seconds, and an unlabelled spinner reads as "hung".
        next[key] = { phase: "testing", nonce: nonce, startedAt: Date.now() };
        return next;
      });
      // Backstop: the host reports on every path (incl. failures); if the
      // mirror never carries our nonce back, surface a timeout, don't spin.
      var tunnelled = !!(row && row.ssh);
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        finishTest(key, nonce, false, t("test.timeout"));
      }, tunnelled ? TEST_WATCHDOG_SSH_MS : TEST_WATCHDOG_MS);
      // A dispatch the bridge refused never reached the Host: settle the row now
      // with "not delivered" instead of letting the watchdog blame the database.
      dispatchProbe({ op: "test", workspace: row.path, env: row.env, nonce: nonce }, function (e) {
        finishTest(key, nonce, false, probeFailText(e));
      });
    };
    /**
     * SSH-LAYER-ONLY test: is the bastion reachable / does the tunnel come up,
     * independently of the database? Answers the "which side is wrong?" question
     * that a plain connection test cannot. Shares the nonce + test-result
     * machinery with the row tests, under its own key.
     */
    var startSshTest = function (form, targetOf, key) {
      var cur = tests[key];
      if (cur && cur.phase === "testing") return;
      var target = targetOf ? targetOf() : {};
      var nonce = key + "|" + uniqueNonceId();
      nonceKeys.current[nonce] = key;
      setTests(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = { phase: "testing", nonce: nonce, startedAt: Date.now() };
        return next;
      });
      var d = connDraftOf(form);
      var ssh = d.ssh && typeof d.ssh === "object" ? d.ssh : null;
      // `connDraftOf` always returns an object while the tunnel switch is on, so
      // "no block at all" is NOT the interesting case: a half-filled form (switch
      // on, host or user still blank) sent a block the Host can only answer with a
      // generic "missing user". Answer it here, in the form's own words, and save
      // the round-trip.
      if (!ssh || !String(ssh.host || "").trim() || !String(ssh.user || "").trim()) {
        finishTest(key, nonce, false, t("adv.testSshNeedFields"));
        return;
      }
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        finishTest(key, nonce, false, t("test.timeout"));
      }, TEST_WATCHDOG_SSH_MS);
      dispatchProbe({
        op: "test", kind: "ssh",
        workspace: target.ws || undefined, env: target.env || "default",
        ssh: ssh, nonce: nonce,
      }, function (e) {
        finishTest(key, nonce, false, probeFailText(e));
      });
    };
    // ── elapsed readout for a running probe ──
    //
    // The 1s ticker exists ONLY while at least one row is testing: an idle page
    // must not hold an interval (the offscreen render gate fails the run if one
    // survives), and the effect's cleanup covers finish/unmount alike.
    var tickState = react.useState(0);
    var setTick = tickState[1];
    var anyTesting = false;
    for (var tk in tests) {
      if (Object.prototype.hasOwnProperty.call(tests, tk) && tests[tk] && tests[tk].phase === "testing") { anyTesting = true; break; }
    }
    react.useEffect(function () {
      if (!anyTesting || typeof setInterval !== "function") return undefined;
      var id = setInterval(function () { setTick(function (n) { return n + 1; }); }, 1000);
      return function () { clearInterval(id); };
    }, [anyTesting]);
    react.useEffect(function () {
      var raw = typeof value.testResult === "string" ? value.testResult : "";
      if (!raw) return;
      var res;
      try { res = JSON.parse(raw); } catch (e) { return; }
      if (!res || typeof res.nonce !== "string") return;
      var key = nonceKeys.current[res.nonce];
      if (!key) return; // stale or superseded report — nothing to show
      clearTestTimer(res.nonce);
      delete nonceKeys.current[res.nonce];
      if (res.nonce.indexOf("pretest:") === 0) {
        // Pre-save probe for the add/edit form: route the report into the
        // pretest state machine (guarded by nonce — stale reports ignored).
        var pt = pretestRef.current;
        if (!pt || pt.pendingNonce !== res.nonce) return;
        var f = pt.form;
        if (res.ok === true) {
          // Test passed — save immediately (options included, in the same op).
          // Close the panel only once the Host accepted it (a refused save keeps
          // the form so the same click can be retried).
          runConfigOp(saveOpOf(f), function () { finishAddPanel(f); });
          setPretest(null);
        } else {
          // Test failed — show confirm card with the fail reason.
          setPretest(Object.assign({}, pt, { pendingNonce: null, failMessage: String(res.message || "") }));
        }
        return;
      }
      finishTest(key, res.nonce, res.ok === true, String(res.message || ""));
    }, [value.testResult]);
    react.useEffect(function () {
      var timers = testTimers.current;
      return function () {
        for (var id in timers) { if (Object.prototype.hasOwnProperty.call(timers, id)) clearTimeout(timers[id]); }
        if (copyTimer.current) clearTimeout(copyTimer.current);
        if (checkTimer.current) { clearTimeout(checkTimer.current); checkTimer.current = null; }
      };
    }, []);

    // Copy the source handle (never a DSN: `srcId` is the model-facing handle,
    // `<title>_<wsHash>[_<env>]`, and carries no credentials). The platform
    // clipboard helper already falls back to execCommand on insecure hosts.
    var copySource = function (text, key) {
      if (!text) return;
      var done = function () {
        setCopiedKey(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(function () { setCopiedKey(""); }, 1200);
      };
      try {
        if (primitives && typeof primitives.writeClipboard === "function") {
          primitives.writeClipboard(text).then(done, done);
          return;
        }
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
          return;
        }
      } catch (e) { /* fall through to the visual ack */ }
      done();
    };

    // ── derived copy ──
    //
    // Surfaces show only what a user acts on: state + connection count.
    var statusText = t(meta.key);
    var connSummary = workspaces.length > 0
      ? t("status.conns", { n: String(workspaces.length) })
      : t("desc.unconfigured");

    // ── row pieces ──
    //
    // Where a connection came from (hand-entered / scanned / copied / auto-
    // discovered from mise/.env) is identical on almost every row, so it is NOT
    // an inline badge: it lives in the environment chip's tooltip. Only the
    // exception — an auto-discovered row that was never persisted — is called
    // out there explicitly.
    var originTitle = function (w, base) {
      var text = (base ? String(base) + " · " : "") + t("ws.source") + "：" + sourceLabelOf(w, t);
      if (!w.persisted) text += " " + t("ws.autoHint");
      // Read-only and the tunnel are per-row ATTRIBUTES (they change what a query
      // may do and how it is routed), so they ride the chip: the flag is visible,
      // the details are one hover away.
      if (w.ro === true) text += " · " + t("ro.title");
      if (w.ssh) text += " · " + t("ro.sshTitle", { host: String(w.ssh.host || ""), port: String(w.ssh.port || ""), user: String(w.ssh.user || "") });
      return text;
    };
    // Environment chip: the name only. Read-only is its own row control below,
    // so it can be flipped without opening the edit form.
    var envChip = function (w) {
      return h("span", { className: "dbh-envname", title: originTitle(w, w.env) }, w.env);
    };
    /**
     * Per-row read-only toggle, on every layout (dialog, wide page, phone).
     * One click writes `{op:'options', readOnly}` — no edit form, no re-typing a
     * DSN. The chip itself is the state: outlined = writable, filled + lock = the
     * model cannot write.
     */
    var roChip = function (w) {
      var on = w.ro === true;
      return h("button", {
        type: "button",
        className: "dbh-rochip" + (on ? " dbh-rochip-on" : ""),
        title: roSupported ? (on ? t("ro.chipOnHint") : t("ro.chipOffHint")) : capHint,
        "aria-label": on ? t("ro.turnOff") : t("ro.turnOn"),
        "aria-pressed": on,
        disabled: !roSupported,
        onClick: function () {
          runConfigOp({ op: "options", workspace: w.path, env: w.env, readOnly: w.ro !== true });
        },
      }, h("span", { className: "dbh-roemoji", "aria-hidden": true }, on ? "🔒" : "🔓"), t(on ? "ro.chip" : "ro.writable"));
    };
    // The source handle is a first-class, visibly-copyable chip: it shows the
    // trailing characters that tell look-alike handles apart, and its dashed
    // outline + copy glyph say "this is an id", not "copy the row". Action
    // buttons are icon-only (24px) so the connection text keeps the width.
    var sourceChip = function (w, key) {
      var copied = copiedKey === key;
      return h("button", {
        type: "button",
        className: "dbh-src" + (copied ? " dbh-src-ok" : ""),
        title: (copied ? t("copy.ok") : t("btn.copy") + "：" + String(w.srcId || "")) + " · " + t("ws.srcHint"),
        "aria-label": t("btn.copy") + " " + String(w.srcId || ""),
        onClick: function () { copySource(String(w.srcId || ""), key); },
      },
        h(CopyIcon, { size: 12 }),
        h("span", { className: "dbh-srcid" }, copied ? t("copy.ok") : shortHandle(w.srcId)));
    };
    var rowActions = function (w, key) {
      var entry = tests[key];
      var isTesting = !!(entry && entry.phase === "testing");
      var isEditing = !!(editing && editing.key === key);
      return h("span", { className: "dbh-acts" },
        sourceChip(w, key),
        h("button", {
          type: "button", className: "dbh-iconbtn" + (isTesting ? " dbh-iconbtn-busy" : ""),
          title: isTesting ? t("test.testing") : t("btn.test"),
          "aria-label": t("btn.test"),
          "aria-busy": isTesting,
          disabled: isTesting,
          onClick: function () { startTest(w, key); },
        }, h(RunIcon, { size: 16 })),
        h("button", {
          type: "button", className: "dbh-iconbtn",
          title: isEditing ? t("btn.cancel") : t("btn.edit"),
          "aria-label": isEditing ? t("btn.cancel") : t("btn.edit"),
          onClick: function () {
            setEditing(isEditing ? null : Object.assign({
              key: key, dsn: "", env: w.env, ro: w.ro === true, adv: uiMemory.advOpen === true,
            }, sshDraftOf(w)));
          },
        }, isEditing ? h(CloseIcon, { size: 14 }) : h(EditIcon, { size: 16 })),
        w.persisted ? h("button", {
          type: "button", className: "dbh-iconbtn dbh-iconbtn-danger",
          title: t("btn.delete"),
          "aria-label": t("btn.delete"),
          onClick: function () { askRemove(w); },
        }, h(TrashIcon, { size: 16 })) : null);
    };
    // Browsers serialize a copy of adjacent BLOCK-level boxes with a separator,
    // and the split label is two flex items — pasting it into the DSN field used
    // to gain a space ("…3306/ app"). A copy taken from the label itself is
    // therefore answered with the exact metadata string. Attaching this to the
    // label (not the row) keeps an environment-name copy untouched, and `w.conn`
    // is type://host:port/db — metadata, never a credential.
    var onConnCopy = function (w, e) {
      try {
        if (!e || !e.clipboardData || typeof e.clipboardData.setData !== "function") return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", String(w.conn || ""));
      } catch (err) { /* fall back to the browser's own serialization */ }
    };
    var pendingPretest = !!(pretest && pretest.pendingNonce);

    /**
     * The advanced (SSH) section shared by the add panel and the row editor.
     *
     * Layout red line: these inputs must NOT use `.dbh-field` and must appear
     * AFTER the DSN input in document order — the offscreen gate pins the add
     * panel's field count and the 0..2 input indices.
     *
     * Secrets are never echoed: the stored password / passphrase / key path stay
     * in the Host, and a blank input means "keep what is stored".
     */
    var advPanel = function (form, update, keyPrefix, targetOf) {
      var open = form.adv === true || uiMemory.advOpen === true;
      var toggle = function () {
        var next = !open;
        uiMemory.advOpen = next;
        update({ adv: next });
      };
      var children = [];
      children.push(h("button", {
        type: "button", className: "dbh-advtoggle", "aria-expanded": open,
        disabled: !sshSupported,
        title: sshSupported ? t("add.adv") : capHint,
        key: keyPrefix + "-toggle",
        onClick: toggle,
      }, (open ? "▾ " : "▸ ") + t("add.adv")));
      if (open) {
        var body = [];
        body.push(h("label", { className: "dbh-check", key: keyPrefix + "-on" },
          h("input", {
            type: "checkbox", className: "dbh-checkbox",
            checked: form.sshOn === true,
            onChange: function (e) { update({ sshOn: e.target.checked }); },
          }),
          h("span", null, t("adv.enable"))));
        if (form.sshOn === true) {
          var field = function (key, label, props, valueKey) {
            return h("div", { className: "dbh-advrow", key: keyPrefix + "-" + key },
              h("span", { className: "dbh-advlabel" }, label),
              h("input", Object.assign({
                className: "dbh-input",
                value: String(form[valueKey] || ""),
                onChange: function (e) { var patch = {}; patch[valueKey] = e.target.value; update(patch); },
              }, props)));
          };
          body.push(field("host", t("adv.host"), { placeholder: "bastion.example.com", "aria-label": t("adv.host") }, "sshHost"));
          body.push(field("port", t("adv.port"), { placeholder: "22", "aria-label": t("adv.port") }, "sshPort"));
          body.push(field("user", t("adv.user"), { placeholder: "ops", "aria-label": t("adv.user") }, "sshUser"));
          body.push(h("label", { className: "dbh-advrow", key: keyPrefix + "-auth" },
            h("span", { className: "dbh-advlabel" }, t("adv.auth")),
            h("span", { className: "dbh-check" },
              h("input", {
                type: "radio", name: keyPrefix + "-authkind", className: "dbh-checkbox",
                checked: form.sshAuthKind !== "password",
                onChange: function () { update({ sshAuthKind: "key" }); },
              }),
              h("span", null, t("adv.auth.key"))),
            h("span", { className: "dbh-check" },
              h("input", {
                type: "radio", name: keyPrefix + "-authkind", className: "dbh-checkbox",
                checked: form.sshAuthKind === "password",
                onChange: function () { update({ sshAuthKind: "password" }); },
              }),
              h("span", null, t("adv.auth.password")))));
          if (form.sshAuthKind === "password") {
            body.push(field("password", t("adv.password"), { type: "password", placeholder: t("adv.keepSecret"), "aria-label": t("adv.password") }, "sshPassword"));
          } else {
            body.push(field("keyPath", t("adv.keyPath"), { placeholder: "~/.ssh/id_ed25519", "aria-label": t("adv.keyPath") }, "sshKeyPath"));
            body.push(field("passphrase", t("adv.passphrase"), { type: "password", placeholder: t("adv.keepSecret"), "aria-label": t("adv.passphrase") }, "sshPassphrase"));
          }
          body.push(field("proxyJump", t("adv.proxyJump"), { placeholder: "jump.example.com:2222", "aria-label": t("adv.proxyJump") }, "sshProxyJump"));
          // The SSH-layer test: reachability of the bastion, the local key file,
          // and whether dbhub can bring the tunnel up — WITHOUT the database in
          // the picture, so a failure can be attributed to one side.
          var sshKey = keyPrefix + "|sshtest";
          var sshEntry = tests[sshKey];
          var sshBusy = !!(sshEntry && sshEntry.phase === "testing");
          body.push(h("div", { className: "dbh-advrow", key: keyPrefix + "-sshtest" },
            h("button", {
              type: "button", className: "dbh-btn",
              disabled: sshBusy,
              title: t("adv.testSshHint"),
              onClick: function () { startSshTest(form, targetOf, sshKey); },
            }, t("btn.testSsh"))));
          if (sshBusy) {
            var sshSecs = sshEntry.startedAt ? Math.max(0, Math.round((Date.now() - sshEntry.startedAt) / 1000)) : 0;
            body.push(h("div", { className: "dbh-test-ok", key: keyPrefix + "-sshrun" }, "⏳ " + t("test.elapsed", { s: String(sshSecs) })));
          } else if (sshEntry && sshEntry.phase === "done") {
            body.push(h("div", {
              className: sshEntry.ok ? "dbh-test-ok" : "dbh-test-fail",
              key: keyPrefix + "-sshres",
            }, (sshEntry.ok ? "✓ " : "✗ ") + sshEntry.message));
          }
          body.push(h("div", { className: "dbh-hint", key: keyPrefix + "-hint" }, t("adv.hostHint") + " " + t("adv.slow")));
        }
        children.push(h("div", { className: "dbh-advbody", key: keyPrefix + "-body" }, body));
      }
      return h("div", { className: "dbh-adv", key: keyPrefix + "-adv" }, children);
    };

    /** The read-only checkbox shared by both forms. */
    var roCheck = function (form, update, keyPrefix) {
      return h("label", {
        className: "dbh-check",
        key: keyPrefix + "-ro",
        title: roSupported ? t("ro.title") : capHint,
      },
        h("input", {
          type: "checkbox", className: "dbh-checkbox",
          checked: form.ro === true,
          disabled: !roSupported,
          "aria-label": t("add.readOnly"),
          onChange: function (e) { update({ ro: e.target.checked }); },
        }),
        h("span", null, t("add.readOnly")));
    };

    /** Editor for the options of an auto-discovered (options-only) row. */
    var editRow = function (w, key) {
      if (!(editing && editing.key === key)) return null;
      var update = function (patch) { updateEditing(patch); };
      return h("div", { className: "dbh-editbox", key: "edit" },
        h("div", { className: "dbh-editrow" },
          h("input", {
            className: "dbh-input dbh-envinput",
            "aria-label": t("add.env"),
            placeholder: t("env.newPlaceholder"),
            value: typeof editing.env === "string" ? editing.env : w.env,
            onChange: function (e) { updateEditing({ env: e.target.value }); },
          }),
          h("input", {
            className: "dbh-input",
            "aria-label": t("add.dsn"),
            placeholder: t("dsn.editPlaceholder"),
            value: editing.dsn,
            onChange: function (e) { updateEditing({ dsn: e.target.value }); },
          }),
          roCheck(editing, update, "ed"),
          h("button", {
            type: "button", className: "dbh-btn dbh-btn-primary",
            disabled: pendingPretest,
            onClick: function () { saveEdit(w); },
          }, t("btn.saved"))),
        advPanel(editing, update, "ed|" + w.path + "|" + w.env, function () {
          return { ws: w.path, env: String(editing.env || "").trim() || w.env };
        }));
    };
    var testRow = function (w, key) {
      var entry = tests[key];
      if (!entry) return null;
      if (entry.phase === "testing") {
        // Elapsed seconds, so a slow (tunnelled) probe reads as "working", not
        // as a frozen page. Re-rendered by the testing-only ticker above.
        var secs = entry.startedAt ? Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000)) : 0;
        return h("div", { key: "test", className: "dbh-test-ok" }, "⏳ " + t("test.elapsed", { s: String(secs) }));
      }
      if (entry.phase !== "done") return null;
      return h("div", { key: "test", className: entry.ok ? "dbh-test-ok" : "dbh-test-fail" },
        (entry.ok ? "✓ " : "✗ ") + entry.message);
    };

    // One connection per line: env chip · connection metadata · source chip ·
    // icon actions. The metadata is split so the database name (the part people
    // look for) never gets truncated away by the host/port prefix.
    var connLabelView = function (w) {
      var parts = splitConn(w.conn);
      return h("span", { className: "dbh-conn", title: w.conn, onCopy: function (e) { onConnCopy(w, e); } },
        // The lock used to sit in front of every connection string, which read
        // like "this row needs a password" and clashed with the read-only lock.
        // Rows show the plain type://host:port/db; the only lock is the
        // read-only chip.
        h("span", { className: "dbh-conn-pre" }, parts.prefix),
        parts.tail ? h("span", { className: "dbh-conn-db" }, parts.tail) : null);
    };
    var envRow = function (w) {
      var key = w.path + "|" + w.env;
      return h("div", { className: "dbh-envwrap", key: key },
        h("div", { className: "dbh-envrow" },
          envChip(w),
          connLabelView(w),
          roChip(w),
          rowActions(w, key)),
        editRow(w, key),
        testRow(w, key));
    };

    var groupView = function (g) {
      var open = groupOpen(g);
      return h("div", { className: "dbh-group", key: g.key },
        h("div", { className: "dbh-groupheadwrap" },
          h("button", {
            type: "button", className: "dbh-grouphead",
            "aria-expanded": open,
            title: g.path,
            onClick: function () { toggleGroup(g); },
          },
            h("span", { className: "dbh-chev" + (open ? " open" : "") }, h(ChevronIcon, null)),
            h("span", { className: "dbh-grouptitle" }, g.title),
            g.dup ? h("span", { className: "dbh-groupmeta" }, g.path) : null,
            h("span", { className: "dbh-groupmeta" }, t("grp.envs", { n: String(g.envs.length), m: String(g.saved) }))),
          h("button", {
            type: "button", className: "dbh-btn",
            onClick: function () { openAdd(g.path); },
          }, t("btn.addEnv"))),
        open ? h("div", { className: "dbh-groupbody" }, g.envs.map(function (w) { return envRow(w); })) : null);
    };

    // Single-environment workspaces: a tile per workspace, everything visible.
    var tileView = function (g) {
      var w = g.envs[0];
      var key = w.path + "|" + w.env;
      // Same-title workspaces are different targets: show the path instead of
      // the ambiguous title (the full path stays in the tooltip).
      var label = g.dup ? g.path : g.title;
      return h("div", { className: "dbh-tile", key: g.key },
        h("div", { className: "dbh-tilehead" },
          h("span", { className: "dbh-tiletitle", title: g.path }, label)),
        h("div", { className: "dbh-tilemeta" },
          envChip(w),
          connLabelView(w),
          roChip(w)),
        h("div", { className: "dbh-tileacts" }, rowActions(w, key)),
        editRow(w, key),
        testRow(w, key));
    };

    // ── assemble the page ──
    //
    // Header: title + subdued version plus a quiet "可升级到 x" link that
    // expands into a neutral panel on demand.
    var latestSpec = update.latestSpec || (update.latest ? "dsh-dbhub-live@" + update.latest : "");
    var webCmd = update.latest ? "dsh plugin --profile web up dsh-dbhub-live@" + update.latest : "";
    var checkedMinutes = update.checkedAt ? Math.max(0, Math.round((Date.now() - update.checkedAt) / 60000)) : 0;
    var copyLatest = function () { if (latestSpec) copySource(latestSpec, "ver"); };
    var copyWebCmd = function () { if (webCmd) copySource(webCmd, "cmd"); };
    var checkLabel = checking
      ? t("ver.checking")
      : update.error
        ? t("ver.checkFailed") + "：" + update.error
        : update.checkedAt
          ? t("ver.checkedAgo", { n: String(checkedMinutes) })
          : t("ver.check");
    var titlebar = h("div", { className: "dbh-titlebar" },
      h("h2", { className: "dbh-title" }, t("title")),
      pluginVersion ? h("span", { className: "dbh-ver", title: dshVersion ? "DSH " + dshVersion : "" }, "v" + pluginVersion) : null,
      h("span", { className: "dbh-grow" }),
      update.hasUpdate ? h("button", {
        type: "button", className: "dbh-updatelink",
        // Clicking EXPANDS the panel below; the copy control is inside it.
        title: t("ver.linkHint"),
        onClick: function () { setUpdateOpen(!updateOpen); },
      }, "↑ " + t("ver.link", { v: update.latest })) : null,
      h("button", {
        type: "button", className: "dbh-vercheck", disabled: checking,
        title: checkLabel, "aria-label": t("ver.check"),
        onClick: function () { runUpdateCheck(true); },
      }, h(RefreshIcon, { size: 12 })));

    // Update guidance, expanded on demand: the Host names the runtime (web or
    // desktop) because the two profiles update differently. Neutral panel — the
    // old red "error" styling made users think something had broken.
    var updateView = null;
    if (updateOpen && update.hasUpdate) {
      updateView = h("div", { className: "dbh-updatepanel" },
        h("div", { className: "dbh-updaterow" },
          h("code", { className: "dbh-spec" }, latestSpec),
          h("button", {
            type: "button", className: "dbh-linkbtn",
            title: t("ver.copySpec", { v: update.latest }),
            onClick: copyLatest,
          }, copiedKey === "ver" ? t("copy.ok") : t("ver.copy"))),
        h("div", { className: "dbh-hint" }, runtime === "desktop"
          ? t("ver.desktopHint", { v: update.latest })
          : runtime === "web"
            ? t("ver.webHint", { v: update.latest })
            : t("ver.genericHint", { v: update.latest })),
        runtime !== "desktop" && webCmd ? h("div", { className: "dbh-updaterow" },
          h("code", { className: "dbh-spec" }, webCmd),
          h("button", { type: "button", className: "dbh-linkbtn", onClick: copyWebCmd },
            copiedKey === "cmd" ? t("copy.ok") : t("ver.copyCmd"))) : null,
        h("a", {
          className: "dbh-link",
          href: "https://github.com/mr-mihu/dsh-dbhub-live/releases/tag/v" + update.latest,
          target: "_blank", rel: "noreferrer noopener",
        }, t("ver.releaseNotes")));
    }

    // One status line: state + connection count (+ the dialog's 设置 toggle).
    var statusline = h("div", { className: "dbh-statusline" },
      h("span", { className: "dbh-dot" + (enabled ? "" : " dbh-dot-off"), "aria-hidden": true }),
      h("span", null, statusText),
      h("span", { className: "dbh-statussep" }, "·"),
      h("span", null, connSummary),
      h("span", { className: "dbh-grow" }),
      !isWide ? h("button", {
        type: "button", className: "dbh-linkbtn",
        "aria-expanded": settingsOpen,
        onClick: toggleSettings,
      }, t("settings.toggle") + (settingsOpen ? " ▴" : " ▾")) : null);
    var errorLine = lastError ? h("div", { className: "dbh-error" }, lastError) : null;
    // The refusal of the last card command: same styling as a Host error, its own
    // node so it never hides the persisted lastError.
    var noticeLine = opNotice ? h("div", { className: "dbh-error dbh-notice", role: "alert" }, opNotice) : null;
    // The host is older than the supported minimum. A normal block in the page
    // flow (never an overlay, never a disabled page): the user must be able to
    // read their connections and the fix sentence at the same time.
    var tooOldLine = dshTooOld ? h("div", { className: "dbh-warncard dbh-tooold", role: "alert" },
      h("div", { className: "dbh-warncard-title" }, t("dsh.tooOldTitle")),
      h("div", { className: "dbh-hint" }, t("dsh.tooOld", { min: dshMinVersion, v: dshVersion || "?" }))) : null;

    // Technical details live here, collapsed, so the rows above stay actionable.
    var notesView = h("div", { className: "dbh-notes" },
      h("div", null, t("note.tools", { n: String(toolCount) })),
      h("div", null, t("note.update")),
      h("div", null, t("note.sidebar")),
      h("div", null, t("note.policy")),
      h("div", null, t("note.version", {
        plugin: pluginVersion || "?",
        dsh: dshVersion || "?",
        runtime: runtime === "desktop" ? t("ver.runtimeDesktop") : t("ver.runtimeWeb"),
      })),
      capHint ? h("div", null, capHint) : null);

    // Shared settings rows: the wide page shows them directly, the dialog behind
    // its 设置 toggle. Controls are the harness's own Switch primitive; the state
    // word (显示/隐藏, 启用/停用, 开启/关闭) sits next to it so the row's meaning
    // never depends on a colour or a tick alone.
    // The four settings controls, shared by the wide one-line bar and the narrow
    // stacked rows so both surfaces write through the same callbacks.
    // One shared hint for every settings surface (wide bar, stacked rows): the
    // same save must produce the same feedback wherever it was clicked. A failure
    // is the global `.dbh-writefail` line — and it suppresses this tick, because
    // "已保存 ✓" beside a failure IS the bug.
    var savedHint = function () {
      return saved && !writeError ? h("span", { className: "dbh-saved" }, t("saved.ok")) : null;
    };

    var ctlEnable = function () {
      return switchControl({
        checked: enabled, ariaLabel: t("row.enable"),
        // A refused enable/disable must not look applied either.
        onChange: function (next) { runSettingWrite(function () { return props.setEnabled(next); }); },
      });
    };
    var ctlSidebar = function () {
      return switchControl({
        checked: draft.showSidebarEntry !== false, ariaLabel: t("row.sidebar"),
        title: t("cfg.sidebarHint"), onChange: toggleSidebar,
      });
    };
    var ctlPolicy = function () {
      return switchControl({
        checked: draft.announceAccessPolicy !== false, ariaLabel: t("row.policy"),
        title: t("cfg.policyHint"), onChange: togglePolicy,
      });
    };
    var ctlInterval = function () {
      return [
        h("input", {
          key: "input", className: "dbh-input dbh-srow-input", type: "number", min: "0",
          "aria-label": t("row.update"), title: t("cfg.updateHint"),
          value: typeof draft.updateIntervalDays === "string" ? draft.updateIntervalDays : "",
          onChange: function (e) {
            setSaved(false);
            setInvalid("");
            draftEdited.current = true;
            setDraft(Object.assign({}, draft, { updateIntervalDays: e.target.value }));
          },
        }),
        h("span", { key: "unit", className: "dbh-srow-unit" }, t("unit.days")),
        h("button", { key: "save", type: "button", className: "dbh-btn dbh-btn-sm", onClick: saveConfig }, t("btn.save")),
        // The form-level error sits next to the field it belongs to (its own
        // line on the narrow rows, inline on the bar).
        invalid ? h("span", { key: "invalid", className: "dbh-error dbh-invalid", role: "alert" }, invalid) : null,
      ];
    };
    var notesButton = function (labelKey) {
      return h("button", {
        type: "button", className: "dbh-linkbtn",
        "aria-expanded": notesOpen,
        onClick: function () { setNotesOpen(!notesOpen); },
      }, "ⓘ " + t(notesOpen ? "settings.less" : labelKey));
    };

    // Wide page: one compact line so the four controls (and their labels) sit
    // together instead of stretching across the page with a gaping middle. It
    // wraps only when the docked window is genuinely narrow.
    var settingsBar = function (narrow) {
      return h("div", { className: "dbh-settings dbh-settingsbar" + (narrow ? " dbh-barnarrow" : "") },
        h("div", { className: "dbh-barline" },
          h("span", { className: "dbh-bartitle" }, t("settings.title")),
          h("div", { className: "dbh-bargroup" },
            h("span", { className: "dbh-barlabel" }, t("row.enable")),
            h("span", { className: "dbh-barstate" }, t(enabled ? "state.enable" : "state.disable")),
            ctlEnable()),
          h("div", { className: "dbh-bargroup" },
            h("span", { className: "dbh-barlabel" }, t("row.sidebar")),
            h("span", { className: "dbh-barstate" }, t(draft.showSidebarEntry !== false ? "state.show" : "state.hide")),
            ctlSidebar()),
          h("div", { className: "dbh-bargroup" },
            h("span", { className: "dbh-barlabel" }, t("row.policy")),
            h("span", { className: "dbh-barstate" }, t(draft.announceAccessPolicy !== false ? "state.on" : "state.off")),
            ctlPolicy()),
          h("div", { className: "dbh-bargroup" },
            h("span", { className: "dbh-barlabel" }, t("row.update")),
            ctlInterval()),
          h("span", { className: "dbh-grow" }),
          notesButton("settings.notes"),
          savedHint()),
        notesOpen ? notesView : null);
    };

    // Narrow surfaces (dialog + phone): compact rows, still behind the 设置 toggle.
    var settingsRows = function () {
      return h("div", { className: "dbh-settings" },
        h("div", { className: "dbh-settings-title" }, t("settings.title")),
        h("div", { className: "dbh-srow" },
          h("div", { className: "dbh-srow-main" }, h("div", { className: "dbh-srow-title" }, t("row.enable"))),
          h("div", { className: "dbh-srow-ctl" },
            h("span", { className: "dbh-srow-state" }, t(enabled ? "state.enable" : "state.disable")),
            ctlEnable())),
        h("div", { className: "dbh-srow" },
          h("div", { className: "dbh-srow-main" }, h("div", { className: "dbh-srow-title" }, t("row.sidebar"))),
          h("div", { className: "dbh-srow-ctl" },
            h("span", { className: "dbh-srow-state" }, t(draft.showSidebarEntry !== false ? "state.show" : "state.hide")),
            ctlSidebar())),
        h("div", { className: "dbh-srow" },
          h("div", { className: "dbh-srow-main" }, h("div", { className: "dbh-srow-title" }, t("row.policy"))),
          h("div", { className: "dbh-srow-ctl" },
            h("span", { className: "dbh-srow-state" }, t(draft.announceAccessPolicy !== false ? "state.on" : "state.off")),
            ctlPolicy())),
        h("div", { className: "dbh-srow" },
          h("div", { className: "dbh-srow-main" }, h("div", { className: "dbh-srow-title" }, t("row.update"))),
          h("div", { className: "dbh-srow-ctl" }, ctlInterval())),
        h("div", { className: "dbh-settings-foot" },
          notesButton("settings.more"),
          savedHint()),
        notesOpen ? notesView : null);
    };

    // Any non-modal page (left-menu panel, Plugins page) uses the one-line bar,
    // even when the measured column is narrow: a docked/small desktop window used
    // to fall back to four stacked rows ("all buttons in a column"). Only the
    // dialog and the phone keep the stacked form.
    var useSettingsBar = !isMobile && surface !== "modal";
    var settingsPanel = settingsOpen && !useSettingsBar ? settingsRows() : null;
    var configBlock = useSettingsBar ? settingsBar(!isWide) : null;

    var section = h("div", { className: "dbh-sect" },
      h("span", { className: "dbh-secttitle" }, t("conn.title")),
      h("span", { className: "dbh-sectcount" }, t("conn.total", { n: String(workspaces.length), m: String(groups.length) })),
      h("span", { className: "dbh-grow" }),
      layout === "grouped" ? h("button", { type: "button", className: "dbh-btn", onClick: toggleAll },
        allOpen ? t("btn.collapseAll") : t("btn.expandAll")) : null,
      h("button", { type: "button", className: "dbh-btn dbh-btn-primary", onClick: function () { openAdd(""); } },
        t("btn.addConn")));

    var body;
    if (layout === "empty") {
      body = h("div", { className: "dbh-empty" }, t("ws.empty"));
    } else if (layout === "tiled") {
      body = h("div", { className: "dbh-tiles" }, groups.map(tileView));
    } else {
      body = h("div", { className: "dbh-groups" }, groups.map(groupView));
    }

    // The pre-test card is shown for BOTH paths (add panel and the per-row DSN
    // edit), so it lives outside the add panel.
    var pretestView = null;
    if (pretest) {
      var pieces = [];
      if (pretest.pendingNonce) {
        pieces.push(h("div", { className: "dbh-test-ok", key: "pending" }, "⏳ " + t("pretest.checking")));
      } else if (pretest.failMessage) {
        pieces.push(h("div", { className: "dbh-pretest-title", key: "title" }, t("pretest.title")));
        pieces.push(h("div", { className: "dbh-hint", key: "hint" }, t("pretest.failHint")));
        pieces.push(h("div", { className: "dbh-test-fail", key: "msg" }, "✗ " + pretest.failMessage));
        pieces.push(h("div", { className: "dbh-addfoot", key: "btns", style: { justifyContent: "flex-start" } },
          h("button", { type: "button", className: "dbh-btn dbh-btn-danger", onClick: cancelPretest }, t("pretest.cancel")),
          h("button", { type: "button", className: "dbh-btn dbh-btn-primary", onClick: confirmSave }, t("pretest.saveOk"))));
      }
      pretestView = h("div", { className: "dbh-pretest" }, pieces);
    }

    // Shown INSTEAD of the pre-test card: the write has not been dispatched yet.
    var overwriteView = null;
    if (overwrite) {
      var hitRows = overwrite.hit.rows || [];
      var first = hitRows[0] || {};
      var targetEnv = normalizeEnvForCompare(overwrite.form.env);
      var detail = overwrite.hit.confident
        ? t("ovr.body", { ws: String(first.title || ""), env: targetEnv, conn: String(first.conn || "") })
        : t("ovr.bodyAmbiguous", {
          env: targetEnv,
          list: hitRows.map(function (r) { return String(r.title || "") + " / " + String(r.env || ""); }).join("、"),
        });
      overwriteView = h("div", { className: "dbh-warncard", role: "alert" },
        h("div", { className: "dbh-warncard-title" }, t("ovr.title")),
        h("div", { className: "dbh-hint" }, detail),
        h("div", { className: "dbh-addfoot", style: { justifyContent: "flex-start" } },
          h("button", { type: "button", className: "dbh-btn", onClick: cancelOverwrite }, t("ovr.cancel")),
          h("button", { type: "button", className: "dbh-btn dbh-btn-primary", onClick: confirmOverwrite }, t("ovr.confirm"))));
    }

    // Asking before an irreversible write, exactly like the overwrite gate.
    var removeView = null;
    if (pendingRemove) {
      removeView = h("div", { className: "dbh-warncard dbh-delcard", role: "alert" },
        h("div", { className: "dbh-warncard-title" }, t("del.title")),
        h("div", { className: "dbh-hint" }, t("del.body", { env: String(pendingRemove.w.env || "") })),
        h("div", { className: "dbh-addfoot", style: { justifyContent: "flex-start" } },
          h("button", { type: "button", className: "dbh-btn", onClick: cancelRemove }, t("del.cancel")),
          h("button", { type: "button", className: "dbh-btn dbh-btn-danger", onClick: confirmRemove }, t("del.confirm"))));
    }

    var addPanel = null;
    if (addOpen) {
      var fields = [];
      if (addTarget) {
        fields.push(h("div", { className: "dbh-field", key: "ws" },
          h("span", { className: "dbh-label" }, t("add.ws")),
          h("span", { className: "dbh-target", title: addTarget }, addTarget)));
      } else {
        fields.push(h("label", { className: "dbh-field", key: "ws" },
          h("span", { className: "dbh-label" }, t("add.ws")),
          h("input", {
            className: "dbh-input", list: "dbh-ws-list",
            placeholder: t("ws.placeholder"),
            value: addForm.ws,
            onChange: function (e) { setAddForm(Object.assign({}, addForm, { ws: e.target.value })); },
          })));
      }
      fields.push(h("label", { className: "dbh-field", key: "env" },
        h("span", { className: "dbh-label" }, t("add.env")),
        h("input", {
          className: "dbh-input",
          placeholder: t("env.placeholder"),
          value: addForm.env,
          onChange: function (e) { setAddForm(Object.assign({}, addForm, { env: e.target.value })); },
        })));
      fields.push(h("label", { className: "dbh-field", key: "dsn" },
        h("span", { className: "dbh-label" }, t("add.dsn")),
        h("input", {
          className: "dbh-input",
          placeholder: t("dsn.placeholder"),
          value: addForm.dsn,
          onChange: function (e) { setAddForm(Object.assign({}, addForm, { dsn: e.target.value })); },
        })));
      // Options come AFTER the DSN input: the offscreen gate pins the field count
      // and the 0..2 input indices inside the add panel, so nothing may be
      // inserted before the DSN box.
      var updateAdd = function (patch) { setAddForm(Object.assign({}, addForm, patch)); };
      fields.push(h("div", { className: "dbh-row", key: "ro" }, roCheck(addForm, updateAdd, "add")));
      fields.push(advPanel(addForm, updateAdd, "add", function () {
        return { ws: addTarget || String(addForm.ws || "").trim(), env: String(addForm.env || "").trim() || "default" };
      }));
      if (capHint) fields.push(h("div", { className: "dbh-hint", key: "cap" }, capHint));
      fields.push(h("div", { className: "dbh-addfoot", key: "foot" },
        h("button", { type: "button", className: "dbh-btn", onClick: closeAdd }, t("btn.cancel")),
        h("button", {
          type: "button", className: "dbh-btn dbh-btn-primary",
          disabled: pendingPretest,
          onClick: addDsn,
        }, t("btn.add"))));
      addPanel = h("div", { className: "dbh-addpanel" }, fields);
    }

    var wsList = h("datalist", { id: "dbh-ws-list" },
      groups.map(function (g) { return h("option", { key: g.key, value: g.path }, g.title); }));

    var innerClass = "dbh-inner dbh-modern"
      + (isWide ? " dbh-wide" : "")
      + (isMobile ? " dbh-mobile" : "")
      + (surface === "modal" ? " dbh-modal" : "");

    // A failed snapshot read says so and offers the one thing that can help.
    var stateErrorLine = snapshotFailed ? h("div", { className: "dbh-error dbh-loadfail", role: "alert" },
      h("span", null, t("state.failed")),
      h("button", { type: "button", className: "dbh-linkbtn dbh-retry", onClick: retrySnapshot }, t("btn.retry"))) : null;
    // The single visible trace of a refused write.
    var writeFailLine = writeError ? h("div", { className: "dbh-error dbh-writefail", role: "alert" }, writeError) : null;

    return isPage ? h("div", { className: innerClass, ref: innerRefCb },
      titlebar,
      updateView,
      tooOldLine,
      statusline,
      errorLine,
      noticeLine,
      stateErrorLine,
      writeFailLine,
      configBlock || settingsPanel,
      section,
      body,
      overwriteView || removeView || pretestView,
      addPanel,
      wsList) : summaryNode;
  }

  function apply(ctx) {
    console.log("[dsh-dbhub-live] client apply");
    // One scoped stylesheet per page (hover/focus states need real
    // pseudo-classes; an inline style cannot express them).
    ensureStyle();
    var localeSvc = ctx.get("locale");
    // Registering dictionaries is NOT idempotent: the locale service refuses a
    // namespace + locale it already owns. A hot reload re-executes this bundle,
    // so the previous instance must release its dictionaries (below) — and if it
    // could not, the page degrades to the local dictionaries instead of failing
    // the whole plugin half ("locale namespace ... already has locale zh").
    var localeOwned = false;
    var localeDispose = null;
    if (localeSvc) {
      try {
        localeDispose = localeSvc.register(NS, { zh: LOCALE_ZH, en: LOCALE_EN });
        localeOwned = true;
      } catch (e) {
        console.warn("[dsh-dbhub-live] locale namespace busy, falling back to local dictionaries: " + String((e && e.message) || e));
      }
    }
    var t = localeOwned && localeSvc ? localeSvc.bind(NS) : localTranslator(localeSvc);
    if (typeof localeDispose === "function") {
      if (typeof ctx.effect === "function") {
        ctx.effect(function () { return localeDispose; }, "dsh-dbhub-live: locale dictionaries");
      } else if (typeof ctx.on === "function") {
        ctx.on("dispose", function () { try { localeDispose(); } catch (e) { /* disposal must never throw */ } });
      }
    }

    // ── host face: the plugin's authenticated HTTP bridge ──
    //
    // dsh 0.2.x removed the browser's `settingsScope` reader (and 0.1.x, which
    // still had it, is no longer supported). Injecting that service left the
    // entire browser half pending forever — no settings page, no sidebar entry,
    // no Plugins card, and no error anywhere. The bridge is therefore the only
    // face: `/api/dsh-dbhub-live/*`, registered by the Host half through
    // `connection.fetch`.
    var BRIDGE_BASE = "api/dsh-dbhub-live";

    // The face contract: a snapshot of `{ status, value }` plus the write entry
    // points. It holds no credentials, and the only DSN it ever touches is the
    // one the user just typed — which rides the POST body straight to the Host.
    function httpFace() {
      var snapshot = { status: "loading", value: {} };
      var listeners = [];
      var timer = null;
      var liveCount = 0;
      var inflight = false;
      // Monotonic stamps, in TWO independent watermarks — a read and a write
      // answer different questions and must not compete for one slot (R1):
      //   · `seq` / `appliedSeq` order READS. A read is applied only if it is
      //     newer than what the card already shows, and a write claims a stamp
      //     ABOVE everything in flight: a poll that started before the write and
      //     answers after it carries the pre-write view, and publishing that
      //     would undo the user's click.
      //   · `appliedWriteStamp` orders WRITES among themselves. A write answer is
      //     the state AFTER the user's action, so it is NEVER compared with read
      //     stamps: "write dispatched, read dispatched right after, read answers
      //     first, write answers last" gave the read the higher stamp and made
      //     the write's own answer lose, leaving the card on the pre-write value
      //     (with a 已保存 ✓ tick beside it) until the 1.5s poll healed it. Two
      //     overlapping writes still cannot land out of order.
      var seq = 0;
      var appliedSeq = 0;
      var appliedWriteStamp = 0;

      var commit = function (next) {
        snapshot = next;
        var current = listeners.slice();
        for (var i = 0; i < current.length; i++) {
          try { current[i](); } catch (e) { /* a subscriber must not break the face */ }
        }
        return snapshot;
      };
      var publish = function (next, at) {
        var stamp = typeof at === "number" ? at : ++seq;
        if (stamp < appliedSeq) return snapshot;
        appliedSeq = stamp;
        return commit(next);
      };
      /** Apply a WRITE answer: unconditionally, unless a later write already landed. */
      var publishWrite = function (stamp, next) {
        if (stamp < appliedWriteStamp) return snapshot;
        appliedWriteStamp = stamp;
        // Keep reads that were in flight BEFORE this write from resurrecting an
        // older view after it (claimWrite already did this; harmless to repeat).
        if (stamp > appliedSeq) appliedSeq = stamp;
        return commit(next);
      };
      var claimWrite = function () {
        seq += 1;
        if (seq > appliedSeq) appliedSeq = seq;
        return seq;
      };
      /**
       * Settle `p` within WRITE_TIMEOUT_MS, or reject with the SAME localized
       * failure a dead bridge produces (no new "timed out" wording, no claim that
       * the Host refused it). The timer is cleared on both settle paths, so a
       * normal write costs one timer and leaves nothing pending behind it.
       */
      var withWriteTimeout = function (p) {
        if (typeof setTimeout !== "function") return p;
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            timer = null;
            reject(bridgeFail());
          }, WRITE_TIMEOUT_MS);
          var settle = function (fn) {
            return function (v) {
              if (timer !== null) { clearTimeout(timer); timer = null; }
              fn(v);
            };
          };
          p.then(settle(resolve), settle(reject));
        });
      };
      /**
       * Is this a view the card can render? The Host always answers with the
       * whole view object; `undefined`, `null`, `{}` and an array mean the body
       * was mangled on the way (a proxy, a truncated response). Publishing one
       * would paint an EMPTY page: 3 tiles → 0 and every `value.*` flag gone,
       * with 已保存 ✓ still on the row. A missing value is
       * a FAILED read/write, not an empty one (R3).
       */
      var isView = function (v) {
        return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
      };
      // A transport failure (an HTTP status, a dead fetch) has no Host text to
      // show, and the POST body carries the DSN the user just typed — so it
      // becomes a localized line and never echoes a payload. A Host refusal IS
      // text the Host already scrubbed; that one is shown as-is.
      var bridgeFail = function () {
        var err = new Error(t("error.write"));
        err.hostText = false;
        return err;
      };
      var hostFail = function (message) {
        var err = new Error(message || t("error.write"));
        err.hostText = !!message;
        return err;
      };
      var request = function (path, init) {
        if (typeof fetch !== "function") return Promise.reject(bridgeFail());
        return fetch(BRIDGE_BASE + path, init).then(function (res) {
          if (!res || res.ok !== true) throw bridgeFail();
          // A reverse proxy that answers with HTML (a login page, a 502 page) or
          // a truncated body makes `res.json()` throw a raw SyntaxError —
          // "Unexpected token '<', "<!DOCTYPE "… is not valid JSON" in English,
          // straight into the user's face, with the response body quoted. Every
          // parse failure is a TRANSPORT failure: localized, no lower-level text
          // (R4). The two-argument `.then` catches a synchronous throw too.
          return Promise.resolve().then(function () { return res.json(); }).then(
            function (body) { return body; },
            function () { throw bridgeFail(); },
          );
        }).then(function (body) {
          if (!body || body.ok !== true) throw hostFail(body && body.error);
          return body;
        });
      };
      var refresh = function () {
        if (inflight) return Promise.resolve();
        inflight = true;
        var mine = ++seq;
        return request("/state", { headers: { accept: "application/json" } }).then(function (body) {
          // A successful transport with a missing/empty view is a FAILED read,
          // not an empty page (R3): reject into the handler below instead of
          // publishing `{}`.
          if (!isView(body.value)) throw bridgeFail();
          return body.value;
        }).then(
          function (value) { publish({ status: "ready", value: value }, mine); },
          function (e) {
            // A FRESH value object on purpose: React bails out of a state update
            // that carries the same reference, and then the error line would not
            // appear until something else re-rendered the card. The last good
            // rows stay on screen — the page reports the failure, it does not
            // pretend to be empty (that is the `.dbh-loadfail` path, R3).
            publish({ status: "error", value: Object.assign({}, snapshot.value || {}) }, mine);
          },
        ).then(function () { inflight = false; });
      };
      var post = function (path, payload) {
        var mine = claimWrite();
        // No rejection handler: a refused write MUST reach the caller. Adding
        // one here (`noop`) is what made every failure look saved.
        return withWriteTimeout(request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        }).then(function (body) {
          // A write answer without a view is a FAILED write, not a blank page
          // (R3): rejecting keeps the rows, rolls the draft back to the Host
          // value and shows `.dbh-writefail` instead of 已保存 ✓ over an empty
          // card. Nothing is published, so the last good view survives.
          if (!isView(body.value)) throw bridgeFail();
          // The Host answers with the SAME view a publish would carry, so the
          // card updates from its own write without waiting for the next poll —
          // and through `publishWrite`, so a read that started later and answered
          // earlier cannot throw this answer away (R1).
          publishWrite(mine, { status: "ready", value: body.value });
          return body;
        }));
      };
      // Option writes take the sanctioned 0.2.x path first: this plugin's own
      // settings form, addressed by the entry id the Host publishes in its view
      // (`ctx.configForms.get(entryId).set(field, value)`). The bridge route is
      // the fallback — for a deployment without the settings client, and for the
      // 0.1.x line where the form service does not exist. The Host adopts either
      // write into one effective value, so the two surfaces cannot disagree.
      var saveOptions = function (patch) {
        var value = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
        var entryId = typeof value.entryId === "string" ? value.entryId : "";
        var forms = typeof ctx.get === "function" ? ctx.get("configForms") : undefined;
        var form = null;
        if (entryId && forms && typeof forms.get === "function") {
          try { form = forms.get(entryId); } catch (e) { form = null; }
        }
        var keys = patch && typeof patch === "object" ? Object.keys(patch) : [];
        if (!form || typeof form.set !== "function" || keys.length === 0) return post("/options", patch);
        var chain = Promise.resolve(true);
        for (var i = 0; i < keys.length; i++) {
          (function (key) {
            var raw = patch[key];
            if (raw === undefined || raw === null) return;
            chain = chain.then(function (accepted) {
              if (accepted !== true) return false;
              // ONLY an explicit `true` is "the form took this field" (R2). The
              // settings form's `set()` answers `undefined` on several 0.2.x
              // builds; `ok !== false` read that as accepted, so the write went
              // NOWHERE — zero POST, zero verification, 已保存 ✓ on screen. Any
              // other answer (undefined, false, a throw, a rejection) falls back
              // to `POST /options`, which the Host does verify.
              return form.set(key, raw).then(function (ok) { return ok === true; }, function () { return false; });
            });
          })(keys[i]);
        }
        return chain.then(function (accepted) {
          if (accepted !== true) return post("/options", patch);
          // The form committed the profile patch; the Host adopts it and the
          // next read shows the effective value.
          return refresh();
        });
      };
      return {
        t: t,
        getSnapshot: function () { return snapshot; },
        subscribe: function (fn, opts) {
          // Only a rendered page keeps the poll alive (`{live:true}`); the
          // plugin-scope subscription below only needs the value once, so an
          // idle GUI never polls this bridge.
          var live = !!(opts && opts.live);
          listeners.push(fn);
          if (live) liveCount += 1;
          if (live && timer === null && typeof setInterval === "function") {
            timer = setInterval(function () {
              if (typeof document !== "undefined" && document.hidden) return;
              refresh();
            }, 1500);
          }
          if (snapshot.status === "loading") refresh();
          return function () {
            var i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
            if (!live) return;
            liveCount -= 1;
            if (liveCount <= 0) {
              liveCount = 0;
              if (timer !== null) {
                clearInterval(timer);
                timer = null;
              }
            }
          };
        },
        setEnabled: function (value) { return post("/enabled", { enabled: Boolean(value) }); },
        saveConfig: function (patch) { return saveOptions(patch || {}); },
        configOp: function (op) { return post("/op", { op: op || {} }); },
        // One fresh read, used by the "read failed" retry control. It never
        // rejects: a failed read publishes the error status the card renders.
        refresh: function () { return refresh(); },
      };
    }

    var face = httpFace();
    // The page asks for two views (props.view): 'summary' for the one-liner
    // under the title, 'page' for the form. plugins.row.config is keyed by
    // `<package>#<row id>` exactly as the bundle patch declares them.
    var SLOT = "plugins.row.config";
    var SLOT_KEY = "dsh-dbhub-live#dbhub-live";
    ctx.slots.inject(SLOT, function () {
      var reg = ctx.slots.register({ name: SLOT, key: SLOT_KEY, inject: function () { return face; } }, StatusCard);
      console.log("[dsh-dbhub-live] 插件页配置入口已注册: " + SLOT + " key=" + SLOT_KEY);
      return reg;
    });
    // A settings.section is the first-class seat for a page of this kind, and
    // its owner (the settings panel) is core shell: Settings → DBHub works in
    // every deployment, which is also where users look for connection
    // management. The page is the same form the Plugins page renders.
    ctx.slots.inject("settings.section", function () {
      var reg = ctx.slots.register({
        name: "settings.section",
        id: "dbhub",
        order: 40,
        label: function () { return t("title"); },
        locale: NS,
        inject: function () { return face; },
      }, SettingsSectionPanel);
      console.log("[dsh-dbhub-live] 设置页入口已注册: settings.section id=dbhub");
      return reg;
    });
    // The sidebar shortcut is the AND of two independent things:
    //   · the user's `showSidebarEntry` switch — hide the shortcut while the
    //     plugin keeps working (its tools stay available); and
    //   · the plugin's enabled state — a disabled plugin contributes no entry at
    //     all, whatever the switch says.
    // The settings section and the Plugins-row card do NOT depend on this, so
    // neither state can lock anyone out of the configuration.
    var sidebarReg = null;
    var sidebarSlotReady = false;
    var sidebarWanted = function () {
      try {
        var snap = face.getSnapshot();
        var v = snap && typeof snap === "object" && snap.value && typeof snap.value === "object" ? snap.value : {};
        // Positive answers only. "Unknown" (a read that has not answered yet, or
        // one that failed) must NOT register: the sync only fires on a publish,
        // so an entry created from a half-loaded view could sit in the sidebar
        // until the next read — showing a shortcut although the switch is off,
        // or pointing at a page whose bridge is dead. `enabled` must be true.
        return v.enabled === true && v.showSidebarEntry !== false;
      } catch (e) {
        return false;
      }
    };
    var syncSidebar = function () {
      if (!sidebarSlotReady) return;
      var want = sidebarWanted();
      if (want && !sidebarReg) {
        sidebarReg = ctx.slots.register({
          name: "sidebar.panellist",
          id: "dbhub",
          order: 5,
          label: function () { return t("title"); },
          locale: NS,
        }, PanelIcon);
      } else if (!want && sidebarReg) {
        try { sidebarReg(); } catch (e) { /* disposal must never break the page */ }
        sidebarReg = null;
      }
    };
    ctx.slots.inject("sidebar.panellist", function () {
      sidebarSlotReady = true;
      syncSidebar();
      return function () {
        sidebarSlotReady = false;
        if (sidebarReg) {
          try { sidebarReg(); } catch (e) { /* ignore */ }
          sidebarReg = null;
        }
      };
    });
    ctx.slots.inject("main", function () {
      return ctx.slots.register({
        name: "main",
        key: "dbhub",
        locale: NS,
        inject: function () { return face; },
      }, MainPanel);
    });
    face.subscribe(syncSidebar);
  }

  var name = "dsh-dbhub-live";
  // `settingsScope` is deliberately NOT injected: dsh 0.2.x removed the service,
  // and a never-satisfied injection keeps the whole plugin fiber pending (the
  // page, the sidebar entry and the card all disappear silently). The HTTP
  // bridge that replaced it needs no injection at all.
  var inject = ["slots"];

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});