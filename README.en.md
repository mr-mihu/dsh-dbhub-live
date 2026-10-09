# dsh-dbhub-live

[简体中文](README.md) · **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#installation)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mr-mihu/dsh-dbhub-live)

> Let the AI inside [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) query your databases directly — **your password never enters the model context**.

Install it and you can simply tell the AI "show me the last 10 rows of the orders table". The AI runs SQL through [DBHub](https://dbhub.ai) (a database MCP server), but all it ever knows is *which environment of which workspace*, plus metadata such as `mysql://host:3306/db`; **passwords, accounts and full connection strings always stay on your machine**, typed only into the box in front of you.

![DBHub Database Tools configure page](doc/images/settings-page.png)

## Why use it

| | |
| --- | --- |
| 🔒 **Zero-knowledge credentials** | The model only sees type / host / port / database; the password is typed in the UI and never enters the model context |
| ⚡ **One-shot process** | No resident dbhub service: every call is its own process, killed the moment it finishes; a failed query only affects itself, and parallel instances never kill each other |
| 🧮 **Always 4 tools** | However many environments you add, the model context never grows |
| 🗂 **Per workspace × environment** | One workspace can hold `default` / `prod` / `dev`… (environment names may be Chinese), told apart by their `source` — never the wrong database |
| 🛡 **Per-environment read-only** | Writes are refused natively by dbhub; **the model can switch it on but never off** (only you can switch it off on the configure page) |
| 🔐 **Manual SSH tunnel** | Databases behind a bastion are reachable too; the SSH password / key passphrase is typed in the UI only |
| 📦 **Works out of the box** | If dbhub is missing it is installed for you, then kept up to date at your interval |

Supports **MySQL · PostgreSQL · MariaDB · SQLite · SQL Server**.

## Installation

```bash
# dsh already installed
dsh plugin --profile web add dsh-dbhub-live

# no dsh yet (use npx)
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live
```

Once installed, **restart `dsh web`** and open **Settings → DBHub Database Tools** to see the configure page (there is also a sidebar shortcut, and the Configure control on the plugin's row on the Plugins page — all three entries lead to the same page).

> Requirements: every `dsh` release line from 0.1.5 on (0.2.x included); Node.js ≥ 18 is recommended locally (it is used to install dbhub automatically). **Read-only mode and SSH tunnels need dbhub 1.4.0+** — the plugin detects this and gives you upgrade guidance.

## Quick Start

No commands to memorise — just talk to the AI:

```text
You: mysql on 192.0.2.10:3306, database app, account ops
AI:  (a dialog opens — you type the password there) → saved, source = myapp_1a2b3c_default
You: the last 10 rows of the orders table
AI:  … (query results)
```

The password is only ever typed into the box in front of you. If you give only part of the picture (say "connect to mydb on 192.0.2.10"), the plugin **probes with those non-sensitive facts first**: if it connects, the connection is saved straight away (password-less databases need no input at all); if only the password is missing it asks just for "account (when unknown) + password"; only when the information is incomplete do you choose a full method (enter a DSN / fill in fields / authorise a scan of project config files).

When the workspace already has `mise env` or a `.env` (`DSN` / `DB_*`), the plugin discovers it automatically — no manual configuration needed.

## Tools

| Tool | Description |
| --- | --- |
| `dbhub_configure(...)` | Configure / change a workspace connection. **It does not accept a `dsn` argument** — the password and connection string are always typed in the UI; `type`/`host`/`port`/`database`/`user` may be passed as non-sensitive prefills. Supports renaming with `env=<new name>` + `renameFrom=<old name>`, cross-workspace copying with `copyFrom=<another workspace's source>`, `readOnly:true` (`readOnly:false` is refused) and the tunnel options `sshHost`/`sshPort`/`sshUser`/`sshAuthKind`/`sshKeyPath`/`sshProxyJump` (**the SSH password and passphrase can only be typed by you in the dialog**). |
| `dbhub_list_sources()` | List every connection source, **grouped by workspace** and marking the **[CURRENT WORKSPACE]**; metadata and the **source value** only. |
| `dbhub_execute_sql(source, sql)` | Execute SQL on the given source; `source` comes from `dbhub_list_sources`. Every call is an independent one-shot connection; separate multiple statements with `;`. |
| `dbhub_search_objects(source, object_type, ...)` | Search database objects (tables / views / columns / indexes, etc.). |

> **Every source belongs to exactly one workspace**: to reuse a connection from another workspace, copy it over with `dbhub_configure`'s `copyFrom` — do not query another workspace's source directly.
> `search_objects` is currently available for SQLite only; for MySQL / PostgreSQL etc. use `dbhub_execute_sql` (e.g. `SHOW TABLES`).

## Configure Page

![Connection row and "Test SSH tunnel"](doc/images/row-editor.png)

- **Status and switch**: the running-status badge, the tool count (always 4), the environment count, the enable / disable switch, the most recent error.
- **Connection list**: organised by workspace. When every workspace has a single environment the rows render as flat cards; as soon as one workspace owns several environments they fold into per-workspace groups (click a group head to expand; the most recently used one is open by default). Each connection takes one line: environment name · 🔒 type / host / port / **database** · the `source` handle (click it to copy) · ⚡ test / ✏ edit / 🗑 delete. In a narrow window the host and port are truncated first, while **the database name always stays visible**.
- **Add / edit / delete**: use ✏ on a row to change the connection string or the environment name; "＋ Add connection" accepts Chinese environment names. **Saving onto an environment name that already exists asks "overwrite?" first** — cancel and not a single byte is written.
- **Connection test**: runs `SELECT 1` over **the effective connection that environment will really use** (read-only / tunnel included) and shows the elapsed time while it runs. The result is one-shot feedback: nothing is persisted and no connection state changes.
- **Settings strip** (⚙ Settings): the auto-update interval, and the "Show the sidebar entry" switch.

**"Show the sidebar entry" is not disabling the plugin**: switching it off merely hides the sidebar shortcut — the plugin keeps working and the model can still query; use "Disable" to stop the plugin as a whole (a disabled plugin always hides the entry). In either state, **the settings page and the Plugins row's Configure control always stay reachable**, so the change can be undone at any time.

## 🔒 Read-only Mode and SSH Tunnels

Both are **per-environment** connection options executed by dbhub's native features. Once either is on, every execution in that environment switches to a **temporary, generated dbhub configuration** (the file holds only `${…}` placeholders and no password at all — the real values reach the child process through its environment) and is deleted as soon as the call ends; every other environment is unaffected.

**Read-only mode**: click ✏ on a connection row, tick "Read-only mode" and save (the model can enable it for an environment too). dbhub then lets read statements through only (measured on MySQL: `select/with/explain/show/describe/desc`), and writes come straight back as `READONLY_VIOLATION`; object search keeps working. **Turning read-only off is something only you can do on the configure page** — an attempt by the model is refused. A read-only environment's name gains a small "RO" badge.

**SSH tunnel** (configured by hand, for databases sitting behind a bastion):

| Field | Description |
| --- | --- |
| SSH host | A **domain or IP** (e.g. `203.0.113.10`); do not enter an alias from `~/.ssh/config` |
| Port | Defaults to `22` |
| SSH user | The account used to log in to the bastion |
| Auth | **Key** (enter the key path; give a passphrase if the private key has one; **blank = the default `~/.ssh/id_ed25519`**) or **password** |
| ProxyJump | Optional, **one hop only**, format `[user@]host[:port]` |
| Key passphrase / SSH password | **Typed in the UI only**, never echoed back; when editing, **blank = keep the stored value** |

"Advanced: SSH tunnel" holds **two** test buttons:

- **"Test SSH tunnel"** validates the tunnel layer alone: it first probes TCP reachability of `ssh_host:ssh_port` (about 5 seconds; a failure carries a code such as `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`), with key auth it checks that the private key file exists and is readable, and finally it **deliberately** asks dbhub to open a tunnel to an address that cannot possibly be listening — then decides from the evidence: an error carrying **SSH signatures** (handshake / authentication / private key) means the tunnel is down; one carrying a **database-layer signature** (`PROTOCOL_CONNECTION_LOST`, `Connection lost`, `Access denied`, `Unknown database`, `ER_*`, `ECONNREFUSED` and the like) means the connection **already got past the tunnel**, so the verdict is "SSH tunnel works"; only when neither is present does it honestly say "cannot be determined", with the tail of the output attached.
- **"Test this configuration"** probes the **effective connection** (tunnel + read-only) for real.

> **One line to remember**: a **database-layer** error means the tunnel is already up — the problem is the database behind it (authentication / database name / target address), so SSH need not be suspected any longer.
>
> **Honest limit**: the SSH-layer test proves "the network is reachable + the key is present + the SSH layer comes up"; it is not a full session test against a real database — a tunnel coming up does not mean the database behind it is reachable, and that question is answered by "Test this configuration".

Order of checks: ① your machine can log in with `ssh user@bastion`; ② **the address in the connection string must be the one the bastion sees** (write `127.0.0.1` when the database runs on the bastion itself) — this is the most common cause; ③ the key path exists and is readable (remember the passphrase for an encrypted key); ④ ProxyJump is a single hop.

**Prerequisites and limits**: dbhub **1.4.0+** is required (an older version fails with an explicit error rather than being silently ignored); multi-hop, `ProxyCommand` and ssh-agent are **not supported**, and the plugin does **not reuse** the SSH configuration of any other plugin (including DSH's own SSH tooling) — the tunnel information comes only from what you type in. Read-only and SSH are two independent switches; either can be used on its own.

## Data Location

All configuration and credentials live outside the module directory; delete that directory and everything is cleared:

```
~/.dsh/storages/dsh-dbhub-live/
```

Isolated per `DSH_HOME` and shared by multiple profiles of the same instance (the same convention as dsh's own `workspace.json`). Connections are stored per "workspace × environment"; old formats and leftovers from manual edits are cleaned up and migrated in one pass at startup, and the plugin does not crash if the runtime directory is deleted by accident or a write is blocked. **There is no resident process and no shared configuration file**, so several instances running at once on one machine never interfere.

## Uninstall

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot fetch dbhub" on first use | Make sure npm is present and the machine can reach the network; offline, install `dbhub` by hand and add it to PATH. |
| A connection to one environment is refused / authentication fails | That environment is an independent one-shot connection, so only this one call is affected. The end of the error carries guidance: ask the AI to run `dbhub_configure` and walk you through updating the password in the UI, or edit it directly on the configure page. |
| The tools report "plugin disabled" | Go to **Settings → DBHub Database Tools** and click "Enable". |
| The sidebar entry is gone after disabling | Expected behaviour (a disabled plugin contributes no entry). Click "Enable" and the entry is back immediately. |
| A write reports `READONLY_VIOLATION` after read-only was turned on | Not a fault — read-only is doing its job. To write, clear that environment's "Read-only mode" on the configure page (the model cannot turn it off). |
| The read-only / SSH controls are greyed out, or dbhub is reported as too old | Both need dbhub 1.4.0+: upgrade dbhub, or delete `~/.dsh/storages/dsh-dbhub-live` so the plugin installs a version that satisfies it. |
| A connection test fails and you cannot tell why | Read the **end** of the message (the diagnostic is the tail of dbhub's output and marks the layer: [SSH layer] / [database layer] / [plugin layer]). **A [database layer] report means the tunnel is already up**; with a tunnel configured, press "Test SSH tunnel" first to verify the SSH layer on its own. |
| The configure page is not visible | Check the plugin is installed and `dsh web` has been restarted; the page only shows in the Web settings panel and does not affect tool usage in terminal environments. |
| After a dsh upgrade the plugin is reported as incompatible | Upgrade the plugin to 5.0.0+ (it supports both 0.1.x and 0.2.x); forcing it through with `allow-version` buys nothing. |
| Automatic dbhub updates are not wanted | Set "Auto-update interval (days)" to `0` on the configure page and save, or set `DSH_DBHUB_UPDATE_DAYS=0`. |

**Environment variables** (only these two, not exposed in the UI): `DSH_DBHUB_PACKAGE` (the package that gets auto-installed, default `@bytebase/dbhub`), `DSH_DBHUB_UPDATE_DAYS` (the seed for the auto-update interval, default `7`, overridden by the value saved on the configure page).

## License

[MIT](./LICENSE)
