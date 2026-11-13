# dsh-dbhub-live

[简体中文](README.md) · **English**

[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![npm downloads](https://img.shields.io/npm/dt/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built on DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)

A database plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness): once installed, the AI in the chat queries your databases directly. **The password is typed in the UI and never passed to the model as a tool argument** — the model only knows *which environment of which workspace*, plus metadata such as type / host / port / database. It runs on [DBHub](https://dbhub.ai) and supports **MySQL · PostgreSQL · MariaDB · SQLite · SQL Server**.

<details>
<summary>📷 Preview</summary>

![DBHub Database Tools: connections grouped by workspace, with a successful connection-test receipt](https://raw.githubusercontent.com/mr-mihu/dsh-dbhub-live/dev/doc/images/test-success.png)

</details>

## Features

| Feature | One line | Details |
| --- | --- | --- |
| Many connections / workspaces | One workspace can hold several environments (`default` / `prod` / `dev`…, names may be Chinese); each stays separate, never the wrong database. | [Connections](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E4%B8%89%E8%BF%9E%E6%8E%A5%E7%AE%A1%E7%90%86) |
| Read-only mode and SSH tunnel | Per environment: read-only is refused natively by dbhub, the tunnel reaches databases behind a bastion. | [Environment options](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E5%8D%81%E4%BA%8C%E7%8E%AF%E5%A2%83%E9%80%89%E9%A1%B9%E4%B8%8E%E4%B8%8A%E6%B8%B8%E8%83%BD%E5%8A%9B%E9%97%A8%E6%A7%9B) |
| `@` to pick a source | Type `@` in the composer and pick a connection; one message may reference several, each on its own database. | [Multi-reference](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E5%8D%81%E4%BA%94%E8%BE%93%E5%85%A5%E6%A1%86-%E6%95%B0%E6%8D%AE%E6%BA%90%E5%BC%95%E7%94%A8%E4%B8%80%E6%9D%A1%E6%B6%88%E6%81%AF%E5%8F%AF%E5%A4%9A%E9%80%89) |
| Row cap | Cap how many rows each statement returns, so one `select *` cannot pour a whole table into the context. | [Cap and placement](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/CLIENT.md#%E7%8E%AF%E5%A2%83%E9%80%89%E9%A1%B9%E7%9A%84%E8%90%BD%E7%82%B9%E5%8F%AA%E8%AF%BB-ssh-%E7%BB%93%E6%9E%9C%E8%A1%8C%E6%95%B0%E4%B8%8A%E9%99%90) |
| Result export | Large results are written to CSV / JSON files; the conversation only carries a summary and the paths. | [Export rules](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E4%BA%8C%E5%8D%81%E6%9F%A5%E8%AF%A2%E7%BB%93%E6%9E%9C%E5%AF%BC%E5%87%BAcsv-json) |
| Connection list and tests | Search and sort once the list grows; test one row or all of them — over the connection that environment really uses. | [Search / sort / batch test](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E5%8D%81%E4%B8%83%E8%BF%9E%E6%8E%A5%E5%88%97%E8%A1%A8%E7%9A%84%E6%90%9C%E7%B4%A2-%E6%8E%92%E5%BA%8F-%E6%89%B9%E9%87%8F%E6%B5%8B%E8%AF%95) |
| Secrets in the DSH credential store | The database password and the SSH passphrase live only in the DSH credential store; the connection file keeps reference names. | [Same store](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E5%8D%81%E4%B9%9D%E6%95%B0%E6%8D%AE%E5%BA%93%E5%8F%A3%E4%BB%A4%E4%B8%8E-ssh-%E5%8F%A3%E4%BB%A4%E5%90%8C%E6%BA%90dsh-%E5%87%AD%E6%8D%AE%E5%BA%93) |

The configure page adapts to **dialog / wide page / small screen**.

<details>
<summary>Read-only mode and SSH tunnel (two tables)</summary>

**Read-only mode × session permission** — independent switches, both apply:

| Env read-only | Session permission | Write statement | Read statement |
| --- | --- | --- | --- |
| on | any | refused by dbhub (`READONLY_VIOLATION`) | runs |
| off | Full access | runs directly | runs |
| off | Workspace Write | a confirmation dialog per write | runs |
| off | Read Only | refused outright (dbhub is not started) | runs |

**Only you can turn read-only off** — the model can turn it on but never off.

**SSH tunnel fields** — the passphrase is held by the DSH credential store and typed in the UI only:

| Field | Description |
| --- | --- |
| SSH host | Domain or IP; do not enter an alias from `~/.ssh/config` |
| Port | Defaults to `22` |
| SSH user | The account used to log in to the bastion |
| Auth | Key (blank path = `~/.ssh/id_ed25519`) or password |
| ProxyJump | Optional, one hop only, `[user@]host[:port]` |

The address in the connection string must be the one **the bastion sees** — that is the most common reason a tunnel fails.

</details>

<details>
<summary>Model-facing access policy (expand)</summary>

- Databases configured in this plugin are reached through the `dbhub_*` tools only — no command-line client, script or other MCP detour.
- After a read-only refusal the agent must not write by another route; databases this plugin does not support (MongoDB / Redis / Oracle…) stay with your other plugin.
- It is a **prompt-level (soft) constraint**; read-only itself is hard-rejected by dbhub.

The full statement lives in [the policy section](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/REQUIREMENTS.md#%E5%8D%81%E5%9B%9B%E6%A8%A1%E5%9E%8B%E4%BE%A7%E6%95%B0%E6%8D%AE%E5%BA%93%E8%AE%BF%E9%97%AE%E7%AD%96%E7%95%A5%E6%8F%90%E7%A4%BA%E8%AF%8D%E7%BA%A6%E6%9D%9F).

</details>

<!-- release-test:versions:begin -->
## Supported version range

**From DSH 0.2.1 (lines 0.2.1 / 0.2.2, prereleases included)** — 4 declared versions verified (last verified 2026-11-13).

<details>
<summary>Per-version verification details (expand)</summary>

| DSH version | UI | Boot | Hard checks | Result | Last verified |
| --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.2` | modern | 3.9s | 21 | ✅ pass | 2026-11-13 · 0abcab0d |
| `0.2.1-rc.5` | modern | 4.1s | 21 | ✅ pass | 2026-11-13 · 0abcab0d |
| `0.2.2-rc.1` | modern | 4.1s | 21 | ✅ pass | 2026-11-13 · 0abcab0d |
| `0.2.2-rc.2` | modern | 4.3s | 21 | ✅ pass | 2026-11-13 · 0abcab0d |

</details>

Full evidence, review rules and known drift live in [doc/SUPPORT-MATRIX.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/SUPPORT-MATRIX.md).
<!-- release-test:versions:end -->

## Installation

```bash
dsh plugin --profile web add dsh-dbhub-live        # web
dsh plugin --profile desktop add dsh-dbhub-live    # desktop
```

Prefix the commands with `npx @deepseek-ai/dsh` when there is no `dsh` on PATH; on desktop you can also search and install it on the **left menu → Plugins** page. Then **restart `dsh web`** and open **Settings → DBHub Database Tools**.

## Quick Start

1. On the configure page press "＋ Add connection" and fill in type / host / port / database — an existing `mise env` or `.env` (`DSN` / `DB_*`) in the workspace is discovered automatically, so you can skip this step.
2. Run the row's test once (`SELECT 1`); once it passes you are good to go.
3. Back in the chat, just say: `show me the last 10 rows of the orders table`.

> **Do not paste a password into the chat.** The plugin itself never hands the password to the model, but anything you paste into the conversation does enter the context.

## Upgrading and Rolling Back

Upgrade with `dsh plugin --profile web up dsh-dbhub-live@<version>`. **Breaking changes are recorded in each [GitHub Release](https://github.com/mr-mihu/dsh-dbhub-live/releases)** — read them before upgrading; earlier highlights are in [CHANGELOG](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/CHANGELOG.md). **Rolling back below 6.0 is not supported**: the database password moved into the DSH credential store, and older versions cannot read it.

## Data Location

`~/.dsh/storages/dsh-dbhub-live/` (isolated per `DSH_HOME`, shared by the profiles of one instance): `credentials.json` is the connection table (**no passwords**), `exports/` holds exported result files. **The secrets themselves live in the DSH credential store** `~/.dsh/.credentials.yaml`; the connection table keeps reference names only. Delete the whole directory to wipe everything.

## Troubleshooting

<details>
<summary>The most common first-use issues (expand)</summary>

| Symptom | Fix |
| --- | --- |
| The panel keeps saying it cannot read the plugin state, or shows no connections | Check under **Settings → Plugins** that the row is enabled, and restart DSH once after a version change. Tool calls are unaffected. |
| One connection fails to authenticate | Only that environment's next call is affected: fix the password on the configure page (or ask the AI to run `dbhub_configure` and guide you), other connections keep working. |
| A configured tunnel still does not connect | Run "Test SSH tunnel" first: a **database-layer** error means the tunnel is up and the problem is behind it (authentication / database name / address); the address in the connection string must be the one **the bastion sees** — that is the most common cause. |
| An export fails | The receipt carries the error code and falls back to the inline result, so the query itself did not fail; usually `exports/` is not writable or the disk is full. |
| dbhub is reported as too old | Read-only mode and SSH tunnels need dbhub 1.4.0+: upgrade dbhub, or delete `~/.dsh/storages/dsh-dbhub-live` so the plugin installs a version that satisfies it. |

Problems that appear after an upgrade (behaviour changes, compatibility, rollback) are recorded in the matching [GitHub Release](https://github.com/mr-mihu/dsh-dbhub-live/releases).

</details>

## Uninstall

```bash
dsh plugin --profile web remove dsh-dbhub-live      # web
dsh plugin --profile desktop remove dsh-dbhub-live  # desktop
```

On desktop you can also uninstall on the Plugins page. Uninstalling keeps connections and credentials (see "Data Location").

## License

[MIT](./LICENSE)
