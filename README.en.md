# dsh-dbhub-live

[简体中文](README.md) | English

> Let [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) operate databases directly and safely: **zero-knowledge credentials** (passwords never reach the model) + **one-shot process execution** (no resident server — naturally concurrent and multi-instance safe) + workspace × environment connection management + a browser status card.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#installation)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mr-mihu/dsh-dbhub-live)

`dsh-dbhub-live` is a DSH plugin built on [DBHub](https://dbhub.ai) (a database MCP server) that lets the model query databases directly: the model only says *which workspace/environment* to query, and the plugin resolves the real connection host-side and executes it — **passwords and DSNs never appear anywhere the model can see**. Every call is an independent throwaway dbhub process, killed right after the call.

## ✨ Features

- **Zero-knowledge credentials** — the model only ever sees `source` handles and metadata (type / host / port / database); passwords, usernames and full DSNs exist only host-side; entering/changing a password happens **in the UI**, never through the model.
- **One-shot process execution** — no resident dbhub service: each call spawns an independent process and recycles it when done. A hung/failed query only affects its own call; parallel tasks and multiple DSH instances running at once never interfere (no shared ports, no cross-kills).
- **Constant 4 tool declarations** — `dbhub_configure` / `dbhub_list_sources` / `dbhub_execute_sql` / `dbhub_search_objects`; more environments never inflate the model context.
- **Workspace × environment connection management** — one workspace can hold multiple environments (default / prod / dev / test…) distinguished by their `source` value.
- **Auth-failure loop** — when credentials or connection details are wrong, the tool gives clear guidance; the model steers you to update the password in the UI (it never asks you for it), or you edit it directly in the settings card.
- **Enable / disable switch** — turning it off makes every dbhub tool return a friendly "plugin disabled" message immediately; no restart needed.
- **Browser status card** — Settings → Plugins → dsh-dbhub-live shows live: status badge, mode (one-shot), registered tool count, environment count, recent error, plus the enable/disable switch, connection CRUD and connection tests.
- **Out of the box** — if `dbhub` is missing, the plugin installs it on first use and keeps it updated at your configured interval.

## Supported Data Sources

MySQL · PostgreSQL · MariaDB · SQLite · SQL Server

## Requirements

- DeepSeek Harness's `dsh` CLI (`dsh web` runs the GUI)
- Node.js ≥ 18 with `npm` recommended — `dbhub` is auto-installed on first use

## Installation

```bash
# Option 1: use a locally installed dsh
dsh plugin --profile web add dsh-dbhub-live

# Option 2: invoke dsh via npx (no global dsh installation required)
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live

# Update to a specific version (pin the currently published version so pnpm doesn't skip with "Already up to date")
dsh plugin --profile web update dsh-dbhub-live@4.0.0
```

After installing, **restart `dsh web`** for it to take effect (you can then see the status card at Settings → Plugins → dsh-dbhub-live).

## Quick Start

The tools below are invoked automatically by DSH's AI — you don't run them by hand; just state your request in natural language (e.g., "look up the users table"):

```text
# 1) If the current workspace has no connection yet, the AI guides configuration (password is entered in the UI, the AI never sees it)
dbhub_configure

# 2) Run a query on a configured connection (source comes from dbhub_list_sources)
dbhub_execute_sql  source=myapp  sql="SELECT * FROM users LIMIT 10;"

# 3) List registered connections and their source values
dbhub_list_sources
```

## Tools

| Tool | Description |
| --- | --- |
| `dbhub_configure(workspace?, env?, type?, host?, port?, database?, user?)` | Configure/persist a workspace connection. **Does NOT accept a dsn argument** — the password/DSN is always entered in the UI (never through the model); type/host/port/database/user may be passed as non-sensitive prefills. |
| `dbhub_list_sources()` | List every connection source (workspace × environment): metadata only (type/host/port/database) + origin badge + the corresponding **source** value. |
| `dbhub_execute_sql(source, sql)` | Execute SQL on a source; `source` comes from `dbhub_list_sources` (the default environment has no suffix; named environments look like `…_test`). Each call is an independent one-shot connection; multiple statements separated by `;`. |
| `dbhub_search_objects(source, object_type, ...)` | Search database objects (tables/views/columns/indexes, etc.) on a given source. |

> **Security**: the model can never obtain a password through this plugin — results and lists only show metadata like `mysql://host:3306/db`; dbhub's error text is scrubbed before it is returned. On a failing query, follow the hint and update the password in the UI.

> Note: `search_objects` works only for SQLite; for MySQL / PostgreSQL etc. use `dbhub_execute_sql` directly (e.g., `SHOW TABLES`).

### Configuration Methods

1. **Explicit DSN** — enter a full connection string in the UI, e.g. `mysql://user:pass@host:3306/db`.
2. **Fill in fields** — fill type / host / port / user / password / database name in the UI.
3. **Authorized scan** — after authorization, scan project config files (`.env`, `application*.yml`, `docker-compose`, `jdbc.properties`, etc.) and list candidates (host/port/database only — passwords are read host-side and never shown) for you to confirm.

If a workspace already has `mise env` or `.env` (`DSN` / `DB_*`), the plugin discovers it automatically — no manual configuration needed.

## Status Card

Settings → Plugins → dsh-dbhub-live: the plugin syncs its state and configuration to the Web settings panel in real time (only visible on the `dsh web` side). The card uses the **single-row collapsible** style (consistent with the other plugin settings cards):

> All card copy (name, status, config fields, buttons, connection rows) follows the dsh UI language (Chinese / English — Settings → General → Language); model-facing errors, feedback and the host logs follow it as well.

**Collapsed (default)**: one row shows the status badge (🟢 running / ⚪ disabled), environment count, and the **enable/disable switch**.

**Expanded** shows three blocks —

**Status**:

- Mode: one-shot connection (an independent process per call).
- Tool declarations: `4 (fixed)`; environments: `N · M saved`.
- Most recent error (shown in red on error).

**Configuration** (edit, then click "Save Configuration" to apply immediately and persist):

| Parameter | Description | Default |
| --- | --- | --- |
| Auto-update interval (days) | How often dbhub is auto-updated; `0` disables | `7` |

Precedence: **user settings > process environment variables (default seeds) > built-in defaults**. The auto-installed package is not in the UI (controlled separately by the `DSH_DBHUB_PACKAGE` environment variable, default `@bytebase/dbhub`).

**Workspace connections**:

- Lists every workspace × environment connection: workspace name, environment name, **source value** (what the model passes to `dbhub_execute_sql`, shown in monospace), **connection metadata** (🔒 `mysql://host:3306/db` — no username, no password; passwords never appear on the card), origin badge (`saved` / `auto`) and origin detail (`saved · user` / `saved · scan` / `auto · mise env` / `auto · .env`).
  - `saved`: you configured it (`dbhub_configure` or added in the card).
  - `auto`: not saved, discovered from `mise env` / `.env` — not persisted and follows the source files; if auto-discovery is wrong, use "Edit" to override it with a manual configuration.
- Each row can be **tested** (connectivity probe, see below), **edited** (override the connection string; an auto item becomes saved) or **deleted** (saved items only).
- **Connection test**: clicking "Test" makes the Host probe the row's real DSN through a throwaway connection (a one-off dbhub process running `SELECT 1`) and shows success/failure inline. The report is one-shot feedback: never persisted, fades after ~10 s; a failure never marks, restricts or alters the connection, other environments or queries (slow/unreachable databases wait at most ~30 s).
- **Multiple environments per workspace**: fill "workspace (path or title, empty = default current workspace) + environment name + connection string" in the form and click "Add Connection". The default environment's source has no suffix; named environments look like `<workspace>_<environment>`.

## dbhub Environment Variables

| Environment variable | Description | Default |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | npm package name used for auto-install (environment variable only, not exposed in the UI) | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | Seed for the auto-update interval in days; `0` disables (overridden once saved in the settings card) | `7` |

## 🔄 Automatic Installation & Updates

- **Auto-install on first use** — when `dbhub` is missing locally, the plugin installs it on the first execution; afterwards it also works offline.
- **Kept up to date automatically** — silently updates to the latest version in the background (interval under "Status Card → configurable parameters"); on failure the existing version is kept.
- **Never touches your configuration** — a `dbhub` you installed yourself via PATH / mise is left untouched.

> The default update interval can also be seeded by an environment variable, see "Status Card → Configuration"; once saved in the settings card, the saved value wins.

## Data Location

All configuration and credentials live outside the module directory (unaffected by pnpm packaging); deleting the directory clears everything:

```
~/.dsh/storages/dsh-dbhub-live/
```

Instances are isolated by `DSH_HOME`; multiple profiles of the same instance share it (same convention as dsh's own `workspace.json`). Workspace connections are stored per "workspace × environment" (`environments.default` is the default environment); legacy v1 single-connection entries migrate automatically at startup. The plugin cleans up and migrates legacy config left by upgrades or manual edits in one pass; it does not crash if the runtime directory is deleted or writes are blocked by the system — it recreates the directory, warns once and keeps running in memory when a write fails. **There is no resident dbhub process and no shared config file**: concurrent instances on the same machine — even sharing one DSH_HOME — do not interfere with each other.

## Uninstall

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot locate dbhub" on first use | Make sure npm is present and online; offline, install `dbhub` manually and add it to PATH. |
| A query to one environment fails with connection refused / auth error | Environments use independent one-shot connections: an unreachable environment only fails that call — other environments and calls keep working. The error carries guidance — for wrong credentials/details, ask the AI to run `dbhub_configure` and enter the password in the UI, or edit it directly in Settings → Plugins → Workspace connections. |
| Tools say "plugin disabled" | Open Settings → Plugins → dsh-dbhub-live and click "Enable". |
| Status card not visible | Confirm the plugin is installed and restart `dsh web`; the card only shows in the Web settings panel (`dsh web`) — on terminal environments without the panel, tool usage is unaffected. |
| No config files found by the scan | `node_modules` / `.git` / `target` / `dist` etc. are skipped by default; use "Enter DSN" or "Fill in fields" instead. |
| Need a custom dbhub version | Set the `DSH_DBHUB_PACKAGE` environment variable (e.g. `@bytebase/dbhub@1.2.1`) and restart; or delete `~/.dsh/storages/dsh-dbhub-live` and let it reinstall automatically. |
| Don't want automatic dbhub updates | Set "Auto-update interval (days)" to `0` in the status card and save; or set `DSH_DBHUB_UPDATE_DAYS=0`. |
| Can't update the password in chat (the model asks you for it) | That is by design — the model must not handle passwords. Ask the AI to run `dbhub_configure` and fill in the password in the UI prompt, or edit it yourself in Settings → Plugins → Workspace connections. |

## License

[MIT](./LICENSE)