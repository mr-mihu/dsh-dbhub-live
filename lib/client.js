// dsh-dbhub-live — browser half (hand-authored lazy-CJS client bundle).
//
// Packaging contract: the Node client-modules scanner serves
// `exports["./client"]` for every Loader entry declaring `dsh.client`; the
// script must register a lazy CJS factory through `window.__ModuleLoader__.load`
// whose `id` equals the Loader entry name. The factory receives the shared
// `require` (React is a seeded baseline module) and returns the Cordis plugin
// object — `name` / `inject` / `apply`.
//
// The card renders the plugin's live status + configurable options + workspace
// connections from the `dsh-dbhub-live` settings namespace (mirrored by the
// Host half) and writes back through namespace fields: `enabled` (toggle),
// `updateIntervalDays` (options), `configOp` (one-way workspace connection
// commands). Passwords never leave the Host — the mirror only carries
// METADATA summaries (host/port/database).

window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  var react = require("react");
  // Product icon primitives (a baseline platform module) — the chevron the
  // built-in plugin cards use. Falls back to a text glyph if unavailable.
  var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  var ChevronIcon = (primitives && primitives.IconChevronDownOutline14) || function () { return react.createElement("span", null, "▼"); };

  var NS = "dsh-dbhub-live";

  // Locale dictionaries (dsh UI language) + fallback zh translator.
  var LOCALE_ZH = {
    title: "DBHub 数据库工具",
    "phase.running": "运行中",
    "phase.initializing": "初始化中",
    "phase.error": "异常",
    "phase.disabled": "已禁用",
    "mode.oneshot": "一次性连接（每次调用独立进程）",
    "block.status": "状态",
    "block.config": "配置",
    "block.workspaces": "工作区连接",
    "block.add": "添加连接",
    "cell.mode": "工作模式",
    "cell.tools": "工具声明",
    "cell.envs": "环境",
    "cell.error": "最近错误",
    "tools.fixed": "{n} 个（固定）",
    "envs.count": "{n} 个 · 已保存 {m}",
    "cfg.update": "自动更新间隔(天)",
    "cfg.sidebar": "在侧边栏显示入口",
    "cfg.sidebarHint": "打开后左侧栏出现「DBHub 数据库工具」快捷入口；关闭后仍可从 设置 → DBHub 数据库工具 或插件页该行的「配置」进入。",
    "btn.save": "保存配置",
    "btn.add": "添加连接",
    "btn.edit": "修改",
    "btn.cancel": "取消",
    "btn.saved": "保存",
    "btn.delete": "删除",
    "btn.disable": "禁用",
    "btn.enable": "启用",
    "btn.test": "测试",
    "test.testing": "测试中…",
    "test.timeout": "测试超时未返回",
    "saved.ok": "已保存 ✓",
    "badge.saved": "已保存",
    "badge.auto": "自动",
    "ws.source": "来源",
    "ws.env": "环境",
    "ws.srcVal": "source",
    "ws.empty": "暂无已保存或自动发现的连接（可用下方表单添加，或让模型调用 dbhub_configure）。",
    "ws.placeholder": "工作区路径或标题；留空 = 默认当前工作区",
    "env.placeholder": "如 prod / dev / test / 线上 / 测试；默认 default（支持中文）",
    "env.newPlaceholder": "环境名（可改中文名；留空保存为 default）",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "完整 DSN（密码勿泄露给模型）",
    "desc.unconfigured": "未配置连接",
    "desc.environments": "{n} 个环境 · 已保存 {m}",
    "add.ws": "工作区",
    "add.env": "环境名",
    "add.dsn": "连接串 DSN",
    "src.user": "已保存·用户",
    "src.collected": "已保存·扫描",
    "src.copied": "已保存·复制",
    "src.mise": "自动·mise env",
    "src.env": "自动·.env",
    "pretest.title": "校验并保存连接",
    "pretest.checking": "正在测试连接…",
    "pretest.askTest": "测试连接",
    "pretest.skip": "跳过测试直接保存",
    "pretest.saveOk": "保存",
    "pretest.cancel": "取消",
    "pretest.failHint": "测试未通过，但你仍然可以保存（已知晓问题）。",
  };

  var LOCALE_EN = {
    title: "DBHub Database Tools",
    "phase.running": "Running",
    "phase.initializing": "Initializing",
    "phase.error": "Error",
    "phase.disabled": "Disabled",
    "mode.oneshot": "One-shot connection (independent process per call)",
    "block.status": "Status",
    "block.config": "Configuration",
    "block.workspaces": "Workspace connections",
    "block.add": "Add connection",
    "cell.mode": "Mode",
    "cell.tools": "Tool declarations",
    "cell.envs": "Environments",
    "cell.error": "Recent error",
    "tools.fixed": "{n} (fixed)",
    "envs.count": "{n} · {m} saved",
    "cfg.update": "Update interval (days)",
    "cfg.sidebar": "Show the sidebar entry",
    "cfg.sidebarHint": "When on, a DBHub Database Tools shortcut appears in the sidebar; when off the page stays reachable from Settings → DBHub Database Tools and from the plugin row's Configure control.",
    "btn.save": "Save",
    "btn.add": "Add connection",
    "btn.edit": "Edit",
    "btn.cancel": "Cancel",
    "btn.saved": "Save",
    "btn.delete": "Delete",
    "btn.disable": "Disable",
    "btn.enable": "Enable",
    "btn.test": "Test",
    "test.testing": "testing…",
    "test.timeout": "no test result (timed out)",
    "saved.ok": "Saved ✓",
    "badge.saved": "saved",
    "badge.auto": "auto",
    "ws.source": "source",
    "ws.env": "env",
    "ws.srcVal": "source",
    "ws.empty": "No saved or auto-discovered connections yet (add one below or ask the model to run dbhub_configure).",
    "ws.placeholder": "workspace path or title; blank = the current workspace",
    "env.placeholder": "e.g. prod / dev / test / 线上; default = default",
    "env.newPlaceholder": "Environment name (Chinese is fine; blank defaults to default)",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "full DSN (do not reveal the password to the model)",
    "desc.unconfigured": "no connections configured",
    "desc.environments": "{n} environments · {m} saved",
    "add.ws": "Workspace",
    "add.env": "Environment",
    "add.dsn": "DSN",
    "src.user": "saved · user",
    "src.collected": "saved · scan",
    "src.copied": "saved · copied",
    "src.mise": "auto · mise env",
    "src.env": "auto · .env",
    "pretest.title": "Validate & Save Connection",
    "pretest.checking": "Testing connection…",
    "pretest.askTest": "Test connection",
    "pretest.skip": "skip test & save",
    "pretest.saveOk": "Save",
    "pretest.cancel": "Cancel",
    "pretest.failHint": "Connection test failed — you can still save (acknowledge the issue).",
  };

  function tForZh(key, params) {
    var s = LOCALE_ZH[key] || key;
    if (params) {
      for (var k in params) { if (Object.prototype.hasOwnProperty.call(params, k)) s = s.split("{" + k + "}").join(String(params[k])); }
    }
    return s;
  }

  var PHASE_META = {
    initializing: { key: "phase.initializing", emoji: "🟡", color: "#b58900" },
    running: { key: "phase.running", emoji: "🟢", color: "#2f9e44" },
    error: { key: "phase.error", emoji: "🔴", color: "#e03131" },
    disabled: { key: "phase.disabled", emoji: "⚪", color: "#868e96" },
  };

  var SOURCE_LABEL_ZH = {
    "persisted(user)": "src.user",
    "persisted(collected)": "src.collected",
    "persisted(copied)": "src.copied",
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

  // ── styles (native card look, mirroring the built-in plugin settings cards) ──
  //
  // Visual language copied from the shipped plugins (e.g. dsh-context's
  // settings card): theme tokens with neutral fallbacks, 12px radius, a
  // full-width clickable head (name + desc on the left, chevron on the right)
  // that turns into an open panel (layer-2) once expanded.

  var TOK = {
    layer2: "var(--dsw-alias-bg-layer-2, #f6f8fa)",
    layer3: "var(--dsw-alias-bg-layer-3, #ffffff)",
    borderL2: "var(--dsw-alias-border-l2, #d0d7de)",
    labelPrimary: "var(--dsw-alias-label-primary, #1f2328)",
    labelTer: "var(--dsw-alias-label-tertiary, #6e7781)",
    labelDim: "var(--dsw-alias-label-dimmed, #8b949e)",
  };

  var cardStyle = {
    border: "1px solid " + TOK.borderL2,
    borderRadius: "12px",
    fontFamily: "inherit",
    fontSize: "13px",
    color: TOK.labelPrimary,
    background: TOK.layer3,
    // Span the full column like the built-in plugin cards (no max width).
    width: "100%",
    boxSizing: "border-box",
    transition: "border-color .16s, background .16s",
  };

  var headStyle = {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    gap: "12px",
    padding: "14px 16px",
    borderRadius: "12px",
  };

  var headTextStyle = {
    display: "flex",
    flexDirection: "column",
    flex: "1",
    gap: "4px",
    minWidth: "0",
  };

  var nameStyle = {
    color: TOK.labelPrimary,
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: "1.4",
  };

  var descStyle = {
    color: TOK.labelTer,
    fontSize: "13px",
    lineHeight: "1.5",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  var chevronWrapStyle = {
    display: "flex",
    flex: "none",
    color: TOK.labelTer,
    transition: "transform .16s",
  };

  var bodyStyle = {
    borderTop: "1px solid " + TOK.borderL2,
    margin: "0 16px",
    padding: "4px 0 12px",
  };

  var blockTitleStyle = {
    fontWeight: 600,
    fontSize: "12px",
    color: TOK.labelTer,
    padding: "10px 0 2px",
  };

  // Group box for the 配置 rows: gives the save button an obvious home.
  var groupStyle = {
    border: "1px solid " + TOK.borderL2,
    borderRadius: "8px",
    background: "var(--dsw-alias-bg-module-platform, #f6f8fa)",
    padding: "6px 12px 8px",
    marginBottom: "4px",
  };

  // Responsive status grid: cells flow to multiple columns when the column
  // is wide enough, and collapse to one per row on narrow screens.
  var statGridStyle = {
    display: "flex",
    flexWrap: "wrap",
    margin: "0 -6px",
  };

  var statCellStyle = {
    boxSizing: "border-box",
    flex: "1 1 45%",
    minWidth: "150px",
    padding: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  };

  var statLabelStyle = { color: TOK.labelTer, fontSize: "11px" };

  var statValueStyle = { color: TOK.labelPrimary, fontSize: "13px", fontWeight: 600, wordBreak: "break-all" };

  var rowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 0",
  };

  var labelStyle = { color: "#57606a", marginRight: "12px" };

  var valueStyle = { fontWeight: 600, textAlign: "right" };

  var errorStyle = {
    color: "#e03131",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: "96px",
    overflow: "auto",
  };

  var toggleStyle = {
    cursor: "pointer",
    borderRadius: "6px",
    border: "1px solid #d0d7de",
    padding: "4px 12px",
    fontSize: "13px",
    color: "#1f2328",
    background: "#f6f8fa",
  };

  var dangerStyle = Object.assign({}, toggleStyle, { color: "#e03131", borderColor: "#f0b8b8" });

  var inputStyle = {
    marginLeft: "12px",
    width: "150px",
    borderRadius: "4px",
    border: "1px solid #d0d7de",
    padding: "4px 6px",
    fontSize: "13px",
    color: "#1f2328",
    background: "#ffffff",
    textAlign: "right",
  };

  var wideInputStyle = Object.assign({}, inputStyle, { width: "100%", textAlign: "left", marginLeft: "0", boxSizing: "border-box" });

  var saveRowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "6px 0 0",
  };

  var savedStyle = { color: "#2f9e44", fontSize: "12px" };

  var wsRowStyle = {
    padding: "5px 0",
    borderBottom: "1px dashed #eef1f4",
  };

  var wsTitleStyle = { fontWeight: 600, fontSize: "12px" };

  var wsMetaStyle = { color: "#57606a", fontSize: "12px", wordBreak: "break-all" };

  var autoBadgeStyle = { color: "#b58900", fontSize: "11px", border: "1px solid #e6d69a", borderRadius: "4px", padding: "0 4px", marginLeft: "6px" };

  var savedBadgeStyle = { color: "#2f9e44", fontSize: "11px", border: "1px solid #b7d8bf", borderRadius: "4px", padding: "0 4px", marginLeft: "6px" };

  // Transient connection-test report (green ok / red fail; wraps when long).
  var testOkStyle = { color: "#2f9e44", fontSize: "12px", wordBreak: "break-all" };

  var testFailStyle = { color: "#e03131", fontSize: "12px", wordBreak: "break-all" };

  var srcStyle = {
    color: "#8b949e",
    fontFamily: "monospace",
    fontSize: "11px",
    wordBreak: "break-all",
  };

  // ── pre-test confirm dialog (inline, inside the card body) ─────────────────
  var pretestCardStyle = {
    border: "1px solid #e03131",
    borderRadius: "8px",
    background: "#fff5f5",
    padding: "10px 12px",
    marginBottom: "6px",
  };
  var pretestTitleStyle = { fontWeight: 600, fontSize: "13px", color: "#e03131", marginBottom: "6px" };
  var pretestHintStyle = { fontSize: "12px", color: "#57606a", marginBottom: "6px", lineHeight: "1.5" };
  var pretestBtnRow = { display: "flex", gap: "6px", flexWrap: "wrap" };

  // ── the settings page (this plugin's own section) ────────────────────────

  var panelStyle = {
    boxSizing: "border-box",
    height: "100%",
    width: "100%",
    maxWidth: "960px",
    margin: "0 auto",
    padding: "28px clamp(16px, 4vw, 40px) 48px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    overflow: "auto",
    color: TOK.labelPrimary,
    fontFamily: "inherit",
  };

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
  // management form the Plugins page renders in its 'page' view, in its own
  // scroll container.
  function ConfigPanel(props) {
    return react.createElement("div", { style: panelStyle },
      react.createElement(StatusCard, Object.assign({}, props, { view: "page" })));
  }

  // ── the card (single collapse: header shows status + toggle; expand to manage) ──

  function StatusCard(props) {
    var loaded = react.useState(function () { return valueOf(props.getSnapshot()); });
    var value = loaded[0];
    var setValue = loaded[1];

    react.useEffect(function () {
      return props.subscribe(function () { setValue(valueOf(props.getSnapshot())); });
    }, []);

    // The plugins page asks every configuration entry for two views: `summary`
    // is the one-liner under the plugin title, `page` is the form with its own
    // save control (the page draws the title, icon and crumb itself).
    var isPage = props.view !== "summary";
    var openState = react.useState(false);
    var open = openState[0] || isPage;
    var setOpen = openState[1];

    var t = props.t || tForZh;
    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "running") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = t("mode." + (value.mode || "oneshot"));
    var workspaces = workspacesOf(value);
    var savedCount = workspaces.filter(function (w) { return w.persisted; }).length;
    var descText = workspaces.length > 0
      ? t("desc.environments", { n: String(workspaces.length), m: String(savedCount) })
      : t("desc.unconfigured");
    if (!isPage) {
      return react.createElement("span", { style: descStyle },
        meta.emoji + " " + t(meta.key) + " · " + t("tools.fixed", { n: String(toolCount) }) + " · " + descText);
    }

    var draftState = react.useState(function () {
      return {
        updateIntervalDays: typeof value.updateIntervalDays === "number" ? String(value.updateIntervalDays) : "7",
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

    // A switch applies at once (it is not a draft value): the sidebar entry is
    // registered/disposed live from the mirrored option.
    var toggleSidebar = function (next) {
      setDraft(Object.assign({}, draft, { showSidebarEntry: next }));
      setSaved(false);
      props.saveConfig({ showSidebarEntry: next });
    };

    // ── pre-test + confirm dialog for add/edit ─────────────────────────────────
    //
    // Both the add form and the edit form now gate saves behind a live connection
    // probe.  Flow:
    //   1. User clicks "添加" / "保存" → dispatch op:"test" with the raw DSN
    //      (host accepts `dsn` in test op so no row needs to exist yet).
    //   2. The form stays visible; status line shows "正在测试连接…".
    //   3. Host responds → if ok, save immediately; if fail, show an inline
    //      confirm card ("连接失败，是否仍要保存？") with the fail reason.
    //   4. User clicks "仍要保存" (force) or "取消" → clear pretest state.
    var pretestState = react.useState(null);
    var pretest = pretestState[0];
    var setPretest = pretestState[1];
    // The pretest report is consumed through the SAME effect that handles the
    // per-row tests (the proven path). `pretestRef` mirrors the current pretest
    // state so the effect always sees the latest shape; a stale report for an
    // already-finished pretest is ignored by the nonce guard.
    var pretestRef = react.useRef(null);
    pretestRef.current = pretest;

    var addState = react.useState({ ws: "", env: "default", dsn: "" });
    var addForm = addState[0];
    var setAddForm = addState[1];
    var addDsn = function () {
      if (!addForm.dsn.trim()) return;
      dispatchPretest({ ws: addForm.ws.trim(), env: addForm.env.trim() || "default", dsn: addForm.dsn.trim() });
    };

    var editState = react.useState(null);
    var editing = editState[0];
    var setEditing = editState[1];
    // An edit can change the DSN, the environment NAME, or both. A name-only
    // change is a rename (no connection data to verify); a DSN change keeps the
    // pre-test gate and carries the rename along in the SAME host op — two
    // configOp writes would race on the single `configOp` namespace field.
    var saveEdit = function (row) {
      if (!editing) return;
      var newEnv = String(editing.env || "").trim() || "default";
      var dsn = String(editing.dsn || "").trim();
      var renaming = newEnv !== row.env;
      if (!dsn) {
        if (renaming) {
          props.configOp({ op: "rename", workspace: row.path, env: row.env, newEnv: newEnv });
          setEditing(null);
        }
        return;
      }
      dispatchPretest({ ws: row.path, env: newEnv, dsn: dsn, _editRow: row, _renameFrom: renaming ? row.env : "" });
    };

    // Dispatch a raw-DSN pre-test and record the nonce so the test-result
    // mirror callback can route it back here.  Pretest nonces are prefixed
    // "pretest:" so the regular useEffect skips them.
    var dispatchPretest = function (form) {
      var nonce = "pretest:" + (form.ws || "") + "|" + (form.env || "default") + "|" + Date.now();
      nonceKeys.current[nonce] = nonce;
      setPretest({ form: form, pendingNonce: nonce, failMessage: null });
      props.configOp({ op: "test", dsn: form.dsn, workspace: form.ws || undefined, env: form.env || "default", nonce: nonce });
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
      }, 30000);
    };

    var confirmSave = function () {
      if (!pretest) return;
      var f = pretest.form;
      var op = { op: "add", workspace: f.ws || undefined, env: f.env || "default", dsn: f.dsn.trim() };
      if (f._renameFrom) op.renameFrom = f._renameFrom;
      props.configOp(op);
      if (f._editRow) { setEditing(null); }
      else { setAddForm({ ws: "", env: "default", dsn: "" }); }
      setPretest(null);
    };
    var cancelPretest = function () { setPretest(null); };

    // ── end pre-test ───────────────────────────────────────────────────────

    // ── connection test (transient feedback) ──
    //
    // The host answers every `{op:"test"}` with a one-shot report keyed by the
    // nonce WE dispatched: unknown/stale nonces are ignored, results auto-fade,
    // and a reload drops the whole local map — the outcome (success or
    // failure) is feedback for this click only, never a persisted status, and
    // a failing test never marks or restricts the connection in any way.
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
        next[key] = { phase: "testing", nonce: nonce };
        return next;
      });
      props.configOp({ op: "test", workspace: row.path, env: row.env, nonce: nonce });
      // Backstop: the host reports on every path (incl. failures); if the
      // mirror never carries our nonce back, surface a timeout, don't spin.
      testTimers.current[nonce] = setTimeout(function () {
        if (!nonceKeys.current[nonce]) return;
        finishTest(key, nonce, false, t("test.timeout"));
      }, 30000);
    };
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
          // Test passed — save immediately.
          props.configOp({ op: "add", workspace: f.ws || undefined, env: f.env || "default", dsn: f.dsn.trim() });
          if (f._editRow) { setEditing(null); }
          else { setAddForm({ ws: "", env: "default", dsn: "" }); }
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
      };
    }, []);

    // Header row: in the page view the plugins page already draws the title,
    // so only the status line + toggle remain (no collapse — the form is the
    // page). The summary view never reaches here.
    var descText = (workspaces.length > 0
      ? t("desc.environments", { n: String(workspaces.length), m: String(savedCount) })
      : t("desc.unconfigured"));
    var hoverState = react.useState(false);
    var hover = hoverState[0];
    var setHover = hoverState[1];
    var cardStateStyle = Object.assign({}, cardStyle, open
      ? { background: TOK.layer2, borderColor: TOK.labelDim }
      : hover ? { borderColor: TOK.labelDim }
        : undefined);
    var toggleButton = react.createElement("button", {
      type: "button",
      style: enabled ? Object.assign({}, toggleStyle, { color: "#2f9e44", borderColor: "#b7d8bf", background: "#ecf7ef", flex: "none" }) : Object.assign({}, toggleStyle, { flex: "none" }),
      onClick: function (e) { e.stopPropagation(); props.setEnabled(!enabled); },
      title: t(enabled ? "btn.disable" : "btn.enable") + " plugin",
    }, t(enabled ? "btn.disable" : "btn.enable"));
    var header = isPage
      ? react.createElement("div", { style: headStyle },
          react.createElement("span", { style: headTextStyle },
            react.createElement("span", { style: descStyle }, meta.emoji + " " + t(meta.key) + " · " + descText)),
          toggleButton)
      : react.createElement("div", {
          style: headStyle,
          onClick: function () { setOpen(!open); },
        },
          react.createElement("span", { style: headTextStyle },
            react.createElement("span", { style: nameStyle }, t("title")),
            react.createElement("span", { style: descStyle },
              meta.emoji + " " + t(meta.key) + " · " + descText)),
          toggleButton,
          react.createElement("span", { style: Object.assign({}, chevronWrapStyle, open ? { transform: "rotate(180deg)" } : {}) },
            react.createElement(ChevronIcon, null)));

    if (!open) {
      return react.createElement("div", { style: cardStateStyle, onMouseEnter: function () { setHover(true); }, onMouseLeave: function () { setHover(false); } }, header);
    }

    // Responsive status grid cells (multi-column when the column is wide).
    var cell = function (key, label, valueNode, full) {
      return react.createElement("div", { key: key, style: Object.assign({}, statCellStyle, full ? { flex: "1 1 100%" } : undefined) },
        react.createElement("span", { style: statLabelStyle }, label),
        react.createElement("span", { style: Object.assign({}, statValueStyle, full ? errorStyle : undefined) }, valueNode));
    };
    var statusCells = [
      cell("mode", t("cell.mode"), modeLabel),
      cell("tools", t("cell.tools"), t("tools.fixed", { n: String(toolCount) })),
      cell("envs", t("cell.envs"), t("envs.count", { n: String(workspaces.length), m: String(savedCount) })),
    ];
    if (lastError) {
      statusCells.push(cell("error", t("cell.error"), lastError, true));
    }

    var configRows = [
      react.createElement("div", { key: "updateIntervalDays", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: t("cfg.update") }, t("cfg.update")),
        react.createElement("input", {
          type: "number", min: "0", style: inputStyle,
          value: typeof draft.updateIntervalDays === "string" ? draft.updateIntervalDays : "",
          onChange: function (e) { setSaved(false); setDraft(Object.assign({}, draft, { updateIntervalDays: e.target.value })); },
        })),
      react.createElement("div", { key: "showSidebarEntry", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: t("cfg.sidebarHint") }, t("cfg.sidebar")),
        react.createElement("input", {
          type: "checkbox",
          checked: draft.showSidebarEntry !== false,
          onChange: function (e) { toggleSidebar(e.target.checked); },
        })),
      react.createElement("div", { key: "save", style: saveRowStyle },
        saved ? react.createElement("span", { key: "saved", style: savedStyle }, t("saved.ok")) : null,
        react.createElement("button", { type: "button", style: toggleStyle, onClick: saveConfig }, t("btn.save"))),
    ];

    var wsRows = workspaces.map(function (w) {
      var key = w.path + "|" + w.env;
      var sourceText = SOURCE_LABEL_ZH[w.source] ? t(SOURCE_LABEL_ZH[w.source]) : (w.source || t(w.persisted ? "badge.saved" : "badge.auto"));
      var isEditing = editing && editing.key === key;
      var badgeEl = react.createElement("span", { style: w.persisted ? savedBadgeStyle : autoBadgeStyle }, w.persisted ? t("badge.saved") : t("badge.auto"));
      var titleRow = react.createElement("div", { style: rowStyle },
        react.createElement("span", { style: wsTitleStyle }, w.title, badgeEl),
        react.createElement("span", { style: wsMetaStyle }, t("ws.env") + ": " + w.env));
      var metaRow = react.createElement("div", { style: rowStyle },
        react.createElement("span", { style: srcStyle }, t("ws.srcVal") + ": " + (w.srcId || "")),
        react.createElement("span", { style: wsMetaStyle }, t("ws.source") + ": " + sourceText));
      var testEntry = tests[key];
      var isTesting = testEntry && testEntry.phase === "testing";
      var actionsRow = react.createElement("div", { style: rowStyle },
        react.createElement("span", { style: wsMetaStyle, title: w.conn }, "🔒 " + w.conn),
        react.createElement("span", null,
          react.createElement("button", {
            type: "button",
            style: Object.assign({}, toggleStyle, { marginRight: "6px", opacity: isTesting ? 0.6 : 1 }),
            disabled: isTesting,
            onClick: function () { startTest(w, key); },
          }, isTesting ? t("test.testing") : t("btn.test")),
          react.createElement("button", { type: "button", style: toggleStyle, onClick: function () { setEditing(isEditing ? null : { key: key, dsn: "", env: w.env }); } }, isEditing ? t("btn.cancel") : t("btn.edit")),
          w.persisted ? react.createElement("button", { type: "button", style: dangerStyle, onClick: function () { props.configOp({ op: "remove", workspace: w.path, env: w.env }); } }, t("btn.delete")) : null));
      var editRow = isEditing ? react.createElement("div", { style: rowStyle },
        react.createElement("input", {
          style: Object.assign({}, wideInputStyle, { flex: "0 0 150px" }),
          placeholder: t("env.newPlaceholder"),
          value: typeof editing.env === "string" ? editing.env : w.env,
          onChange: function (e) { setEditing(Object.assign({}, editing, { env: e.target.value })); },
        }),
        react.createElement("input", { style: wideInputStyle, placeholder: t("dsn.editPlaceholder"), value: editing.dsn, onChange: function (e) { setEditing(Object.assign({}, editing, { dsn: e.target.value })); } }),
        react.createElement("button", { type: "button", style: Object.assign({}, toggleStyle, { marginLeft: "8px" }), onClick: function () { saveEdit(w); } }, t("btn.saved"))) : null;
      var testRow = testEntry && testEntry.phase === "done"
        ? react.createElement("div", { style: { padding: "2px 0" } },
            react.createElement("span", { style: testEntry.ok ? testOkStyle : testFailStyle }, (testEntry.ok ? "✓ " : "✗ ") + testEntry.message))
        : null;
      return react.createElement("div", { key: key, style: wsRowStyle }, titleRow, metaRow, actionsRow, editRow, testRow);
    });

    if (wsRows.length === 0) {
      wsRows.push(react.createElement("div", { key: "empty", style: wsMetaStyle, padding: "6px 0" }, t("ws.empty")));
    }

    var addRows = [
      react.createElement("div", { key: "add-ws", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: t("add.ws") }, t("add.ws")),
        react.createElement("input", { style: wideInputStyle, placeholder: t("ws.placeholder"), value: addForm.ws, onChange: function (e) { setAddForm(Object.assign({}, addForm, { ws: e.target.value })); } })),
      react.createElement("div", { key: "add-env", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: t("add.env") }, t("add.env")),
        react.createElement("input", { style: wideInputStyle, placeholder: t("env.placeholder"), value: addForm.env, onChange: function (e) { setAddForm(Object.assign({}, addForm, { env: e.target.value })); } })),
      react.createElement("div", { key: "add-dsn", style: rowStyle },
        react.createElement("span", { style: labelStyle }, t("add.dsn")),
        react.createElement("input", { style: wideInputStyle, placeholder: t("dsn.placeholder"), value: addForm.dsn, onChange: function (e) { setAddForm(Object.assign({}, addForm, { dsn: e.target.value })); } })),
      react.createElement("div", { key: "add-save", style: saveRowStyle },
        react.createElement("button", { type: "button", style: toggleStyle, onClick: addDsn }, t("btn.add"))),
    ];

    // Pretest confirm dialog: shown below the add/edit form when the pre-test
    // has either returned a failure (confirm before save) or is still pending
    // (in-place "testing…" status so the user knows we are working on it).
    var pretestView = null;
    if (pretest) {
      var body = [];
      if (pretest.pendingNonce) {
        body.push(react.createElement("div", { key: "pending", style: testOkStyle }, "⏳ " + t("pretest.checking")));
      } else if (pretest.failMessage) {
        body.push(react.createElement("div", { key: "title", style: pretestTitleStyle }, t("pretest.title")));
        body.push(react.createElement("div", { key: "hint", style: pretestHintStyle }, t("pretest.failHint")));
        body.push(react.createElement("div", { key: "msg", style: testFailStyle }, "✗ " + pretest.failMessage));
        body.push(react.createElement("div", { key: "btns", style: pretestBtnRow },
          react.createElement("button", { type: "button", style: Object.assign({}, dangerStyle, { marginRight: "0" }), onClick: cancelPretest }, t("pretest.cancel")),
          react.createElement("button", { type: "button", style: toggleStyle, onClick: confirmSave }, t("pretest.saveOk"))));
      }
      pretestView = react.createElement("div", { style: pretestCardStyle }, body);
    }

    return react.createElement("div", {
      style: cardStateStyle,
      onMouseEnter: function () { setHover(true); },
      onMouseLeave: function () { setHover(false); },
    },
      header,
      react.createElement("div", { style: bodyStyle },
        react.createElement("div", { style: blockTitleStyle }, t("block.status")),
        react.createElement("div", { style: statGridStyle }, statusCells),
        react.createElement("div", { style: blockTitleStyle }, t("block.config")),
        react.createElement("div", { style: groupStyle }, configRows),
        react.createElement("div", { style: blockTitleStyle }, t("block.workspaces")),
        wsRows,
        pretestView,
        react.createElement("div", { style: blockTitleStyle }, t("block.add")),
        addRows));
  }

  function apply(ctx) {
    console.log("[dsh-dbhub-live] client apply");
    var localeSvc = ctx.get("locale");
    if (localeSvc) localeSvc.register(NS, { zh: LOCALE_ZH, en: LOCALE_EN });
    var t = localeSvc ? localeSvc.bind(NS) : tForZh;
    var settingsScope = ctx.settingsScope;
    var host = settingsScope.bind({ namespace: NS });
    var noop = function () { return undefined; };
    var face = {
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
    // The sidebar shortcut is optional: the `showSidebarEntry` option (the
    // switch on the settings page) registers and disposes the entry LIVE, so
    // turning it off takes effect without a reload and never locks anyone out
    // (Settings and the Plugins row keep working).
    var sidebarReg = null;
    var sidebarSlotReady = false;
    var sidebarWanted = function () {
      try {
        var snap = host.getSnapshot();
        var v = snap && typeof snap === "object" && snap.value && typeof snap.value === "object" ? snap.value : {};
        return v.showSidebarEntry !== false;
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
    host.subscribe(syncSidebar);
  }

  var name = "dsh-dbhub-live";
  var inject = ["slots", "settingsScope"];

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});