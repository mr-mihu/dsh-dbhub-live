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
// `updateIntervalDays`/`idleMinutes` (options), `configOp` (one-way workspace
// connection commands). Passwords never leave the Host — the mirror only
// carries masked DSN summaries.

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
    "mode.lazy": "懒加载（首次调用时初始化）",
    "block.status": "状态",
    "block.config": "配置",
    "block.workspaces": "工作区连接",
    "block.add": "添加连接",
    "cell.server": "常驻进程",
    "cell.mode": "工作模式",
    "cell.tools": "工具声明",
    "cell.envs": "环境",
    "cell.error": "最近错误",
    "server.up": "运行中",
    "server.wait": "待启动（按需）",
    "tools.fixed": "{n} 个（固定）",
    "envs.count": "{n} 个 · 已保存 {m}",
    "cfg.update": "自动更新间隔(天)",
    "cfg.idle": "空闲回收(分钟)",
    "btn.save": "保存配置",
    "btn.add": "添加连接",
    "btn.edit": "修改",
    "btn.cancel": "取消",
    "btn.saved": "保存",
    "btn.delete": "删除",
    "btn.disable": "禁用",
    "btn.enable": "启用",
    "saved.ok": "已保存 ✓",
    "badge.saved": "已保存",
    "badge.auto": "自动",
    "ws.source": "来源",
    "ws.env": "环境",
    "ws.srcVal": "source",
    "ws.empty": "暂无已保存或自动发现的连接（可用下方表单添加，或让模型调用 dbhub_configure）。",
    "ws.placeholder": "工作区路径或标题；留空 = 默认当前工作区",
    "env.placeholder": "如 prod / dev / test；默认 default",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "完整 DSN（密码勿泄露给模型）",
    "desc.unconfigured": "未配置连接",
    "desc.connRunning": "常驻运行中",
    "desc.connWaiting": "常驻待启动",
    "desc.environments": "{n} 个环境 · 已保存 {m}",
    "add.ws": "工作区",
    "add.env": "环境名",
    "add.dsn": "连接串 DSN",
    "src.user": "已保存·用户",
    "src.collected": "已保存·扫描",
    "src.mise": "自动·mise env",
    "src.env": "自动·.env",
  };

  var LOCALE_EN = {
    title: "DBHub Database Tools",
    "phase.running": "Running",
    "phase.initializing": "Initializing",
    "phase.error": "Error",
    "phase.disabled": "Disabled",
    "mode.lazy": "Lazy (initialized on first use)",
    "block.status": "Status",
    "block.config": "Configuration",
    "block.workspaces": "Workspace connections",
    "block.add": "Add connection",
    "cell.server": "Server",
    "cell.mode": "Mode",
    "cell.tools": "Tool declarations",
    "cell.envs": "Environments",
    "cell.error": "Recent error",
    "server.up": "running",
    "server.wait": "waiting (on demand)",
    "tools.fixed": "{n} (fixed)",
    "envs.count": "{n} · {m} saved",
    "cfg.update": "Update interval (days)",
    "cfg.idle": "Idle recycle (min)",
    "btn.save": "Save",
    "btn.add": "Add connection",
    "btn.edit": "Edit",
    "btn.cancel": "Cancel",
    "btn.saved": "Save",
    "btn.delete": "Delete",
    "btn.disable": "Disable",
    "btn.enable": "Enable",
    "saved.ok": "Saved ✓",
    "badge.saved": "saved",
    "badge.auto": "auto",
    "ws.source": "source",
    "ws.env": "env",
    "ws.srcVal": "source",
    "ws.empty": "No saved or auto-discovered connections yet (add one below or ask the model to run dbhub_configure).",
    "ws.placeholder": "workspace path or title; blank = the current workspace",
    "env.placeholder": "e.g. prod / dev / test; default = default",
    "dsn.placeholder": "mysql://user:pass@host:3306/db",
    "dsn.editPlaceholder": "full DSN (do not reveal the password to the model)",
    "desc.unconfigured": "no connections configured",
    "desc.connRunning": "server running",
    "desc.connWaiting": "server waiting",
    "desc.environments": "{n} environments · {m} saved",
    "add.ws": "Workspace",
    "add.env": "Environment",
    "add.dsn": "DSN",
    "src.user": "saved · user",
    "src.collected": "saved · scan",
    "src.mise": "auto · mise env",
    "src.env": "auto · .env",
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

  var srcStyle = {
    color: "#8b949e",
    fontFamily: "monospace",
    fontSize: "11px",
    wordBreak: "break-all",
  };

  // ── the card (single collapse: header shows status + toggle; expand to manage) ──

  function StatusCard(props) {
    var loaded = react.useState(function () { return valueOf(props.getSnapshot()); });
    var value = loaded[0];
    var setValue = loaded[1];

    react.useEffect(function () {
      return props.subscribe(function () { setValue(valueOf(props.getSnapshot())); });
    }, []);

    var openState = react.useState(false);
    var open = openState[0];
    var setOpen = openState[1];

    var t = props.t || tForZh;
    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "initializing") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = t("mode." + (value.mode || "lazy"));
    var serverUp = value.serverUp === true;
    var workspaces = workspacesOf(value);
    var savedCount = workspaces.filter(function (w) { return w.persisted; }).length;

    var draftState = react.useState(function () {
      return {
        updateIntervalDays: typeof value.updateIntervalDays === "number" ? String(value.updateIntervalDays) : "7",
        idleMinutes: typeof value.idleMinutes === "number" ? String(value.idleMinutes) : "10",
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
        idleMinutes: Number(draft.idleMinutes),
      }).then(function () { setSaved(true); });
    };

    var addState = react.useState({ ws: "", env: "default", dsn: "" });
    var addForm = addState[0];
    var setAddForm = addState[1];
    var addDsn = function () {
      if (!addForm.dsn.trim()) return;
      props.configOp({ op: "add", workspace: addForm.ws.trim() || undefined, env: addForm.env.trim() || "default", dsn: addForm.dsn.trim() });
      setAddForm({ ws: "", env: "default", dsn: "" });
    };

    var editState = react.useState(null);
    var editing = editState[0];
    var setEditing = editState[1];
    var saveEdit = function (row) {
      if (!editing || !editing.dsn.trim()) return;
      props.configOp({ op: "add", workspace: row.path, env: row.env, dsn: editing.dsn.trim() });
      setEditing(null);
    };

    // Collapsed header (native card look): name + desc on the left, status +
    // toggle + chevron on the right. The chevron is the product icon primitive
    // (rotates when open), mirroring the built-in plugin settings cards.
    var descText = (workspaces.length > 0
      ? t("desc.environments", { n: String(workspaces.length), m: String(savedCount) })
      : t("desc.unconfigured")) +
      (serverUp ? " · " + t("desc.connRunning") : " · " + t("desc.connWaiting"));
    var hoverState = react.useState(false);
    var hover = hoverState[0];
    var setHover = hoverState[1];
    var cardStateStyle = Object.assign({}, cardStyle, open
      ? { background: TOK.layer2, borderColor: TOK.labelDim }
      : hover ? { borderColor: TOK.labelDim }
        : undefined);
    var header = react.createElement("div", {
      style: headStyle,
      onClick: function () { setOpen(!open); },
    },
      react.createElement("span", { style: headTextStyle },
        react.createElement("span", { style: nameStyle }, t("title")),
        react.createElement("span", { style: descStyle },
          meta.emoji + " " + t(meta.key) + " · " + descText)),
      react.createElement("button", {
        type: "button",
        style: enabled ? Object.assign({}, toggleStyle, { color: "#2f9e44", borderColor: "#b7d8bf", background: "#ecf7ef", flex: "none" }) : Object.assign({}, toggleStyle, { flex: "none" }),
        onClick: function (e) { e.stopPropagation(); props.setEnabled(!enabled); },
        title: t(enabled ? "btn.disable" : "btn.enable") + " plugin",
      }, t(enabled ? "btn.disable" : "btn.enable")),
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
      cell("server", t("cell.server"), t(serverUp ? "server.up" : "server.wait")),
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
      react.createElement("div", { key: "idleMinutes", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: t("cfg.idle") }, t("cfg.idle")),
        react.createElement("input", {
          type: "number", min: "1", style: inputStyle,
          value: typeof draft.idleMinutes === "string" ? draft.idleMinutes : "",
          onChange: function (e) { setSaved(false); setDraft(Object.assign({}, draft, { idleMinutes: e.target.value })); },
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
      var actionsRow = react.createElement("div", { style: rowStyle },
        react.createElement("span", { style: wsMetaStyle }, w.dsn),
        react.createElement("span", null,
          react.createElement("button", { type: "button", style: toggleStyle, onClick: function () { setEditing(isEditing ? null : { key: key, dsn: "" }); } }, isEditing ? t("btn.cancel") : t("btn.edit")),
          w.persisted ? react.createElement("button", { type: "button", style: dangerStyle, onClick: function () { props.configOp({ op: "remove", workspace: w.path, env: w.env }); } }, t("btn.delete")) : null));
      var editRow = isEditing ? react.createElement("div", { style: rowStyle },
        react.createElement("input", { style: wideInputStyle, placeholder: t("dsn.editPlaceholder"), value: editing.dsn, onChange: function (e) { setEditing(Object.assign({}, editing, { dsn: e.target.value })); } }),
        react.createElement("button", { type: "button", style: Object.assign({}, toggleStyle, { marginLeft: "8px" }), onClick: function () { saveEdit(w); } }, t("btn.saved"))) : null;
      return react.createElement("div", { key: key, style: wsRowStyle }, titleRow, metaRow, actionsRow, editRow);
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
    ctx.slots.inject("settings.plugin.item", function () {
      var reg = ctx.slots.register({ name: "settings.plugin.item", key: NS, inject: function () { return face; } }, StatusCard);
      console.log("[dsh-dbhub-live] card 已注册");
      return reg;
    });
  }

  var name = "dsh-dbhub-live";
  var inject = ["slots", "settingsScope"];

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});