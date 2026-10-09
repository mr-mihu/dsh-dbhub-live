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
// connections from whichever host channel this runtime provides: the legacy
// `dsh-dbhub-live` settings namespace (dsh <= 0.1.6) or the plugin's own
// authenticated `/api/dsh-dbhub-live/*` bridge (every line, including 0.2.x,
// which removed the namespace and the `settingsScope` reader). Both carry the
// same view and accept the same writes: `enabled` (toggle), the UI options, and
// one-way workspace connection commands. Passwords never leave the Host — the
// view only carries METADATA summaries (host/port/database).
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
  var EditIcon = pickIcon("IconEditOutline16", "✏");
  var CloseIcon = pickIcon("IconCloseOutline16", "✕");
  var TrashIcon = pickIcon("IconTrashOutline16", "🗑");
  var RunIcon = pickIcon("IconPlayOutline16", "▶");

  var NS = "dsh-dbhub-live";

  // Locale dictionaries (dsh UI language) + fallback zh translator.
  var LOCALE_ZH = {
    title: "DBHub 数据库工具",
    "phase.running": "运行中",
    "phase.initializing": "初始化中",
    "phase.error": "异常",
    "phase.disabled": "已禁用",
    "mode.oneshot": "一次性连接（每次调用独立进程）",
    "tools.fixed": "{n} 个工具（固定）",
    "desc.unconfigured": "未配置连接",
    "desc.environments": "{n} 个环境 · 已保存 {m}",
    "conn.title": "连接",
    "conn.total": "{n} 条 · {m} 个工作区",
    "grp.envs": "{n} 环境 · {m} 已保存",
    "cfg.summary": "自动更新 {n} 天 · 侧边栏入口：{s}",
    "cfg.on": "显示",
    "cfg.off": "隐藏",
    "cfg.update": "自动更新间隔(天)",
    "cfg.sidebar": "在侧边栏显示入口",
    "cfg.sidebarHint": "关闭后左侧栏不再出现「DBHub 数据库工具」快捷入口——但插件照常工作（工具仍可用），本设置页与插件页也始终可进入。注意：点「禁用」会让入口无条件消失，与这个开关无关。",
    "cfg.enabledHint": "侧边栏入口 = 本开关 且 插件处于启用状态。",
    "cfg.disabledHint": "插件已禁用：侧边栏入口已隐藏（与上面的开关无关）。本设置页与插件页仍然可用——点上方的「启用」即可恢复。",
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
    "btn.settings": "设置",
    "btn.expandAll": "全部展开",
    "btn.collapseAll": "全部折叠",
    "btn.copy": "复制 source 值",
    "copy.ok": "已复制",
    "btn.edit": "修改",
    "btn.cancel": "取消",
    "btn.saved": "保存",
    "btn.delete": "删除",
    "btn.disable": "禁用",
    "btn.enable": "启用",
    "btn.test": "测试",
    "test.testing": "测试中…",
    "test.elapsed": "测试中… {s}s",
    "test.timeout": "测试超时未返回",
    "saved.ok": "已保存 ✓",
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
    "mode.oneshot": "One-shot connection (independent process per call)",
    "tools.fixed": "{n} tools (fixed)",
    "desc.unconfigured": "no connections configured",
    "desc.environments": "{n} environments · {m} saved",
    "conn.title": "Connections",
    "conn.total": "{n} · {m} workspaces",
    "grp.envs": "{n} env · {m} saved",
    "cfg.summary": "Auto-update every {n} d · sidebar entry: {s}",
    "cfg.on": "shown",
    "cfg.off": "hidden",
    "cfg.update": "Update interval (days)",
    "cfg.sidebar": "Show the sidebar entry",
    "cfg.sidebarHint": "When off, the “DBHub Database Tools” shortcut no longer appears in the sidebar — the plugin keeps working (its tools stay available) and this settings page plus the Plugins row stay reachable. Note: pressing Disable hides the entry unconditionally, independently of this switch.",
    "cfg.enabledHint": "The sidebar entry = this switch AND the plugin being enabled.",
    "cfg.disabledHint": "The plugin is disabled, so the sidebar entry is hidden (independently of the switch above). This settings page and the Plugins row still work — press Enable above to bring it back.",
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
    "btn.settings": "Settings",
    "btn.expandAll": "Expand all",
    "btn.collapseAll": "Collapse all",
    "btn.copy": "Copy source value",
    "copy.ok": "Copied",
    "btn.edit": "Edit",
    "btn.cancel": "Cancel",
    "btn.saved": "Save",
    "btn.delete": "Delete",
    "btn.disable": "Disable",
    "btn.enable": "Enable",
    "btn.test": "Test",
    "test.testing": "testing…",
    "test.elapsed": "testing… {s}s",
    "test.timeout": "no test result (timed out)",
    "saved.ok": "Saved ✓",
    "badge.saved": "saved",
    "badge.auto": "auto",
    "ws.env": "env",
    "ws.source": "source",
    "ws.srcHint": "click to copy the source value the model uses to target this connection",
    "ws.autoHint": "(auto-discovered, not saved — edit and save to keep it)",
    "ws.empty": "No connections yet. Use “＋ Add connection” above, or ask the model to run dbhub_configure.",
    "ws.placeholder": "workspace path or title; blank = the current workspace",
    "env.placeholder": "e.g. prod / dev / test / 线上; default = default",
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

  var CSS_TEXT = [
    ".dbh-wrap{box-sizing:border-box;height:100%;width:100%;overflow:auto;padding:22px clamp(14px,3vw,32px) 44px;color:var(--dsw-alias-label-primary);font-family:inherit;}",
    // Content column: capped at 960px, which also caps the tile grid at 3 columns.
    ".dbh-inner{display:flex;flex-direction:column;gap:10px;width:100%;max-width:960px;margin:0 auto;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);font-family:inherit;}",
    ".dbh-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 4px;}",
    ".dbh-headtext{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}",
    ".dbh-statustext{font-size:13px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dbh-error{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-all;max-height:54px;overflow:auto;}",
    ".dbh-cfgsum{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
    // Toolbar buttons (rarer, text-labelled): quiet surface + border.
    ".dbh-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;font-size:12px;font-family:inherit;line-height:1;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .14s,border-color .14s,color .14s;white-space:nowrap;}",
    ".dbh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6));}",
    ".dbh-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-btn:disabled{opacity:.55;cursor:default;}",
    ".dbh-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}",
    ".dbh-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);}",
    ".dbh-btn-on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);background:var(--dsw-alias-state-success-tertiary);}",
    ".dbh-btn-danger{color:var(--dsw-alias-state-error-primary);}",
    ".dbh-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}",
    // Row actions: bare 24px icon buttons — no border, no label, no width cost.
    ".dbh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;flex:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .14s,color .14s;}",
    ".dbh-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
    ".dbh-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
    ".dbh-iconbtn:disabled{cursor:default;}",
    ".dbh-iconbtn-busy{opacity:.5;}",
    ".dbh-iconbtn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);}",
    ".dbh-sect{display:flex;align-items:center;gap:8px;padding:8px 0 2px;flex-wrap:wrap;}",
    ".dbh-secttitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}",
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
    ".dbh-conn-lock{flex:none;margin-right:4px;font-size:11px;opacity:.8;}",
    ".dbh-conn-pre{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);}",
    ".dbh-conn-db{flex:none;color:var(--dsw-alias-label-primary);font-weight:600;}",
    ".dbh-acts{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto;}",
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
    ".dbh-num{width:64px;flex:none;text-align:right;}",
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
    ".dbh-strip{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent);}",
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
  function ConfigPanel(props) {
    ensureStyle();
    return h("div", { className: "dbh-wrap" },
      h(StatusCard, Object.assign({}, props, { view: "page" })));
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

    // The plugins page asks every configuration entry for two views: `summary`
    // is the one-liner under the plugin title, `page` is the whole management
    // page. The one-liner stops here (no page-only hooks are reached).
    var isPage = props.view !== "summary";
    var t = props.t || tForZh;
    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "running") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = t("mode." + (value.mode || "oneshot"));
    var workspaces = workspacesOf(value);
    var caps = capsOf(value);
    var capHint = capabilityHint(caps, t);
    var roSupported = caps.readonlyTools !== false;
    var sshSupported = caps.ssh !== false;
    var savedCount = workspaces.filter(function (w) { return w.persisted; }).length;
    var groups = groupRows(workspaces);
    var layout = layoutModeOf(groups);

    if (!isPage) {
      var summary = workspaces.length > 0
        ? t("desc.environments", { n: String(workspaces.length), m: String(savedCount) })
        : t("desc.unconfigured");
      return h("span", { className: "dbh-summary" },
        meta.emoji + " " + t(meta.key) + " · " + t("tools.fixed", { n: String(toolCount) }) + " · " + summary);
    }

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

    // ── config draft (interval + the sidebar switch) ──────────────────────────
    var draftState = react.useState(function () {
      return {
        updateIntervalDays: typeof value.updateIntervalDays === "number" ? String(value.updateIntervalDays) : "7",
        // The user's own "hide the shortcut" preference. Independent of the
        // plugin's enabled state: hiding the entry does NOT disable anything.
        showSidebarEntry: value.showSidebarEntry !== false,
      };
    });
    var draft = draftState[0];
    var setDraft = draftState[1];
    var savedState = react.useState(false);
    var saved = savedState[0];
    var setSaved = savedState[1];

    var saveConfig = function () {
      props.saveConfig({
        updateIntervalDays: Number(draft.updateIntervalDays),
        showSidebarEntry: draft.showSidebarEntry !== false,
      }).then(function () { setSaved(true); });
    };

    // The switch applies immediately (no Save round-trip), like it always has.
    var toggleSidebar = function (next) {
      setDraft(Object.assign({}, draft, { showSidebarEntry: next }));
      setSaved(false);
      props.saveConfig({ showSidebarEntry: next });
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
      // one click produces one atomic store write (and one op for the legacy
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
          props.configOp(withConnDraft({ op: "options", workspace: row.path, env: row.env }, editing));
          setEditing(null);
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
        props.configOp(op);
        setEditing(null);
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
      var form = overwrite.form;
      setOverwrite(null);
      executeWrite(form);
    };
    var cancelOverwrite = function () { setOverwrite(null); };

    // Dispatch a raw-DSN pre-test and record the nonce so the test-result
    // mirror callback can route it back here. Pretest nonces are prefixed
    // "pretest:" so the regular effect branch skips them. The payload carries
    // the draft's options too, so "试连" really validates the tunnel/read-only
    // combination the user is about to save.
    var dispatchPretest = function (form) {
      var nonce = "pretest:" + (form.ws || "") + "|" + (form.env || "default") + "|" + Date.now();
      nonceKeys.current[nonce] = nonce;
      setPretest({ form: form, pendingNonce: nonce, failMessage: null });
      var draft = connDraftOf(draftOf(form));
      var payload = { op: "test", dsn: form.dsn, workspace: form.ws || undefined, env: form.env || "default", nonce: nonce };
      // An edit validates the options the row already has; a brand-new form only
      // asserts what it actually carries (so it cannot clear a stored tunnel).
      if (form._editRow || draft.readOnly === true) payload.readOnly = draft.readOnly === true;
      if (draft.ssh === null) payload.ssh = null;
      else if (draft.ssh) payload.ssh = draft.ssh;
      props.configOp(payload);
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
    };

    /** The `add` payload for one save (options included). */
    var saveOpOf = function (f) {
      var op = withConnDraft({
        op: "add", workspace: f.ws || undefined, env: f.env || "default", dsn: String(f.dsn || "").trim(),
      }, draftOf(f));
      if (f._renameFrom) op.renameFrom = f._renameFrom;
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
      props.configOp(saveOpOf(f));
      finishAddPanel(f);
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
      var nonce = key + "|" + Date.now();
      nonceKeys.current[nonce] = key;
      setTests(function (prev) {
        var next = Object.assign({}, prev);
        // `startedAt` drives the elapsed readout: a probe really can take several
        // seconds, and an unlabelled spinner reads as "hung".
        next[key] = { phase: "testing", nonce: nonce, startedAt: Date.now() };
        return next;
      });
      props.configOp({ op: "test", workspace: row.path, env: row.env, nonce: nonce });
      // Backstop: the host reports on every path (incl. failures); if the
      // mirror never carries our nonce back, surface a timeout, don't spin.
      var tunnelled = !!(row && row.ssh);
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        finishTest(key, nonce, false, t("test.timeout"));
      }, tunnelled ? TEST_WATCHDOG_SSH_MS : TEST_WATCHDOG_MS);
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
      var nonce = key + "|" + Date.now();
      nonceKeys.current[nonce] = key;
      setTests(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = { phase: "testing", nonce: nonce, startedAt: Date.now() };
        return next;
      });
      var d = connDraftOf(form);
      var ssh = d.ssh && typeof d.ssh === "object" ? d.ssh : null;
      if (!ssh) {
        finishTest(key, nonce, false, t("adv.testSshNeedFields"));
        return;
      }
      props.configOp({
        op: "test", kind: "ssh",
        workspace: target.ws || undefined, env: target.env || "default",
        ssh: ssh, nonce: nonce,
      });
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        finishTest(key, nonce, false, t("test.timeout"));
      }, TEST_WATCHDOG_SSH_MS);
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
          props.configOp(saveOpOf(f));
          finishAddPanel(f);
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
    var statusText = meta.emoji + " " + t(meta.key) + " · " + t("tools.fixed", { n: String(toolCount) })
      + (workspaces.length === 0 ? " · " + t("desc.unconfigured") : "");
    var cfgSummary = t("cfg.summary", {
      n: typeof draft.updateIntervalDays === "string" && draft.updateIntervalDays ? draft.updateIntervalDays : "7",
      s: t(draft.showSidebarEntry !== false ? "cfg.on" : "cfg.off"),
    });

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
    // Environment chip: the name plus an inline read-only marker. Never an icon
    // button — the row's action budget stays at three.
    var envChip = function (w) {
      return h("span", { className: "dbh-envname", title: originTitle(w, w.env) },
        w.env,
        w.ro === true ? h("span", { className: "dbh-ro", title: t("ro.title") }, t("ro.chip")) : null);
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
        }, h(RunIcon, { size: 14 })),
        h("button", {
          type: "button", className: "dbh-iconbtn",
          title: isEditing ? t("btn.cancel") : t("btn.edit"),
          "aria-label": isEditing ? t("btn.cancel") : t("btn.edit"),
          onClick: function () {
            setEditing(isEditing ? null : Object.assign({
              key: key, dsn: "", env: w.env, ro: w.ro === true, adv: uiMemory.advOpen === true,
            }, sshDraftOf(w)));
          },
        }, isEditing ? h(CloseIcon, { size: 14 }) : h(EditIcon, { size: 14 })),
        w.persisted ? h("button", {
          type: "button", className: "dbh-iconbtn dbh-iconbtn-danger",
          title: t("btn.delete"),
          "aria-label": t("btn.delete"),
          onClick: function () { props.configOp({ op: "remove", workspace: w.path, env: w.env }); },
        }, h(TrashIcon, { size: 14 })) : null);
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
        h("span", { className: "dbh-conn-lock", "aria-hidden": true }, "🔒"),
        h("span", { className: "dbh-conn-pre" }, parts.prefix),
        parts.tail ? h("span", { className: "dbh-conn-db" }, parts.tail) : null);
    };
    var envRow = function (w) {
      var key = w.path + "|" + w.env;
      return h("div", { className: "dbh-envwrap", key: key },
        h("div", { className: "dbh-envrow" },
          envChip(w),
          connLabelView(w),
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
          connLabelView(w)),
        h("div", { className: "dbh-tileacts" }, rowActions(w, key)),
        editRow(w, key),
        testRow(w, key));
    };

    // ── assemble the page ──
    var head = h("div", { className: "dbh-head" },
      h("div", { className: "dbh-headtext" },
        h("span", { className: "dbh-statustext", title: modeLabel }, statusText),
        lastError ? h("span", { className: "dbh-error" }, lastError) : null),
      h("span", { className: "dbh-cfgsum" }, cfgSummary),
      h("button", { type: "button", className: "dbh-btn", onClick: toggleSettings },
        "⚙ " + t("btn.settings") + (settingsOpen ? " ▴" : " ▾")),
      h("button", {
        type: "button", className: "dbh-btn" + (enabled ? " dbh-btn-on" : ""),
        onClick: function () { props.setEnabled(!enabled); },
      }, t(enabled ? "btn.disable" : "btn.enable")));

    var settingsPanel = settingsOpen ? h("div", { className: "dbh-strip" },
      h("div", { className: "dbh-row" },
        h("span", { className: "dbh-label" }, t("cfg.update")),
        h("input", {
          className: "dbh-input dbh-num", type: "number", min: "0",
          "aria-label": t("cfg.update"),
          value: typeof draft.updateIntervalDays === "string" ? draft.updateIntervalDays : "",
          onChange: function (e) { setSaved(false); setDraft(Object.assign({}, draft, { updateIntervalDays: e.target.value })); },
        }),
        h("span", { className: "dbh-grow" }),
        h("label", { className: "dbh-check", title: t("cfg.sidebarHint") },
          h("input", {
            type: "checkbox", className: "dbh-checkbox",
            checked: draft.showSidebarEntry !== false,
            onChange: function (e) { toggleSidebar(e.target.checked); },
          }),
          h("span", null, t("cfg.sidebar")))),
      // This switch and the plugin's enabled state are ANDed, and they are not
      // the same thing: hiding the shortcut leaves the plugin (and its tools)
      // fully usable, while disabling always hides the entry.
      h("div", { className: "dbh-hint" }, (enabled ? t("cfg.enabledHint") : t("cfg.disabledHint")) + " " + t("cfg.sidebarHint")),
      h("div", { className: "dbh-addfoot" },
        saved ? h("span", { className: "dbh-saved" }, t("saved.ok")) : null,
        h("button", { type: "button", className: "dbh-btn dbh-btn-primary", onClick: saveConfig }, t("btn.save")))) : null;

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

    return h("div", { className: "dbh-inner" },
      head,
      settingsPanel,
      section,
      body,
      overwriteView || pretestView,
      addPanel,
      wsList);
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
    var noop = function () { return undefined; };

    // ── host face: legacy settings scope (dsh <= 0.1.6) or the HTTP bridge ──
    //
    // dsh 0.1.7 replaced the settings namespace with Config-derived forms and
    // 0.2.x removed the browser's `settingsScope` reader. Injecting that service
    // (as this bundle used to) left the entire browser half pending forever on
    // those lines — no settings page, no sidebar entry, no Plugins card, and no
    // error anywhere. The transport is therefore probed, never injected: the
    // plugin's own authenticated bridge (`/api/dsh-dbhub-live/*`, registered by
    // the Host half through `connection.fetch`) serves every runtime, and the
    // legacy scope is used when a 0.1.x client still provides it.
    var BRIDGE_BASE = "api/dsh-dbhub-live";

    function legacyFace(scope) {
      var host = scope.bind({ namespace: NS });
      return {
        t: t,
        getSnapshot: function () { return host.getSnapshot(); },
        subscribe: function (fn) { return host.subscribe(fn); },
        setEnabled: function (value) {
          return host.set("enabled", Boolean(value)).then(noop, noop);
        },
        saveConfig: function (patch) {
          // One path-op write per field; invalid values are rejected host-side
          // (applyPatch backstop) and never break the other fields.
          var keys = patch && typeof patch === "object" ? Object.keys(patch) : [];
          var chain = Promise.resolve();
          for (var i = 0; i < keys.length; i++) {
            (function (key) {
              var raw = patch[key];
              if (raw === undefined || raw === null) return;
              chain = chain.then(function () { return host.set(key, raw).then(noop, noop); });
            })(keys[i]);
          }
          return chain;
        },
        configOp: function (op) {
          // One-way workspace-connection command; the Host applies it, then the
          // republished mirror (without configOp) clears the field.
          return host.set("configOp", JSON.stringify(op || {})).then(noop, noop);
        },
      };
    }

    // The bridge face keeps the contract the namespace face had: a snapshot of
    // `{ value }` plus the four write entry points. It holds no credentials, and
    // the only DSN it ever touches is the one the user just typed — which rides
    // the POST body straight to the Host, exactly as the namespace write did.
    function httpFace() {
      var snapshot = { status: "loading", value: {} };
      var listeners = [];
      var timer = null;
      var liveCount = 0;
      var inflight = false;

      var publish = function (next) {
        snapshot = next;
        var current = listeners.slice();
        for (var i = 0; i < current.length; i++) {
          try { current[i](); } catch (e) { /* a subscriber must not break the face */ }
        }
      };
      var request = function (path, init) {
        if (typeof fetch !== "function") return Promise.reject(new Error("fetch unavailable"));
        return fetch(BRIDGE_BASE + path, init).then(function (res) {
          if (!res || res.ok !== true) throw new Error("bridge HTTP " + (res && res.status));
          return res.json();
        }).then(function (body) {
          if (!body || body.ok !== true) throw new Error((body && body.error) || "bridge refused");
          return body;
        });
      };
      var refresh = function () {
        if (inflight) return Promise.resolve();
        inflight = true;
        return request("/state", { headers: { accept: "application/json" } }).then(
          function (body) { publish({ status: "ready", value: body.value || {} }); },
          function (e) { publish({ status: "error", value: snapshot.value || {} }); },
        ).then(function () { inflight = false; });
      };
      var post = function (path, payload) {
        return request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        }).then(
          // The Host answers with the SAME view a publish would carry, so the
          // card updates from its own write without waiting for the next poll.
          function (body) { publish({ status: "ready", value: body.value || {} }); },
          noop,
        );
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
              if (accepted === false) return false;
              return form.set(key, raw).then(function (ok) { return ok !== false; }, function () { return false; });
            });
          })(keys[i]);
        }
        return chain.then(function (accepted) {
          if (accepted === false) return post("/options", patch);
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
      };
    }

    var legacyScope = typeof ctx.get === "function" ? ctx.get("settingsScope") : undefined;
    var face = legacyScope && typeof legacyScope.bind === "function" ? legacyFace(legacyScope) : httpFace();
    // The page asks for two views (props.view): 'summary' for the one-liner
    // under the title, 'page' for the form. dsh 0.1.6 REMOVED the settings-card
    // slot this bundle used to register (a registration into a missing slot is
    // silently ignored, which is why the card vanished); plugins.row.config is
    // its official replacement and is keyed by `<package>#<row id>` exactly as
    // the bundle patch declares them.
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
      }, ConfigPanel);
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
        return v.enabled !== false && v.showSidebarEntry !== false;
      } catch (e) {
        return true;
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
      }, ConfigPanel);
    });
    face.subscribe(syncSidebar);
  }

  var name = "dsh-dbhub-live";
  // `settingsScope` is deliberately NOT injected: dsh 0.1.7 removed the service
  // from 0.2.x clients, and a never-satisfied injection keeps the whole plugin
  // fiber pending (the page, the sidebar entry and the card all disappear
  // silently). The face probes for it instead.
  var inject = ["slots"];

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});