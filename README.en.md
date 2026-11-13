# dsh-dbhub-live

[简体中文](README.md) · **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#installation)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mr-mihu/dsh-dbhub-live)

> Let the AI inside [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) query your databases directly — **the password is typed in the UI, not passed to the model as a tool argument**.

Install it and you can simply tell the AI "show me the last 10 rows of the orders table". The AI runs SQL through [DBHub](https://dbhub.ai) (a database MCP server), but all it ever knows is *which environment of which workspace*, plus metadata such as `mysql://host:3306/db`; **passwords, accounts and full connection strings always stay on your machine**, typed only into the box in front of you.

<details>
<summary>📷 Preview: Settings → DBHub Database Tools</summary>

![DBHub Database Tools wide page: status line, one compact settings bar, connections grouped by workspace, and a successful connection-test receipt](https://raw.githubusercontent.com/mr-mihu/dsh-dbhub-live/dev/doc/images/test-success.png)


</details>

## Why use it

| | |
| --- | --- |
| 🔒 **Credentials stay out of tool arguments** | The model only sees type / host / port / database; the password and the full DSN are not accepted as tool arguments — they are typed in the UI |
| ⚡ **One-shot process** | No resident dbhub service: every call is its own process, killed the moment it finishes; a failed query only affects itself, and parallel instances never kill each other |
| 🧮 **Always 4 tools** | However many environments you add, the model context never grows |
| 🗂 **Per workspace × environment** | One workspace can hold `default` / `prod` / `dev`… (environment names may be Chinese), told apart by their `source` — never the wrong database |
| 🛡 **Per-environment read-only** | Writes are refused natively by dbhub; **the model can switch it on but never off** (only you can switch it off on the configure page) |
| 🚦 **Honours the session permission** | With "Read Only" selected in the composer, write statements are refused outright; with "Workspace Write" every write asks you first |
| 🔐 **Manual SSH tunnel** | Databases behind a bastion are reachable too; the SSH password / key passphrase is typed in the UI only |
| 🔗 **Pick sources with `@` in the composer** | Type `@` in the message box and pick a connection; **one message may reference several**, each on its own database |
| 📦 **Works out of the box** | If dbhub is missing it is installed for you, then kept up to date at your interval |

Supports **MySQL · PostgreSQL · MariaDB · SQLite · SQL Server**.

<!-- release-test:versions:begin -->
## Supported version range

**From DSH 0.2.1 (lines 0.2.1 / 0.2.2, prereleases included)** — 4 declared versions verified (last verified 2026-11-12).

<details>
<summary>Per-version verification details (expand)</summary>

| DSH version | UI | Boot | Hard checks | Result | Last verified |
| --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.2` | modern | 5.7s | 21 | ✅ pass | 2026-11-12 · 42462db5 |
| `0.2.1-rc.5` | modern | 21.1s | 21 | ✅ pass | 2026-11-12 · 42462db5 |
| `0.2.2-rc.1` | modern | 5.5s | 21 | ✅ pass | 2026-11-12 · 42462db5 |
| `0.2.2-rc.2` | modern | 5.5s | 21 | ✅ pass | 2026-11-12 · 42462db5 |

</details>

Full evidence, review rules and known drift live in [doc/SUPPORT-MATRIX.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/SUPPORT-MATRIX.md).
<!-- release-test:versions:end -->

## Installation

```bash
# web (dsh web)
dsh plugin --profile web add dsh-dbhub-live

# desktop
dsh plugin --profile desktop add dsh-dbhub-live

# no dsh yet (use npx): same commands, prefix them with npx @deepseek-ai/dsh
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live
npx @deepseek-ai/dsh plugin --profile desktop add dsh-dbhub-live
```

On desktop you can also **install entirely through the UI**: **left menu → Plugins → Add → type `dsh-dbhub-live` (or search the plugin marketplace) → Install**. **The same plugin works on both the web profile and the desktop profile**, with the same UI and behaviour; installing, updating and uninstalling on desktop can all be done on that Plugins page.

Once installed, **restart `dsh web`** and open **Settings → DBHub Database Tools** to see the configure page (there is also a sidebar shortcut, and the Configure control on the plugin's row on the Plugins page — all three entries lead to the same page).

> Requirements: **DSH 0.2.1 or later** (0.2.1 prereleases included; **0.1.x and 0.2.0 are no longer supported**). On an older host the plugin does not go blank: the configure page shows one bilingual notice naming the required and the running version, and every tool, connection and setting keeps working — but upgrade DSH soon. Node.js ≥ 18 is recommended locally (it is used to install dbhub automatically). **Read-only mode and SSH tunnels need dbhub 1.4.0+** — the plugin detects this and gives you upgrade guidance. Per-version verification results live in [doc/SUPPORT-MATRIX.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/SUPPORT-MATRIX.md) (generated by the release test, which must pass before every release).

## Updating

**Web** (command line):

```bash
dsh plugin --profile web up dsh-dbhub-live@<latest version>
```

Then **restart `dsh web`**.

**Desktop**: uninstall the plugin on the **left menu → Plugins** page and reinstall the latest version (desktop updates go through the visual Plugins page). **Connections and credentials survive the reinstall** — they live in `~/.dsh/storages/dsh-dbhub-live`, independent of the module directory.

**No need to remember version numbers**: the configure page header shows the plugin name and the current version; when a newer version exists a quiet "**↑ Upgrade to <latest>**" text link appears and **clicking it opens a panel where you copy** `dsh-dbhub-live@<latest>`; the "Check for updates" button next to it checks on demand. Opening the page also triggers one automatic check (throttled, so it does not hit the network on every open). Checks use the **npm registry first, with GitHub Releases as the fallback**; release notes live in [GitHub Releases](https://github.com/mr-mihu/dsh-dbhub-live/releases).

> The version/update hint needs plugin 5.2.0+ and DSH 0.2.1+ (see "Configure Page").

## Quick Start

No commands to memorise — just talk to the AI:

```text
You: mysql on 192.0.2.10:3306, database app, account ops
AI:  (a dialog opens — you type the password there) → saved, source = myapp_1a2b3c_default
You: the 3 most recent rows of the orders table
AI:  … (query results)
```

<details>
<summary>📷 In action: ask the AI, get the query results</summary>

![Asking the AI and getting query results](https://raw.githubusercontent.com/mr-mihu/dsh-dbhub-live/dev/doc/images/chat-query.png)

</details>

The password is only ever typed into the box in front of you. If you give only part of the picture (say "connect to mydb on 192.0.2.10"), the plugin **probes with those non-sensitive facts first**: if it connects, the connection is saved straight away (password-less databases need no input at all); if only the password is missing it asks just for "account (when unknown) + password"; only when the information is incomplete do you choose a full method (enter a DSN / fill in fields / authorise a scan of project config files).

> **Do not paste a password into the chat.** The plugin itself does not hand the password to the model, but **anything you paste into the conversation does enter the context** — the plugin cannot prevent that, and cannot take it back.

When the workspace already has `mise env` or a `.env` (`DSN` / `DB_*`), the plugin discovers it automatically — no manual configuration needed.

## Reference sources with `@` in the composer (several per message)

Type **`@`** in the message box and the menu gains a **DBHub** group: one row per configured connection — "alias · workspace · type/host/port/database", with a **read-only** marker when it applies. Picking one inserts a **reference chip** just like `@file`; **one message may carry several of them**:

```text
You: in @app_prod look up the tables referencing orders, then match them against @billing_prod
```

- **Each chip serializes on its own**: on submit every reference becomes a model-readable `@db:<source handle>`, and the model maps each marker, in order, to its own database. The policy section also carries a compact "alias → handle" catalog (aliases and handles only), so the model never has to guess.
- **Aliases** are computed by the plugin over the **whole connection set**: the environment name itself when it is unique across all workspaces (`@prod`), otherwise `<workspace>_<env>` (`@app_prod` / `@billing_prod`), and only then a `-2` / `-3` suffix. An alias is display/typing sugar — identity is the immutable `source` handle, so renaming or adding connections never invalidates a chip already in the draft.
- The menu carries **the alias, the workspace title, connection metadata (type, host, port, database) and the read-only marker** only — **never a DSN, account or password**. A disabled plugin, an unresolved state or a failed read yields an empty group (no invented data), and a hand-typed `@alias` is recognised as a reference too.
- Requires a host that provides the composer `@` trigger service; on a deployment without it the group simply does not appear and everything else keeps working.

## Tools

| Tool | Description |
| --- | --- |
| `dbhub_configure(...)` | Configure / change a workspace connection. **It does not accept a `dsn` argument** — the password and connection string are always typed in the UI; `type`/`host`/`port`/`database`/`user` may be passed as non-sensitive prefills. Supports renaming with `env=<new name>` + `renameFrom=<old name>`, cross-workspace copying with `copyFrom=<another workspace's source>`, `readOnly:true` (`readOnly:false` is refused) and the tunnel options `sshHost`/`sshPort`/`sshUser`/`sshAuthKind`/`sshKeyPath`/`sshProxyJump` (**the SSH password and passphrase can only be typed by you in the dialog**). |
| `dbhub_list_sources()` | List every connection source, **grouped by workspace** and marking the **[CURRENT WORKSPACE]**; metadata and the **source value** only. |
| `dbhub_execute_sql(source, sql, maxRows?, export?)` | Execute SQL on the given source; `source` comes from `dbhub_list_sources`. Every call is an independent one-shot connection; separate multiple statements with `;`. The optional `maxRows` overrides that environment's "max rows returned": a positive integer = at most that many rows per statement for this call, `0` = no limit for this call, omitted = use the environment setting (see "Result row limit" below). The optional `export` (`csv` / `json`) writes the result rows into host-local files and returns a summary plus absolute paths (see "Result export" below). |
| `dbhub_search_objects(source, object_type, ...)` | Search database objects (tables / views / columns / indexes, etc.). |

> **Every source belongs to exactly one workspace**: to reuse a connection from another workspace, copy it over with `dbhub_configure`'s `copyFrom` — do not query another workspace's source directly.
> `search_objects` is currently available for SQLite only; for MySQL / PostgreSQL etc. use `dbhub_execute_sql` (e.g. `SHOW TABLES`).

## Model-facing database access policy

While the plugin is enabled it contributes a **system-prompt section** (about 600 characters, plus a compact "alias → handle" catalog once connections exist) that keeps database access on this plugin and states how it coexists with **other database plugins**:

- **One authorized route — scoped to this plugin's own connections**: every database listed by `dbhub_list_sources` goes through the `dbhub_*` tools; no `psql` / `mysql` / `sqlite3` / `sqlcmd` / `pg_dump` command-line client, throwaway script, driver, other MCP, or **other database plugin** is used to reach them, and the agent does not go looking for such an executable on the host.
- **A workspace "recipe" is not authorization**: direct-connection instructions found in project docs, scripts, or `AGENTS.md` (for example a psql recipe an earlier session wrote itself) are never followed — the system prompt outranks workspace instructions.
- **Read-only is the user's safety boundary**: after a `READONLY_VIOLATION` the agent must not complete the write by any other route (**including another database plugin**); it reports the reason and the impact instead.
- **Databases this plugin does not cover stay with the plugin that does**: dbhub speaks MySQL / PostgreSQL / MariaDB / SQLite / SQL Server only. MongoDB / Redis / Oracle and any instance **you never configured here** are explicitly handed to the other database plugin you installed — the agent must not refuse them for the sake of "everything through this plugin", and must not fall back to a command-line connection either.
- **The same database configured in both plugins**: the default is this plugin's source (read-only and tunnel settings live here); the agent switches only when you explicitly ask for the other tool, and asks you when it cannot tell.
- **Operations this plugin cannot do**: backups and non-SQL administration commands are reported as a limitation, and the agent asks you for an authorized route instead of improvising.

**Switch**: "Announce the database-access policy to the model" in the settings (expanded inline in the wide page's settings block; in the modal layout it sits behind the ⚙ Settings strip), **on by default**; a deployment can also pin it with `config: { announceAccessPolicy: false }` in `cordis.patch.yml`. Turning it off only removes that text — tools, read-only, tunnels and every other setting keep working.

**No plugin suppression**: this plugin does not (and cannot) disable another database plugin you installed. The conflict is resolved by the three rules above — scope, a default for overlapping targets, and asking you when it cannot tell. Which plugin to disable is your decision, made on the Plugins page.

**Honest boundary**: this policy is a **prompt-level (soft) constraint**; read-only itself is **hard-rejected** by dbhub inside the plugin. A shell-level connection that bypasses the plugin is outside the plugin's control — the policy names it explicitly, but it relies on the model complying rather than blocking it.

## Configure Page

<details>
<summary>📷 Add connection: read-only mode and SSH tunnel</summary>

![Add-connection form, with a successful "Test SSH tunnel" receipt](https://raw.githubusercontent.com/mr-mihu/dsh-dbhub-live/dev/doc/images/ssh-tunnel.png)


</details>

The same component offers **three layouts**, picked automatically from the host surface and the window width (needs plugin 5.2.0+ and **DSH 0.2.1+**, see the end of this section):

| Layout | How to reach it | Shape |
| --- | --- | --- |
| Modal | **Settings → DBHub Database Tools** | A narrow modal, same density as before, settings behind the "Settings" disclosure on the status line |
| Wide page | The **DBHub** entry in the left menu / the Configure control on the Plugins row | A full page in a wide column, with the version and upgrade entry in the header and settings rows expanded inline |
| Small screen | A mobile browser, width < ~700px | Stacked and compact, controls sized for touch |

**Header: version and upgrade entry**: the title is the plugin name with the current version (small, muted) right next to it; when a newer version exists a quiet "**↑ Upgrade to <latest>**" text link appears on the right, and **clicking it expands** the update notes — the `dsh-dbhub-live@<latest>` spec (click to copy), the update command / steps for this deployment, and a link to the release notes; the "↻" button checks on demand. Opening the page also triggers an automatic check (throttled). Checks use the npm registry first, with GitHub Releases as the fallback. **An update is neutral news, never styled as an error.**

- **Status line**: it shows only "running / disabled · N connections". Implementation facts — tool count, one-shot execution mode, dbhub version — live in the collapsed "ⓘ Details" block below the status line.
- **Connection list**: organised by workspace. When every workspace has a single environment the rows render as flat cards; as soon as one workspace owns several environments they fold into per-workspace groups (click a group head to expand; the most recently used one is open by default). Each connection takes one line: environment name · type / host / port / **database** · **read-only switch** · the `source` handle (click it to copy) · test / edit / delete. In a narrow window the host and port are truncated first, while **the database name always stays visible**. Above the list sit the **search box, the sort switch and "Test all"** (see "Connection search, sort and batch test" below).
- **Settings (DSH-native style, deliberately quiet)**: on the wide page the four controls collapse into **one compact settings line** — `Plugin settings · Enable plugin [enabled] · Sidebar entry [shown] · Access policy [on] · Auto-update [7] days [save] · ⓘ details`; the modal and the phone use compact stacked rows. Fonts and switches are kept small so the **connection list** stays the main content. The controls are DSH's own switches (theme/skin aware, with state words); every explanatory paragraph lives in "ⓘ Details & diagnostics".
- **Read-only switch (outside the edit form in all three layouts)**: right next to the datasource on every connection row there is a small "RO" toggle — one click flips it (open lock + "Writable" = writable; closed lock + "RO" = read-only) without opening the edit form; the modal and the phone layout have it too. The tick-box in the edit form stays as well; both are the same state. **The connection string itself no longer carries a lock icon** — it used to read like "this row needs a password" and clashed with the read-only lock.
- **Add / edit / delete**: use ✏ on a row to change the connection string or the environment name; "＋ Add connection" accepts Chinese environment names. **Saving onto an environment name that already exists asks "overwrite?" first** — cancel and not a single byte is written. **Deleting asks first too** (it cannot be undone; cancelling writes nothing either).
- **A failed write is always visible**: when a save / switch / delete is refused (401, offline, a Host refusal) the page shows an error line and **never** claims "Saved ✓"; fixing it and clicking again is the retry. A failed plugin-state read shows its own error line plus "Retry" instead of silently turning into "no connections". "Auto-update interval" only accepts a whole number of days from 0 to 365 — an empty box or a fraction is rejected on the spot and no request is sent.
- **Connection test**: runs `SELECT 1` over **the effective connection that environment will really use** (read-only / tunnel included) and shows the elapsed time while it runs. The result is one-shot feedback: nothing is persisted and no connection state changes. When the command never reaches the Host (bridge 401 / offline) it says "the test command never reached the host" immediately instead of reporting a timeout 30 seconds later.

**"Show the sidebar entry" is not disabling the plugin**: switching it off merely hides the sidebar shortcut — the plugin keeps working and the model can still query; use "Disable" to stop the plugin as a whole (a disabled plugin always hides the entry). In either state, **the settings page and the Plugins row's Configure control always stay reachable**, so the change can be undone at any time.

**When DSH is too old**: the configure page gains one warning at the top (naming "DSH 0.2.1 or later" and the running version); the page, connections, read-only switches and tools all keep working — the plugin is not broken, the host just needs an upgrade.

## 🔒 Read-only Mode and SSH Tunnels

Both are **per-environment** connection options executed by dbhub's native features. Once either is on, every execution in that environment switches to a **temporary, generated dbhub configuration** (the file holds only `${…}` placeholders and no password at all — the real values reach the child process through its environment) and is deleted as soon as the call ends; every other environment is unaffected.

**Read-only mode**: in all three layouts the connection row carries a small "RO" switch next to the datasource — one click flips it (you can also click ✏ and tick it in the edit form; the model can enable it for an environment too). dbhub then lets read statements through only (measured on MySQL: `select/with/explain/show/describe/desc`), and writes come straight back as `READONLY_VIOLATION`; object search keeps working. **Turning read-only off is something only you can do on the configure page** — an attempt by the model is refused. A read-only environment's name gains a small "RO" badge.

**The session permission is a second gate**: the mode you pick in the composer ("Read Only" / "Workspace Write" / "Full access") gates write statements **independently of the per-environment read-only switch**; both apply:

| Env read-only | Session permission | Write statement | Read statement |
| --- | --- | --- | --- |
| on | any | unchanged: dbhub refuses it (`READONLY_VIOLATION`) | runs |
| off | Full access | runs directly | runs |
| off | Workspace Write | **asks you for confirmation** (once per write; a refusal means it does not run) | runs |
| off | Read Only | **refused outright** (dbhub is not even started) | runs |

Only the statement's **first keyword** matters: `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `VALUES` / `TABLE` / `PRAGMA`, and `WITH … SELECT`, count as reads; everything else counts as a write. It is deliberately **conservative**: one write anywhere in a multi-statement text makes the whole call a write (`SELECT 1; DROP TABLE t`). A refusal states the reason and the next step (and explicitly forbids falling back to a command-line client, a throwaway script, or another plugin). Where the runtime has no session-permission layer (headless / automated calls), this gate is not installed and behaviour is exactly as before.

**SSH tunnel** (configured by hand, for databases sitting behind a bastion):

| Field | Description |
| --- | --- |
| SSH host | A **domain or IP** (e.g. `203.0.113.10`); do not enter an alias from `~/.ssh/config` |
| Port | Defaults to `22` |
| SSH user | The account used to log in to the bastion |
| Auth | **Key** (enter the key path; give a passphrase if the private key has one; **blank = the default `~/.ssh/id_ed25519`**) or **password** |
| ProxyJump | Optional, **one hop only**, format `[user@]host[:port]` |
| Key passphrase / SSH password | **Typed in the UI only**, never echoed back; when editing, **blank = keep the stored value** |

The password/passphrase is stored in the **DSH credential store** (by default `~/.dsh/.credentials.yaml`); the plugin's own connection file keeps only a reference name, so no plaintext secret appears there (connections created before the credential service was available keep plaintext and log a one-time notice). **The database password works the same way**: the stored DSN is stripped of its password and the value goes into the same credential store, then the plugin joins it back for every connection (when a shape cannot be split safely, the DSN is left as-is and a one-time notice is logged).

"Advanced: SSH tunnel" holds **two** test buttons:

- **"Test SSH tunnel"** validates the tunnel layer alone: it first probes TCP reachability of `ssh_host:ssh_port` (about 5 seconds; a failure carries a code such as `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`), with key auth it checks that the private key file exists and is readable, and finally it **deliberately** asks dbhub to open a tunnel to an address that cannot possibly be listening — then decides from the evidence: an error carrying **SSH signatures** (handshake / authentication / private key) means the tunnel is down; one carrying a **database-layer signature** (`PROTOCOL_CONNECTION_LOST`, `Connection lost`, `Access denied`, `Unknown database`, `ER_*`, `ECONNREFUSED` and the like) means the connection **already got past the tunnel**, so the verdict is "SSH tunnel works"; only when neither is present does it honestly say "cannot be determined", with the tail of the output attached.
- **"Test this configuration"** probes the **effective connection** (tunnel + read-only) for real.

> **One line to remember**: a **database-layer** error means the tunnel is already up — the problem is the database behind it (authentication / database name / target address), so SSH need not be suspected any longer.
>
> **Honest limit**: the SSH-layer test proves "the network is reachable + the key is present + the SSH layer comes up"; it is not a full session test against a real database — a tunnel coming up does not mean the database behind it is reachable, and that question is answered by "Test this configuration".

Order of checks: ① your machine can log in with `ssh user@bastion`; ② **the address in the connection string must be the one the bastion sees** (write `127.0.0.1` when the database runs on the bastion itself) — this is the most common cause; ③ the key path exists and is readable (remember the passphrase for an encrypted key); ④ ProxyJump is a single hop.

**Prerequisites and limits**: dbhub **1.4.0+** is required (an older version fails with an explicit error rather than being silently ignored); multi-hop, `ProxyCommand` and ssh-agent are **not supported**, and the plugin does **not reuse** the SSH configuration of any other plugin (including DSH's own SSH tooling) — the tunnel information comes only from what you type in. Read-only and SSH are two independent switches; either can be used on its own.

## ✂️ Result row limit (per environment + per call)

Every connection can carry a **maximum rows returned**: `dbhub_execute_sql` returns at most that many rows per statement, so a single `select *` cannot pour a whole table into the model context. The default is **no limit**, and existing connections behave exactly as before.

- **Where to set it**: connection row ✏ → expand "Advanced: SSH tunnel"; the "Max rows" number input sits at the bottom (placeholder "0 or blank = unlimited"). A capped connection says "max N rows" in its environment-name tooltip. The cap is stored **per environment**, with that connection; a negative number, a fraction or non-numeric text is **refused on the spot without sending a request**.
- **Truncation is always visible**: the receipt's **first line** states the effective cap, the original row count of every truncated statement, and that `maxRows` can override it for this call. A truncated statement carries `truncated: true` and `shown: N`, while its original `count` is preserved.
- **Per-call override**: pass `maxRows` to `dbhub_execute_sql` — a positive integer caps each statement for this call, **`0` means no limit at all for this call**, and omitting it uses the environment setting. Priority is **call argument > environment setting**; it affects only that call, never changes the stored value, and is **never forwarded to dbhub**.
- **How and where it happens**: the plugin trims the result host-side (dbhub's `max_rows` is static configuration and cannot express a per-call limit); when the result is not the expected JSON or its shape differs, it is returned **verbatim** — trimming never turns a good result into a broken one. A hand-edited invalid environment value is treated as "unlimited", so it can neither shrink every query to one row nor make the environment fail.

## 📤 Result export (CSV / JSON)

When a result has a lot of rows, writing it to a local file is far more useful than pouring it into the conversation — that is what export is for:

- **How to ask for it**: just say "export the result as CSV / JSON" (or "export it to a file"). The AI then passes `export` (`csv` or `json`) to `dbhub_execute_sql`. The receipt it gets back is a **summary plus the absolute file path(s)** — the rows never enter the conversation, and the AI tells you where the file is and how many rows it holds.
- **Export ignores the "max rows returned" setting**: an export means "all of it", so the environment's row cap does **not** apply by default; only an explicit `maxRows` truncates (and then the receipt's first line still says the result was truncated).
- **Multiple statements**: `csv` writes one file per statement (`…-1.csv`, `…-2.csv`); `json` writes one file holding every statement (`{source, statements:[{sql, rows, count}], exportedAt}` — **no connection string**).
- **Where the files are**: `~/.dsh/storages/dsh-dbhub-live/exports/` (isolated per `DSH_HOME`). Names look like `<source handle>-<yyyymmdd-hhmmss>-<seq>.csv` (the timestamp is UTC); non-ASCII environment names (Chinese, emoji) are escaped to safe ASCII and can never land outside that directory. CSV is **UTF-8 without BOM, RFC 4180 (CRLF line endings)**, so Excel, pandas and database `import` read it directly.
- **How to clean up**: the plugin **never deletes** export files automatically (they share the data directory and lifecycle with your connections). Delete files under `exports/` when you no longer need them; deleting the whole `~/.dsh/storages/dsh-dbhub-live` clears everything.
- **A failed write never fails the query**: if the file cannot be written (permissions, disk full), the receipt falls back to the ordinary **inline result** and appends "export failed (<code>); the result is returned inline instead" — the query itself still succeeds. Export files stay on your machine; the summary carries only the source handle, row counts and paths — no connection string, account or password.

## 🔎 Connection search, sort and batch test

Once the list grows, it has to be filterable, orderable and verifiable in one go — all three live on **one line above the connection list**, in all three layouts (dialog / wide page / phone):

- **Search**: type into "Search connections…" and the list is filtered by a case-insensitive substring over the **workspace title / environment name / alias / connection metadata** (Chinese environment names work too, e.g. 线上). An "N / M" counter marks the filter as active and "Clear search" removes it; **no hit says "No matching connections"**, never "you have no connections configured". The filter **only changes what is displayed** — every save, test and delete still targets the row you clicked.
- **Sort**: `Name` (default: workspace title, then environment name) and `Recently updated` (the most recently touched workspace first, falling back to the name order on a tie). The GROUP order follows the sort too, so the list never reads half-sorted. The choice is remembered for this page only — nothing is persisted.
- **Batch test**: the button reads "**Test all (N)**" and **N is the number of rows you can see** (filter to 2 and only 2 run). At most **2** probes run at a time (each one spawns a whole dbhub process host-side); every row shows its own `waiting` / `testing…` / `passed ✓` / `failed ✗ · reason`, with a tally above: "x passed / y failed / z untested". While it runs the button becomes "**Stop**": rows that never started go back to untested and **requests already dispatched are allowed to finish** (the protocol has no cancellation, so the plugin does not pretend to cancel). Batch and single-row tests use the same `{op:'test'}` command and the same 30s / 60s watchdog; failure reasons come from the same localized copy. The batch adds **no interval** — it reads each `POST /op` answer and stops when the run is over.

## Data Location

All configuration and credentials live outside the module directory; delete that directory and everything is cleared:

```
~/.dsh/storages/dsh-dbhub-live/
```

Isolated per `DSH_HOME` and shared by multiple profiles of the same instance (the same convention as dsh's own `workspace.json`). Connections are stored per "workspace × environment"; old formats and leftovers from manual edits are cleaned up and migrated in one pass at startup, and the plugin does not crash if the runtime directory is deleted by accident or a write is blocked. **There is no resident process and no shared configuration file**, so several instances running at once on one machine never interfere. **Upgrading, reinstalling or uninstalling the plugin never touches this directory** — including the desktop upgrade path of "uninstall, then reinstall the latest": connections, read-only / tunnel settings and credentials are all preserved.

That connection file holds **no passwords**: the DSN is stored without its database password and the file keeps only reference names. **The SSH login password, the key passphrase and the database password are stored in the DSH credential store** (by default `~/.dsh/.credentials.yaml`, managed by DSH); at startup the plugin moves plaintext secrets that older builds wrote into the connection file into that store in one pass. When the move fails (credential service unavailable) or a connection's password cannot be split out safely, the connection stays as it is, one notice is logged, and it keeps working (the card marks that row's environment tooltip so the value is still in the local file).

The same data directory also holds `exports/`: **query-result exports** (CSV / JSON) are written there, the plugin **never cleans them up automatically**, and you can delete the files when you no longer need them (see "Result export").

## Uninstall

```bash
# web
dsh plugin --profile web remove dsh-dbhub-live

# desktop
dsh plugin --profile desktop remove dsh-dbhub-live
```

On desktop you can also uninstall directly on the **left menu → Plugins** page. Uninstalling does not delete connections or credentials (see "Data Location"); to wipe everything, delete `~/.dsh/storages/dsh-dbhub-live` by hand.

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
| The configure page is not visible | Check the plugin is installed: restart `dsh web` on the web side; on desktop use the Configure control on the Plugins row or the DBHub entry in the left menu. The page only shows in the Web / desktop UI and does not affect tool usage in terminal environments. |
| The configure page says the DSH version is too old | The plugin needs **DSH 0.2.1+** (prereleases included); upgrade dsh and restart. The tools and the page keep working until you do — the notice is only a reminder. |
| No "Upgrade to …" hint appears in the header | You may already be on the latest version, or this check could not reach the npm registry / GitHub Releases; press "Check for updates" to retry. A failed check is only a hint and does not affect plugin functionality. |
| How do I upgrade on desktop | Uninstall on the **left menu → Plugins** page, then reinstall the latest version; connections and credentials live in `~/.dsh/storages/dsh-dbhub-live` and are still there after the reinstall. |
| After a dsh upgrade the plugin is reported as incompatible | Check that dsh is 0.2.1 or later, then upgrade the plugin to the latest version; forcing it through with `allow-version` buys nothing. |
| The configure page keeps saying "the plugin state could not be read" | The panel cannot reach the Host half, usually because the **plugin is disabled** or the **Host half never loaded**: check under **Settings → Plugins** that the row is enabled, and restart DSH after a version change. Tool calls are unaffected — only this panel cannot read the state. |
| Connections fail to authenticate after downgrading below 6.1 | From 6.1 on, the database password is split out of the connection string into the DSH credential store, and older versions cannot read it (a URL DSN is treated as password-less; a property DSN sends the placeholder as the password). **Re-enter those DSNs once before downgrading** (the password then returns to the connection file), or stay on 6.1+. The password itself is not lost — it is still in the credential store. |
| Automatic dbhub updates are not wanted | Set "Auto-update interval (days)" to `0` on the configure page and save, or set `DSH_DBHUB_UPDATE_DAYS=0`. |

**Environment variables** (only these two, not exposed in the UI): `DSH_DBHUB_PACKAGE` (the package that gets auto-installed, default `@bytebase/dbhub`), `DSH_DBHUB_UPDATE_DAYS` (the seed for the auto-update interval, default `7`, overridden by the value saved on the configure page).

## Changelog

Highlights of every released version live in [doc/CHANGELOG.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/CHANGELOG.md); per-release notes are on [GitHub Releases](https://github.com/mr-mihu/dsh-dbhub-live/releases).

## License

[MIT](./LICENSE)
