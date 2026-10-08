# dsh-dbhub-live

[简体中文](README.md) | English

> Let [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) operate databases directly and safely: **zero-knowledge credentials** (passwords never reach the model) + **one-shot process execution** (no resident server — naturally concurrent and multi-instance safe) + workspace × environment connection management + a browser Configure Page.

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
- **Per-environment read-only mode and manual SSH tunnels** — each environment can be put in **read-only mode** on its own (writes are rejected by dbhub itself; the model may enable it but never lift it) or routed through a **manual SSH tunnel** (password/passphrase are UI-only and never reach the model; single-hop ProxyJump). Both need dbhub **1.4.0+**. See [Read-only mode and SSH tunnels](#-read-only-mode-and-ssh-tunnels).
- **Auth-failure loop** — when credentials or connection details are wrong, the tool gives clear guidance; the model steers you to update the password in the UI (it never asks you for it), or you edit it directly in the settings card. **Auto-probe during configuration**: non-sensitive connection facts are tested host-side first — if they connect they take effect with zero input (password-less databases never prompt), and if only the password is missing the dialog asks just for "account (when unknown) + password" instead of re-asking for the whole input method. When the probe explicitly blames an EMPTY account (e.g. `Access denied for user ''`), the account is required — the "leave empty (use empty account)" choice is not offered, so the same doomed DSN is never saved again.
- **Enable / disable switch** — turning it off makes every dbhub tool return a friendly "plugin disabled" message immediately and **hides the sidebar shortcut at the same time**; the settings page and the plugin row's Configure control stay reachable, so you can always enable it again (you can never lock yourself out). No restart needed.
- **Browser configure page** — three entries to the same page: **Settings → DBHub Database Tools** (a first-level settings page, recommended), the **sidebar entry DBHub Database Tools** (it follows the plugin's enabled state: hidden as soon as the plugin is disabled, while the settings page and the plugin row stay reachable so you can enable it again), and the plugin row's Configure control on the Plugins page. It shows the status badge, tool count and environment count, and offers the enable/disable switch, connection CRUD, **environment rename** and connection tests. **The connection list is organised per workspace**: when every workspace holds exactly one environment it renders as flat tiles (up to 3 columns, everything visible); as soon as one workspace owns several environments the rows fold per workspace with **click-to-expand group heads**, opening the workspace you used most recently by default, plus an expand/collapse-all control. Each connection **takes one line only** (environment · 🔒 type/host/port/**database** · source handle · icon actions): a narrow column truncates the host/port prefix first and **the database name always stays visible**; the actions are three small icons — ⚡ test / ✏ edit / 🗑 delete — instead of text buttons eating half the row; the `source` handle is a dashed chip showing `…` plus its distinguishing tail (e.g. `…1a2b3c`) — click it to copy, hover for the full value (it is the handle the model uses to target this connection, not a copy of the whole row). Where a connection came from (hand-entered / scanned / copied / auto-discovered) never takes row width — hover the environment chip to see it (an auto-discovered connection that is not saved says so explicitly). Each environment can also be put in **read-only mode** or given a **manual SSH tunnel** (see "Read-only mode and SSH tunnels" below). The auto-update interval lives in the "⚙ Settings" strip (the sidebar entry is no longer a configurable option), and the add form is folded away too (a group's "＋ Environment" adds straight into that workspace, no workspace field to fill). All colours come from DSH theme tokens, so the page follows the active theme/skin and dark mode — **including translucent-background themes**. Writes are guarded against silent overwrites: **saving into an environment name that already exists asks “overwrite?” first** (cancelling writes nothing at all and leaves the form as typed so you can rename it), and renaming an environment onto an existing one asks too.
- **Out of the box** — if `dbhub` is missing, the plugin installs it on first use and keeps it updated at your configured interval.

## Supported Data Sources

MySQL · PostgreSQL · MariaDB · SQLite · SQL Server

## Requirements

- DeepSeek Harness's `dsh` CLI (`dsh web` runs the GUI)
- Works with **every dsh release line from 0.1.5 on, 0.2.x included**: the configure page rides the settings namespace on 0.1.x and the plugin's own authenticated HTTP bridge (`/api/dsh-dbhub-live/*`) on 0.1.7+/0.2.x, and both carry the same state
- Node.js ≥ 18 with `npm` recommended — `dbhub` is auto-installed on first use
- **Read-only mode and SSH tunnels require dbhub 1.4.0 or newer**: the plugin detects the version and, when it is too old, fails with an explicit error and an upgrade hint (the version the plugin installs automatically satisfies this)

## Installation

```bash
# Option 1: use a locally installed dsh
dsh plugin --profile web add dsh-dbhub-live

# Option 2: invoke dsh via npx (no global dsh installation required)
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live

# Update to a specific version (pin the currently published version so pnpm doesn't skip with "Already up to date")
dsh plugin --profile web update dsh-dbhub-live@5.0.0
```

After installing, **restart `dsh web`** for it to take effect (you can then see the configure page at **Settings → DBHub Database Tools**).

> Upgrading from 4.x: dsh 0.2.x removed the settings-namespace interface the old configure page relied on, so dsh refuses to load 4.x there. 5.0.0 serves both release lines; upgrading the plugin keeps your connections and your saved options.

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
| `dbhub_configure(workspace?, env?, renameFrom?, copyFrom?, type?, host?, port?, database?, user?, readOnly?, sshHost?, sshPort?, sshUser?, sshAuthKind?, sshKeyPath?, sshProxyJump?, sshOff?)` | Configure/persist a workspace connection. **Does NOT accept a dsn argument** — the password/DSN is always entered in the UI (never through the model); type/host/port/database/user may be passed as non-sensitive prefills. **With enough prefills the plugin auto-probes first**: connectable → saved directly and the source value returned; password required → a minimal "account (when unknown) + password" dialog; incomplete info or another failure → the full method choice appears. **Rename**: `env=new name` + `renameFrom=old name` (the connection and its credentials stay as they are; works for `default` → `prod` or a Chinese/English swap; an existing target is confirmed with the user first). **Cross-workspace copy**: `copyFrom=<another workspace's source value>` + `env=<environment to create here>`; the Host copies the connection, so the password never passes through the model. **Environment options**: `readOnly:true` turns read-only mode on for that environment (`readOnly:false` is refused — only the user can turn it off, on the configure page); an SSH tunnel is configured with `sshHost`/`sshPort`/`sshUser`/`sshAuthKind` (`key` or `password`)/`sshKeyPath`/`sshProxyJump`, where the **SSH password and key passphrase may only be typed by the user in the dialog** (the model can never pass them), and `sshOff:true` removes the tunnel while keeping the connection and its read-only flag. |
| `dbhub_list_sources()` | List every connection source, **grouped by workspace** and marking the **[CURRENT WORKSPACE]**: metadata only (type/host/port/database) + origin badge + the corresponding **source** value. |
| `dbhub_execute_sql(source, sql)` | Execute SQL on a source; `source` comes from `dbhub_list_sources`. **Every source belongs to exactly one workspace** — prefer the current workspace's; to reuse another workspace's connection, first copy it here with `dbhub_configure`'s `copyFrom` instead of querying that workspace's source directly. Each call is an independent one-shot connection; multiple statements separated by `;`. |
| `dbhub_search_objects(source, object_type, ...)` | Search database objects (tables/views/columns/indexes, etc.) on a given source. |

> **Security**: the model can never obtain a password through this plugin — results and lists only show metadata like `mysql://host:3306/db`; dbhub's error text is scrubbed before it is returned. On a failing query, follow the hint and update the password in the UI.

> Note: `search_objects` works only for SQLite; for MySQL / PostgreSQL etc. use `dbhub_execute_sql` directly (e.g., `SHOW TABLES`).

### Configuration Methods

0. **Auto-probe (preferred by default)** — once you state connection facts in chat (e.g. "mysql 198.51.100.1:3307/mydb"), the plugin tests them first: connectable → saved immediately (password-less databases need zero input); password required → the dialog asks only for "account (when unknown) + password" with the failure reason and a "use another way" escape when the connection details themselves are wrong; when the probe blames an EMPTY account (e.g. `Access denied for user ''`), the account is required (no "leave empty" choice); incomplete info or another failure → the three methods below appear. If you name a different database/host/port than the saved connection, the plugin re-runs the probe against the new target.
1. **Explicit DSN** — enter a full connection string in the UI, e.g. `mysql://user:pass@host:3306/db`.
2. **Fill in fields** — fill type / host / port / user / password / database name in the UI; fields already known from the conversation are pre-filled — you only fill in the gaps.
3. **Authorized scan** — after authorization, scan project config files (`.env`, `application*.yml`, `docker-compose`, `jdbc.properties`, etc.) and list candidates (host/port/database only — passwords are read host-side and never shown) for you to confirm.

If a workspace already has `mise env` or `.env` (`DSN` / `DB_*`), the plugin discovers it automatically — no manual configuration needed.

## Configure Page

Three entries, one page and one state:

1. **Settings → DBHub Database Tools** (recommended): the first-level settings page the plugin registers; present in every deployment.
2. **Sidebar entry DBHub Database Tools**: a shortcut that **follows the plugin's enabled state** — shown while enabled, hidden immediately when disabled (there is no separate switch any more); to free the sidebar, just use Disable at the top of the page.
3. **Plugins → dsh-dbhub-live → Configure**: the configure control the official Plugins page gives each plugin row since dsh 0.1.6 (that page is provided by the official plugin manager; use the first two entries when it is absent).

> The sidebar entry disappearing (because the plugin is disabled) never removes access: the settings page and the plugin row's Configure control stay available, so you can enable it again at any time.

All page copy (name, status, config fields, buttons, connection rows) follows the dsh UI language (Chinese / English — Settings → General → Language); model-facing errors, feedback and the host logs follow it as well.

**Status**: status badge (🟢 running / ⚪ disabled), the **enable/disable switch**, mode (one-shot connection), tool declarations (`4 (fixed)`), environments (`N · M saved`), most recent error (shown in red on error).

**Configuration** (edit, then click "Save Configuration" to apply immediately and persist):

| Parameter | Description | Default |
| --- | --- | --- |
| Auto-update interval (days) | How often dbhub is auto-updated; `0` disables | `7` |

The sidebar entry is **not** a configurable option: it follows the plugin's enabled state (disabled hides it; the settings page and the plugin row stay reachable). A legacy "Show the sidebar entry" field left in an older configuration is dropped and has no effect.

Precedence: **settings saved on the configure page > process environment variables (default seeds) > built-in defaults**; when upgrading from an older 0.1.x install, the options still stored in the settings document are read as a lower layer (they are never silently reset). On dsh 0.1.7 and later this option is also the plugin's declared configuration (volatile Config): set it in the plugin's row in `cordis.patch.yml`, or in the official Plugins form — **either change is adopted, and this plugin's page shows the same value** (a page save writes back to that configuration too, so the two surfaces never disagree). The auto-installed package is not in the UI (controlled separately by the `DSH_DBHUB_PACKAGE` environment variable, default `@bytebase/dbhub`).

**Workspace connections**:

- Lists every workspace × environment connection: workspace name, environment name, **source value** (what the model passes to `dbhub_execute_sql`, shown in monospace), **connection metadata** (🔒 `mysql://host:3306/db` — no username, no password; passwords never appear on the page), origin badge (`saved` / `auto`) and origin detail (`saved · user` / `saved · scan` / `saved · copied` / `auto · mise env` / `auto · .env`).
  - `saved`: you configured it (`dbhub_configure` or added in the page).
  - `auto`: not saved, discovered from `mise env` / `.env` — not persisted and follows the source files; if auto-discovery is wrong, use "Edit" to override it with a manual configuration. If you **explicitly set an option** (read-only / SSH) on such an environment, the plugin **promotes it to a saved connection** (persisted with the connection string it just discovered) and says so — from then on it no longer follows the source files.
- Each row can be **tested** (connectivity probe, see below), **edited** (change the connection string **and/or the environment name**; a rename keeps the connection and its credentials untouched — enter only a name to rename) or **deleted** (saved items only).
- **Connection test**: clicking "Test" makes the Host probe the environment's **effective connection** — the one execution will really use — through a throwaway connection (a one-off dbhub process running `SELECT 1`); with read-only enabled or an SSH tunnel configured, that is exactly the "tunnelled + read-only" combination. The running row shows the elapsed time (`testing… 1.2s`) and the success/failure appears inline. The report is one-shot feedback: never persisted, fades after ~10 s; a failure never marks, restricts or alters the connection, other environments or queries. The test **never re-scans every workspace** just to find the connection string (a saved environment is read straight from local credentials, an auto-discovered one uses the row already on screen, and only a never-scanned environment triggers a real discovery walk), so "Test" costs about as much as the probe itself. Wait budget: ~25 s direct, ~45 s through an SSH tunnel (browser watchdog 30 s / 60 s); on timeout you get an explicit message instead of an endless spinner.
- **Multiple environments per workspace**: fill "workspace (path or title, empty = default current workspace) + environment name + connection string" in the form and click "Add Connection". Environment names **may be Chinese** (e.g. `线上` / `测试`): the name is shown verbatim while the environment segment of the source value becomes `env-<short hash>`, so two Chinese names can never collide (purely ASCII names such as `test` / `dev` keep their existing source values).

## 🔒 Read-only Mode and SSH Tunnels

Both are **per-environment (workspace × environment)** connection options executed by dbhub's own native features. Once read-only or a tunnel is on, every execution on that environment switches to a **temporary, generated dbhub configuration** — the file contains only `${…}` placeholders and **no password at all** (the real values reach the child process through its environment), and it is deleted right after use. Every other environment behaves exactly as before.

### Read-only mode

- **How to enable it**: click ✏ on the connection row (or use the "＋ Add connection" form), tick "Read-only mode" and save; the model can also enable read-only for an environment. **Turning it off is a user-only action on the configure page** — the model may enable it but never lift it (that would be self-escalation), and an attempt to disable it is refused with a pointer to the configure page.
- **What gets rejected**: dbhub only allows read statements (`select` / `with` / `explain` / `pragma` and so on, depending on the connector); writes (`INSERT` / `UPDATE` / `DELETE` / DDL …) are rejected by dbhub itself with `READONLY_VIOLATION`. The model sees that raw error plus a short hint. Object search (`dbhub_search_objects`) keeps working in a read-only environment.
- **How to recognise it**: the environment name gains a small `RO` badge, with an explanation on hover.
- **Note**: read-only is a **per-environment** switch; there is no "all environments read-only" global switch — use Disable to stop the plugin as a whole.

### SSH tunnel (manual)

For the case where the database sits behind a bastion and can only be reached over SSH. Fields:

| Field | Description |
| --- | --- |
| SSH host | A **domain or IP** (e.g. `203.0.113.10`). Do not enter an `~/.ssh/config` alias — a bare name without a dot is resolved by dbhub as an alias, which this plugin does not support. |
| Port | Defaults to `22`. |
| SSH user | The account used to log in to the bastion. |
| Auth | **Key** (enter the key path, e.g. `~/.ssh/id_ed25519`; a passphrase can be supplied for an encrypted key) or **password**. |
| ProxyJump | Optional, **single hop only**, format `[user@]host[:port]` (e.g. `203.0.113.11:22`). |
| Key passphrase / SSH password | **Entered in the UI only** — never through the model, never echoed back; when editing, **blank = keep the stored value**. |

Prerequisites and limits:

- Requires **dbhub 1.4.0 or newer**: on an older version the plugin fails with an explicit error and an upgrade hint — it never silently ignores the tunnel or the read-only setting.
- **The database address in the connection string must be the one the bastion sees**: e.g. when the database runs on the bastion itself, use `mysql://user:CHANGE_ME@127.0.0.1:3306/db`, not an address only your own machine can see.
- **Multi-hop bastions, `ProxyCommand` and ssh-agent are not supported** (dbhub shares one credential set across hops, so per-hop logins cannot be expressed); the plugin reports this explicitly and points you at a single hop.
- The plugin **never reuses or reads** any other plugin's SSH configuration (including DSH's own SSH tooling): the tunnel information comes only from what you fill in here.
- Read-only and the tunnel are independent switches; either can be used on its own.

### When a tunnel will not connect

1. Check the **bastion itself is reachable**: `ssh user@203.0.113.10` works from your machine.
2. Check the **host/port in the connection string is what the bastion can reach** — the most common cause (an address only your machine sees; when the database runs on the bastion itself, use `127.0.0.1`).
3. Check the **key path exists and is readable** (`~` is expanded), and enter the passphrase for an encrypted key.
4. Check it is a **single hop**: two or more comma-separated ProxyJump entries are refused.
5. Use "Test this configuration" in the form before saving — it probes the **effective connection** (tunnel + read-only; the first SSH handshake is slow, up to ~45 s) and tells you why it failed.

## dbhub Environment Variables

| Environment variable | Description | Default |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | npm package name used for auto-install (environment variable only, not exposed in the UI) | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | Seed for the auto-update interval in days; `0` disables (overridden once saved in the settings card) | `7` |

## 🔄 Automatic Installation & Updates

- **Auto-install on first use** — when `dbhub` is missing locally, the plugin installs it on the first execution; afterwards it also works offline.
- **Kept up to date automatically** — silently updates to the latest version in the background (interval under "Configure Page → configurable parameters"); on failure the existing version is kept.
- **Never touches your configuration** — a `dbhub` you installed yourself via PATH / mise is left untouched.

> The default update interval can also be seeded by an environment variable, see "Configure Page → Configuration"; once saved in the settings card, the saved value wins.

## Data Location

All configuration and credentials live outside the module directory (unaffected by pnpm packaging); deleting the directory clears everything:

```
~/.dsh/storages/dsh-dbhub-live/
```

Instances are isolated by `DSH_HOME`; multiple profiles of the same instance share it (same convention as dsh's own `workspace.json`). Workspace connections are stored per "workspace × environment" (`environments.default` is the default environment); legacy v1 single-connection entries migrate automatically at startup. The plugin cleans up and migrates legacy config left by upgrades or manual edits in one pass; it does not crash if the runtime directory is deleted or writes are blocked by the system — it recreates the directory, warns once and keeps running in memory when a write fails. **There is no resident dbhub process and no shared config file**: concurrent instances on the same machine — even sharing one DSH_HOME — do not interfere with each other. With read-only / an SSH tunnel enabled, each call generates a temporary dbhub configuration under `tmp/` — **the file holds placeholders only and no password**, it is deleted right after use, and leftovers from a crash are cleaned up on the next start.

## Uninstall

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot locate dbhub" on first use | Make sure npm is present and online; offline, install `dbhub` manually and add it to PATH. |
| A query to one environment fails with connection refused / auth error | Environments use independent one-shot connections: an unreachable environment only fails that call — other environments and calls keep working. The error carries guidance — for wrong credentials/details, ask the AI to run `dbhub_configure` and enter the password in the UI, or edit it directly in Plugins → dsh-dbhub-live → Configure. |
| Tools say "plugin disabled" | Open Plugins → dsh-dbhub-live → Configure and click "Enable". |
| The sidebar entry vanished after disabling the plugin | Expected: the sidebar entry follows the plugin's enabled state. Go to **Settings → DBHub Database Tools** (or Plugins → dsh-dbhub-live → Configure) and click "Enable" — the entry comes straight back. |
| A write reports `READONLY_VIOLATION` after enabling read-only | Not a fault — read-only mode is doing its job (dbhub rejects the write). To write, clear that environment's "Read-only mode" on the configure page; the model cannot turn it off. |
| The read-only / SSH controls are greyed out, or the plugin says dbhub is too old | Both need dbhub 1.4.0+. Upgrade dbhub, or delete `~/.dsh/storages/dsh-dbhub-live` and let the plugin auto-install a version that satisfies it. |
| An SSH tunnel will not connect | Check in order: the bastion is reachable → the address in the connection string is the one the bastion sees (use `127.0.0.1` when the database is on the bastion itself) → the key path exists and is readable → ProxyJump names a single hop. See "Read-only Mode and SSH Tunnels → When a tunnel will not connect". |
| Configure Page not visible | Confirm the plugin is installed and restart `dsh web`; the card only shows in the Web settings panel (`dsh web`) — on terminal environments without the panel, tool usage is unaffected. |
| dsh reports the plugin as incompatible after a dsh upgrade | That is dsh's peer-version check: upgrade the plugin to 5.0.0 or later (it serves both 0.1.x and 0.2.x). Forcing it through with `dsh plugin --profile web allow-version` does not help — the interface 4.x depends on is gone in 0.2.x, so the configure page stays empty. |
| No config files found by the scan | `node_modules` / `.git` / `target` / `dist` etc. are skipped by default; use "Enter DSN" or "Fill in fields" instead. |
| Need a custom dbhub version | Set the `DSH_DBHUB_PACKAGE` environment variable (e.g. `@bytebase/dbhub@1.4.0`; read-only / SSH tunnels need 1.4.0+) and restart; or delete `~/.dsh/storages/dsh-dbhub-live` and let it reinstall automatically. |
| Don't want automatic dbhub updates | Set "Auto-update interval (days)" to `0` in the Configure Page and save; or set `DSH_DBHUB_UPDATE_DAYS=0`. |
| Can't update the password in chat (the model asks you for it) | That is by design — the model must not handle passwords. Ask the AI to run `dbhub_configure` and fill in the password in the UI prompt, or edit it yourself in Plugins → dsh-dbhub-live → Configure. |

## License

[MIT](./LICENSE)