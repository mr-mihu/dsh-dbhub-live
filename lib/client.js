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
  // Friendly display title for the settings card header (the package id
  // stays as the loader/registry identity; this is what users read).
  var PLUGIN_TITLE = "DBHub 数据库工具";

  var PHASE_META = {
    initializing: { emoji: "🟡", label: "初始化中", color: "#b58900" },
    running: { emoji: "🟢", label: "运行中", color: "#2f9e44" },
    error: { emoji: "🔴", label: "异常", color: "#e03131" },
    disabled: { emoji: "⚪", label: "已禁用", color: "#868e96" },
  };

  var MODE_LABEL = { lazy: "懒加载（首次调用时初始化）" };

  var SOURCE_LABEL = {
    "persisted(user)": "已保存·用户",
    "persisted(collected)": "已保存·扫描",
    "工作区 mise env": "自动·mise env",
    "工作目录 .env": "自动·.env",
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

    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "initializing") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = MODE_LABEL[value.mode] || (value.mode || "lazy");
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

    var mkRow = function (key, label, valueNode, styleValue) {
      return react.createElement("div", { key: key, style: rowStyle },
        react.createElement("span", { style: labelStyle }, label),
        react.createElement("span", { style: Object.assign({}, valueStyle, styleValue || {}) }, valueNode));
    };

    // Collapsed header (native card look): name + desc on the left, status +
    // toggle + chevron on the right. The chevron is the product icon primitive
    // (rotates when open), mirroring the built-in plugin settings cards.
    var descText = (workspaces.length > 0 ? String(workspaces.length) + " 个环境 · 已保存 " + String(savedCount) : "未配置连接") +
      (serverUp ? " · 常驻运行中" : " · 常驻待启动");
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
        react.createElement("span", { style: nameStyle }, PLUGIN_TITLE),
        react.createElement("span", { style: descStyle },
          meta.emoji + " " + meta.label + " · " + descText)),
      react.createElement("button", {
        type: "button",
        style: enabled ? Object.assign({}, toggleStyle, { color: "#2f9e44", borderColor: "#b7d8bf", background: "#ecf7ef", flex: "none" }) : Object.assign({}, toggleStyle, { flex: "none" }),
        onClick: function (e) { e.stopPropagation(); props.setEnabled(!enabled); },
        title: enabled ? "禁用插件" : "启用插件",
      }, enabled ? "禁用" : "启用"),
      react.createElement("span", { style: Object.assign({}, chevronWrapStyle, open ? { transform: "rotate(180deg)" } : {}) },
        react.createElement(ChevronIcon, null)));

    if (!open) {
      return react.createElement("div", { style: cardStateStyle, onMouseEnter: function () { setHover(true); }, onMouseLeave: function () { setHover(false); } }, header);
    }

    var statusRows = [
      mkRow("server", "常驻进程", serverUp ? "运行中" : "待启动（按需）"),
      mkRow("mode", "工作模式", modeLabel),
      mkRow("tools", "工具声明", String(toolCount) + " 个（固定）"),
      mkRow("envs", "环境", String(workspaces.length) + " 个 · 已保存 " + String(savedCount)),
    ];
    if (lastError) {
      statusRows.push(mkRow("error", "最近错误", lastError, errorStyle));
    }

    var configRows = [
      react.createElement("div", { key: "updateIntervalDays", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: "自动更新 dbhub 的间隔天数，0 = 关闭" }, "自动更新间隔(天)"),
        react.createElement("input", {
          type: "number", min: "0", style: inputStyle,
          value: typeof draft.updateIntervalDays === "string" ? draft.updateIntervalDays : "",
          onChange: function (e) { setSaved(false); setDraft(Object.assign({}, draft, { updateIntervalDays: e.target.value })); },
        })),
      react.createElement("div", { key: "idleMinutes", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: "常驻 dbhub 进程空闲回收时长" }, "空闲回收(分钟)"),
        react.createElement("input", {
          type: "number", min: "1", style: inputStyle,
          value: typeof draft.idleMinutes === "string" ? draft.idleMinutes : "",
          onChange: function (e) { setSaved(false); setDraft(Object.assign({}, draft, { idleMinutes: e.target.value })); },
        })),
      react.createElement("div", { key: "save", style: saveRowStyle },
        saved ? react.createElement("span", { key: "saved", style: savedStyle }, "已保存 ✓") : null,
        react.createElement("button", { type: "button", style: toggleStyle, onClick: saveConfig }, "保存配置")),
    ];

    var wsRows = workspaces.map(function (w) {
      var key = w.path + "|" + w.env;
      var sourceText = SOURCE_LABEL[w.source] || w.source || (w.persisted ? "已保存" : "自动");
      var isEditing = editing && editing.key === key;
      return react.createElement("div", { key: key, style: wsRowStyle },
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: wsTitleStyle },
            w.title,
            react.createElement("span", { style: w.persisted ? savedBadgeStyle : autoBadgeStyle }, w.persisted ? "已保存" : "自动")),
          react.createElement("span", { style: wsMetaStyle }, "环境: " + w.env)),
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: srcStyle }, "source: " + (w.srcId || "")),
          react.createElement("span", { style: wsMetaStyle }, "来源: " + sourceText)),
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: wsMetaStyle }, w.dsn),
          react.createElement("span", null,
            react.createElement("button", { type: "button", style: toggleStyle, onClick: function () { setEditing(isEditing ? null : { key: key, dsn: "" }); } }, isEditing ? "取消" : "修改"),
            w.persisted ? react.createElement("button", { type: "button", style: dangerStyle, onClick: function () { props.configOp({ op: "remove", workspace: w.path, env: w.env }); } }, "删除") : null)),
        isEditing ? react.createElement("div", { style: rowStyle },
          react.createElement("input", { style: wideInputStyle, placeholder: "完整 DSN（密码勿泄露给模型）", value: editing.dsn, onChange: function (e) { setEditing(Object.assign({}, editing, { dsn: e.target.value })); } }),
          react.createElement("button", { type: "button", style: Object.assign({}, toggleStyle, { marginLeft: "8px" }), onClick: function () { saveEdit(w); } }, "保存")) : null);
    });

    if (wsRows.length === 0) {
      wsRows.push(react.createElement("div", { key: "empty", style: wsMetaStyle, padding: "6px 0" }, "暂无已保存或自动发现的连接（可用下方表单添加，或让模型调用 dbhub_configure）。"));
    }

    var addRows = [
      react.createElement("div", { key: "add-ws", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: "工作区路径或标题" }, "工作区"),
        react.createElement("input", { style: wideInputStyle, placeholder: "工作区路径或标题；留空 = 默认当前工作区", value: addForm.ws, onChange: function (e) { setAddForm(Object.assign({}, addForm, { ws: e.target.value })); } })),
      react.createElement("div", { key: "add-env", style: rowStyle },
        react.createElement("span", { style: labelStyle, title: "同一工作区可添加多个环境" }, "环境名"),
        react.createElement("input", { style: wideInputStyle, placeholder: "如 prod / dev / test；默认 default", value: addForm.env, onChange: function (e) { setAddForm(Object.assign({}, addForm, { env: e.target.value })); } })),
      react.createElement("div", { key: "add-dsn", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "连接串 DSN"),
        react.createElement("input", { style: wideInputStyle, placeholder: "mysql://user:pass@host:3306/db", value: addForm.dsn, onChange: function (e) { setAddForm(Object.assign({}, addForm, { dsn: e.target.value })); } })),
      react.createElement("div", { key: "add-save", style: saveRowStyle },
        react.createElement("button", { type: "button", style: toggleStyle, onClick: addDsn }, "添加连接")),
    ];

    return react.createElement("div", {
      style: cardStateStyle,
      onMouseEnter: function () { setHover(true); },
      onMouseLeave: function () { setHover(false); },
    },
      header,
      react.createElement("div", { style: bodyStyle },
        react.createElement("div", { style: blockTitleStyle }, "状态"),
        statusRows,
        react.createElement("div", { style: blockTitleStyle }, "配置"),
        configRows,
        react.createElement("div", { style: blockTitleStyle }, "工作区连接"),
        wsRows,
        react.createElement("div", { style: blockTitleStyle }, "添加连接"),
        addRows));
  }

  function apply(ctx) {
    console.log("[dsh-dbhub-live] client apply");
    var settingsScope = ctx.settingsScope;
    var host = settingsScope.bind({ namespace: NS });
    var noop = function () { return undefined; };
    var face = {
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