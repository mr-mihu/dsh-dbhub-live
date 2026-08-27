// dsh-dbhub-live — browser half (hand-authored lazy-CJS client bundle).
//
// Packaging contract (see docs/cookbook/adding-a-settings-card.md and
// packages/client/modules): the Node client-modules scanner serves
// `exports["./client"]` for every Loader entry declaring `dsh.client`; the
// script must register a lazy CJS factory through `window.__ModuleLoader__.load`
// whose `id` equals the Loader entry name. The factory receives the shared
// `require` (React is a seeded baseline module) and returns the Cordis plugin
// object — `name` / `inject` / `apply`.
//
// The card renders the plugin's live status from the `dsh-dbhub-live` settings
// namespace (mirrored by the Host half) and writes the enable/disable toggle
// back through the namespace's `enabled` field. No other plugin value is
// imported: all cross-package collaboration goes through the slot + settings
// services by name.

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

  // Normalize a settingsScope snapshot into the namespace value object.
  function valueOf(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return {};
    var value = snapshot.value;
    return value && typeof value === "object" ? value : {};
  }

  var cardStyle = {
    border: "1px solid #d0d7de",
    borderRadius: "8px",
    padding: "12px 14px",
    fontFamily: "inherit",
    fontSize: "13px",
    color: "#1f2328",
    background: "#ffffff",
    maxWidth: "440px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
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

  var rowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 0",
  };

  var labelStyle = { color: "#57606a" };

  var valueStyle = { fontWeight: 600, textAlign: "right", marginLeft: "12px" };

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
    padding: "5px 12px",
    fontSize: "13px",
    color: "#1f2328",
    background: "#f6f8fa",
  };

  var toggleOnStyle = Object.assign({}, toggleStyle, {
    color: "#2f9e44",
    borderColor: "#b7d8bf",
    background: "#ecf7ef",
  });

  var configHeadStyle = {
    fontWeight: 600,
    fontSize: "13px",
    padding: "8px 0 4px",
    marginTop: "4px",
    borderTop: "1px solid #eef1f4",
  };

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

  var saveRowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "7px 0 0",
  };

  var savedStyle = { color: "#2f9e44", fontSize: "12px" };

  var CONFIG_FIELDS = [
    { key: "dbhubPackage", label: "自动安装包", type: "text", hint: "npm 包名，如 @bytebase/dbhub@1.2.1" },
    { key: "updateIntervalDays", label: "自动更新间隔(天)", type: "number", min: 0, hint: "0 = 关闭" },
    { key: "idleMinutes", label: "空闲回收(分钟)", type: "number", min: 1, hint: "常驻进程空闲回收" },
  ];

  function StatusCard(props) {
    var loaded = react.useState(function () { return valueOf(props.getSnapshot()); });
    var value = loaded[0];
    var setValue = loaded[1];

    react.useEffect(function () {
      return props.subscribe(function () { setValue(valueOf(props.getSnapshot())); });
    }, []);

    var enabled = value.enabled !== false;
    var phase = enabled ? (value.phase || "initializing") : "disabled";
    var meta = PHASE_META[phase] || PHASE_META.initializing;
    var toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
    var lastError = typeof value.lastError === "string" && value.lastError ? value.lastError : "";
    var modeLabel = MODE_LABEL[value.mode] || (value.mode || "lazy");

    // Config editor draft: staged locally until 保存 writes the fields.
    var draftState = react.useState(function () {
      return {
        dbhubPackage: typeof value.dbhubPackage === "string" ? value.dbhubPackage : "",
        updateIntervalDays: typeof value.updateIntervalDays === "number" ? String(value.updateIntervalDays) : "7",
        idleMinutes: typeof value.idleMinutes === "number" ? String(value.idleMinutes) : "10",
      };
    });
    var draft = draftState[0];
    var setDraft = draftState[1];
    var savedState = react.useState(false);
    var saved = savedState[0];
    var setSaved = savedState[1];

    var setField = function (key, raw) {
      setSaved(false);
      setDraft(Object.assign({}, draft, (function () { var o = {}; o[key] = raw; return o; })()));
    };

    var saveConfig = function () {
      var patch = {
        dbhubPackage: draft.dbhubPackage,
        updateIntervalDays: Number(draft.updateIntervalDays),
        idleMinutes: Number(draft.idleMinutes),
      };
      props.saveConfig(patch).then(function () { setSaved(true); });
    };

    var rows = [
      react.createElement("div", { key: "phase", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "运行状态"),
        react.createElement("span", { style: Object.assign({}, valueStyle, { color: meta.color }) },
          meta.emoji + " " + meta.label)),
      react.createElement("div", { key: "tools", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "已注册工具"),
        react.createElement("span", { style: valueStyle }, String(toolCount) + " 个")),
      react.createElement("div", { key: "mode", style: rowStyle },
        react.createElement("span", { style: labelStyle }, "工作模式"),
        react.createElement("span", { style: valueStyle }, modeLabel)),
    ];

    if (lastError) {
      rows.push(
        react.createElement("div", { key: "error", style: rowStyle },
          react.createElement("span", { style: labelStyle }, "最近错误"),
          react.createElement("span", { style: Object.assign({}, errorStyle, valueStyle) }, lastError)),
      );
    }

    rows.push(
      react.createElement("div", { key: "config-head", style: configHeadStyle }, "配置"),
    );

    for (var f = 0; f < CONFIG_FIELDS.length; f++) {
      (function (field) {
        var valueFor = draft[field.key] === undefined ? "" : draft[field.key];
        rows.push(
          react.createElement("div", { key: field.key, style: rowStyle },
            react.createElement("span", { style: labelStyle, title: field.hint || undefined }, field.label),
            react.createElement("input", {
              type: field.type,
              min: field.min === undefined ? undefined : String(field.min),
              style: inputStyle,
              value: valueFor,
              placeholder: field.hint || undefined,
              onChange: function (event) { setField(field.key, event.target.value); },
            })),
        );
      })(CONFIG_FIELDS[f]);
    }

    rows.push(
      react.createElement("div", { key: "save", style: saveRowStyle },
        saved ? react.createElement("span", { key: "saved", style: savedStyle }, "已保存 ✓") : null,
        react.createElement("button", { type: "button", style: toggleStyle, onClick: saveConfig }, "保存配置")),
    );

    rows.push(
      react.createElement("div", { key: "toggle", style: Object.assign({}, rowStyle, { paddingTop: "8px", borderTop: "1px solid #eef1f4" }) },
        react.createElement("span", { style: labelStyle }, enabled ? "插件已启用" : "插件已禁用"),
        react.createElement("button", {
          type: "button",
          style: enabled ? toggleOnStyle : toggleStyle,
          onClick: function () { props.setEnabled(!enabled); },
        }, enabled ? "禁用" : "启用")),
    );

    return react.createElement("div", { style: cardStyle },
      react.createElement("div", { style: headStyle },
        react.createElement("span", null, "dsh-dbhub-live"),
        react.createElement("span", null, meta.emoji)),
      rows);
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