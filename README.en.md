# dsh-dbhub-live

[简体中文](README.md) | English

> Let [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) operate databases directly and safely: persistent multi-source connections + per-workspace tools + ad-hoc dynamic connections + lazy loading and a browser status card.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#installation)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mr-mihu/dsh-dbhub-live)

`dsh-dbhub-live` is a DSH plugin built on [DBHub](https://dbhub.ai) (a database MCP server) that lets the model query databases directly: reuse persistent connections on configured workspaces, or make one-off connections to any database for ad-hoc investigation.

## ✨ Features

- **Persistent multi-source service** — a single background dbhub service connects to multiple sources; connections are reused and queries are faster.
- **Per-workspace tools** — `dbhub_execute_sql_<workspace>` / `dbhub_search_objects_<workspace>`; the tool name is the workspace, multiple workspaces never mix up, and connections are clearly labeled (passwords masked).
- **Ad-hoc dynamic connections** — `dbhub_query` / `dbhub_query_objects` connect to any database independently on each call and can query several databases in parallel, handy for cross-environment diagnosis.
- **Lazy-load startup** — plugin startup does not block the GUI and tools are available immediately; environment initialization is deferred to the first call (queries during initialization automatically wait until ready).
- **Enable / disable switch** — turning it off makes every dbhub tool return a friendly "plugin disabled" message immediately, without a restart; turning it back on takes effect right away.
- **Browser status card** — the Settings → Plugins → dsh-dbhub-live panel shows in real time: a status badge (🟢 running / 🟡 initializing / 🔴 error), registered tool count, operating mode, and the most recent error (in red), plus the enable/disable switch.
- **Out of the box** — if `dbhub` is not installed, the plugin installs it automatically on first use and keeps it updated afterwards; no manual steps needed.
- **Multiple configuration methods** — explicit DSN / fill-in fields / authorized scanning of project config files; credentials stay in your local user directory and passwords are masked end to end.

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
```

After installing, **restart `dsh web`** for it to take effect (you can then see the status card at Settings → Plugins → dsh-dbhub-live).

## Quick Start

The tools below are invoked automatically by DSH's AI — you don't run them by hand; just state your request in natural language (e.g., "look up the users table") and the AI configures and queries on demand:

```text
# 1) If the current workspace has no connection yet, the AI configures one first (three methods below under "Configuration Methods")
dbhub_configure

# 2) Run a query on a persistent connection of a configured workspace
dbhub_execute_sql_myapp  SELECT * FROM users LIMIT 10;

# 3) Make a one-off connection to any database
dbhub_query  dsn=mysql://user:pass@127.0.0.1:3306/mydb  sql="SHOW TABLES;"
```

## Tools

| Tool | Description |
| --- | --- |
| `dbhub_configure(workspace?, env?, dsn?)` | Configure/persist a database connection for a workspace (environment name optional, default `default`). |
| `dbhub_list_sources()` | List all registered connection sources (workspace × environment, masked connection strings, origin, and the corresponding **source** value); **masked strings are for identification only and cannot be used for direct connections**. |
| `dbhub_execute_sql(source, sql)` | Execute SQL on a source's persistent connection; `source` comes from `dbhub_list_sources` (the default environment has no suffix; named environments look like `…_test`). |
| `dbhub_search_objects(source, object_type, ...)` | Search database objects (tables/views/columns/indexes, etc.) on a given source. |
| `dbhub_query(dsn, sql)` | Connect to any database temporarily and execute SQL (multiple statements separated by `;`); **a masked `****` password is detected and the call is rejected**, steering you to the persistent tools. |
| `dbhub_query_objects(dsn, ...)` | Connect to any database temporarily and search database objects; masked passwords are also rejected. |

> Persistent tools have a **constant declaration count** (it does not grow with the number of workspaces/environments): every workspace × environment is selected through the `source` parameter of `dbhub_execute_sql` / `dbhub_search_objects` — semantically equivalent to one tool per workspace × environment, but **without using extra context space**.

> Note: `search_objects` is only available for SQLite; for MySQL / PostgreSQL etc. use `dbhub_query` directly (e.g., `SHOW TABLES`).

### Configuration Methods

1. **Explicit DSN** — pass a full connection string, e.g. `mysql://user:pass@host:3306/db`.
2. **Fill in fields** — fill type / host / port / user / password / database name in order.
3. **Authorized scan** — after authorization, scan project config files (`.env`, `application*.yml`, `docker-compose`, `jdbc.properties`, etc.) and list candidates (passwords masked) for you to confirm.

If a workspace already has `mise env` or `.env` (`DSN` / `DB_*`), the plugin discovers it automatically — no manual configuration needed.

## Status Card

Settings → Plugins → dsh-dbhub-live: the plugin syncs its running state and configuration to the Web settings panel in real time (only visible on the `dsh web` side). The card uses the **single-row collapsible** style (consistent with the other plugin settings cards):

**Collapsed (default)**: one row shows the status badge (🟢 running / 🟡 initializing / 🔴 error / ⚪ disabled), environment count, and the **enable/disable switch** — you can check the status and toggle without expanding.

**Expanded** shows three blocks —

**Status** (supporting info; the tool declaration count is fixed and no longer the focus):

- Resident process: running / pending start (on demand) — shows "pending start" after idle reclamation.
- Operating mode: lazy loading (initializes on first call).
- Tool declarations: `6 (fixed)`; environments: `N · M saved`.
- Most recent error (shown in red on error).

**Configuration** (edit, then click "Save Configuration" to apply immediately and persist):

| Parameter | Description | Default |
| --- | --- | --- |
| Auto-update interval (days) | How often dbhub is auto-updated; `0` disables | `7` |
| Idle reclamation (minutes) | Idle reclamation time of the resident dbhub process | `10` |

Precedence: **user settings > process environment variables (default seeds) > built-in defaults**. The auto-installed package is not in the UI (controlled separately by the `DSH_DBHUB_PACKAGE` environment variable, default `@bytebase/dbhub`).

**Workspace connections**:

- Lists every workspace × environment connection: workspace name, environment name, **source value** (what the model passes to `dbhub_execute_sql`, shown in monospace), **masked** connection string, and origin badge (`saved` / `auto`).
  - `saved`: you configured it (`dbhub_configure` or added in the card).
  - `auto`: not saved, discovered from `mise env` / `.env` — not persisted and follows the source files; if auto-discovery is wrong, use "Edit" to override it with a manual configuration.
- Each row can be **edited** (override the connection string; an auto item becomes saved) or **deleted** (saved items only).
- **Multiple environments per workspace**: fill "workspace (path or title, empty = default current workspace) + environment name + connection string" in the form and click "Add Connection". The default environment's source has no suffix; named environments look like `<workspace>_<environment>`.

## dbhub Environment Variables

| Environment variable | Description | Default |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | npm package name used for auto-install (environment variable only, not exposed in the UI) | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | Seed for the auto-update interval in days; `0` disables (overridden once saved in the settings card) | `7` |

## 🔄 Automatic Installation & Updates

- **Auto-install on first use** — when `dbhub` is missing locally, the plugin installs it on the first query; afterwards it also works offline.
- **Kept up to date automatically** — silently updates to the latest version in the background (interval under "Status Card → configurable parameters"); on failure the existing version is kept.
- **Never touches your configuration** — a `dbhub` you installed yourself via PATH / mise is left untouched.

> The default update interval can also be seeded by an environment variable, see "Status Card → Configuration"; once saved in the settings card, the saved value wins.

## Data Location

All configuration and credentials live outside the module directory (unaffected by pnpm packaging); deleting the directory clears everything:

```
~/.dsh/storages/dsh-dbhub-live/
```

Instances are isolated by `DSH_HOME`; multiple profiles of the same instance share it (same convention as dsh's own `workspace.json`). Workspace connections are stored per "workspace × environment" (`environments.default` is the default environment); legacy v1 single-connection entries migrate automatically at startup. The plugin cleans up and migrates legacy config left by upgrades or manual edits in one pass; it does not crash if the runtime directory is deleted or writes are blocked by the system — it recreates the directory, warns once and keeps running in memory when a write fails, and treats a `dbhub.toml` write failure as an initialization error with automatic retry.

## Uninstall

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot locate dbhub" on first use | Make sure npm is present and online; offline, install `dbhub` manually and add it to PATH. |
| Status card shows 🔴 error | Check "Most recent error" in the status card and the `dsh web` logs; a crashed process is auto-restarted on the next call. |
| Tools say "plugin disabled" | Open Settings → Plugins → dsh-dbhub-live and click "Enable". |
| Status card not visible | Confirm the plugin is installed and restart `dsh web`; the card only shows in the Web settings panel (`dsh web`) — on terminal environments without the panel, tool usage is unaffected. |
| No config files found by the scan | `node_modules` / `.git` / `target` / `dist` etc. are skipped by default; use "Enter DSN" or "Fill in fields" instead. |
| Need a custom dbhub version | Set the `DSH_DBHUB_PACKAGE` environment variable (e.g. `@bytebase/dbhub@1.2.1`) and restart; or delete `~/.dsh/storages/dsh-dbhub-live` and let it reinstall automatically. |
| Don't want automatic dbhub updates | Set "Auto-update interval (days)" to `0` in the status card and save; or set `DSH_DBHUB_UPDATE_DAYS=0`. |

## License

[MIT](./LICENSE)