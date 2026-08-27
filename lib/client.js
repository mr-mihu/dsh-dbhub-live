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
    var face = {
      getSnapshot: function () { return host.getSnapshot(); },
      subscribe: function (fn) { return host.subscribe(fn); },
      setEnabled: function (value) {
        return host.set("enabled", Boolean(value)).then(function () { return undefined; }, function () { return undefined; });
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