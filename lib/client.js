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

  var NS = "dsh-dbhub-live";

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

  // ── styles ────────────────────────────────────────────────────────────────

  var cardStyle = {
    border: "1px solid #d0d7de",
    borderRadius: "8px",
    padding: "12px 14px",
    fontFamily: "inherit",
    fontSize: "13px",
    color: "#1f2328",
    background: "#ffffff",
    maxWidth: "440px",
  };

  var headStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontWeight: 600,
    fontSize: "14px",
    paddingBottom: "6px",
    borderBottom: "1px solid #eef1f4",
  };

  var sectionHeadStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    padding: "8px 0 4px",
    fontWeight: 600,
    fontSize: "13px",
    borderTop: "1px solid #eef1f4",
    marginTop: "4px",
  };

  var chevronStyle = { fontSize: "11px", color: "#8b949e" };

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

  // ── collapsible section ───────────────────────────────────────────────────

  function Section(props) {
    return react.createElement("div", null,
      react.createElement("div", { style: sectionHeadStyle, onClick: props.onToggle },
        react.createElement("span", null, props.title),
        react.createElement("span", { style: chevronStyle }, props.open ? "▼" : "▶")),
      props.open ? react.createElement("div", { style: { paddingBottom: "2px" } }, props.children) : null);
  }

  // ── the card ──────────────────────────────────────────────────────────────

  function StatusCard(props) {
    var loaded = react.useState(function () { return valueOf(props.getSnapshot()); });
    var value = loaded[0];
    var setValue = loaded[1];

    react.useEffect(function () {
      return props.subscribe(function () { setValue(valueOf(props.getSnapshot())); });
    }, []);

    var openState = react.useState({ status: true, config: false, workspaces: false });
    var open = openState[0];
    var setOpen = openState[1];
    var toggleOpen = function (key) {
      var next = Object.assign({}, open);
      next[key] = !next[key];
      setOpen(next);
    };

    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "initializing") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = MODE_LABEL[value.mode] || (value.mode || "lazy");
    var serverUp = value.serverUp === true;
    var workspaces = workspacesOf(value);

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

    var statusRows = [
      react.createElement("div", { key: "phase", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "运行状态"),
        react.createElement("span", { style: Object.assign({}, valueStyle, { color: meta.color }) }, meta.emoji + " " + meta.label)),
      react.createElement("div", { key: "tools", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "已注册工具"),
        react.createElement("span", { style: valueStyle }, String(toolCount) + " 个")),
      react.createElement("div", { key: "mode", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "工作模式"),
        react.createElement("span", { style: valueStyle }, modeLabel)),
      react.createElement("div", { key: "server", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "常驻进程"),
        react.createElement("span", { style: valueStyle }, serverUp ? "运行中" : "待启动（按需）")),
    ];
    if (lastError) {
      statusRows.push(
        react.createElement("div", { key: "error", style: rowStyle },
          react.createElement("span", { style: labelStyle }, "最近错误"),
          react.createElement("span", { style: Object.assign({}, errorStyle, valueStyle) }, lastError)));
    }
    statusRows.push(
      react.createElement("div", { key: "toggle", style: Object.assign({}, rowStyle, { paddingTop: "8px", borderTop: "1px solid #eef1f4" }) },
        react.createElement("span", { style: labelStyle }, enabled ? "插件已启用" : "插件已禁用"),
        react.createElement("button", {
          type: "button",
          style: enabled ? Object.assign({}, toggleStyle, { color: "#2f9e44", borderColor: "#b7d8bf", background: "#ecf7ef" }) : toggleStyle,
          onClick: function () { props.setEnabled(!enabled); },
        }, enabled ? "禁用" : "启用")));

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
      var sourceLabel = SOURCE_LABEL[w.source] || w.source || (w.persisted ? "已保存" : "自动");
      var isEditing = editing && editing.key === key;
      return react.createElement("div", { key: key, style: wsRowStyle },
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: wsTitleStyle },
            w.title,
            react.createElement("span", { style: w.persisted ? savedBadgeStyle : autoBadgeStyle }, w.persisted ? "已保存" : "自动")),
          react.createElement("span", { style: wsMetaStyle }, "环境: " + w.env)),
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: wsMetaStyle }, w.dsn),
          react.createElement("span", null,
            react.createElement("button", { type: "button", style: toggleStyle, onClick: function () { setEditing(isEditing ? null : { key: key, dsn: "" }); } }, isEditing ? "取消" : "修改"),
            w.persisted ? react.createElement("button", { type: "button", style: dangerStyle, onClick: function () { props.configOp({ op: "remove", workspace: w.path, env: w.env }); } }, "删除") : null)),
        react.createElement("div", { style: rowStyle },
          react.createElement("span", { style: wsMetaStyle }, "来源: " + sourceLabel)),
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

    return react.createElement("div", { style: cardStyle },
      react.createElement("div", { style: headStyle },
        react.createElement("span", null, "dsh-dbhub-live"),
        react.createElement("span", null, meta.emoji)),
      react.createElement(Section, { title: "状态", open: open.status, onToggle: function () { toggleOpen("status"); } }, statusRows),
      react.createElement(Section, { title: "配置", open: open.config, onToggle: function () { toggleOpen("config"); } }, configRows),
      react.createElement(Section, { title: "工作区连接", open: open.workspaces, onToggle: function () { toggleOpen("workspaces"); } },
        wsRows,
        react.createElement("div", { key: "add-head", style: Object.assign({}, sectionHeadStyle, { borderTop: "none", cursor: "default" }) }, "添加连接"),
        addRows));
  }

  function apply(ctx) {
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
      return ctx.slots.register({ name: "settings.plugin.item", key: NS, inject: function () { return face; } }, StatusCard);
    });
  }

  var name = "dsh-dbhub-live";
  var inject = ["slots", "settingsScope"];

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});