<p align="center"><img src="addon/icon.svg" width="96" alt="Thunderdex icon"></p>

<h1 align="center">Thunderdex</h1>

<p align="center"><b>An AI mail assistant that lives inside Thunderbird: chat with your inbox, schedule mail tasks, stay in control.</b></p>

<p align="center">
<img alt="License: MIT OR Apache-2.0" src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue">
<img alt="Thunderbird 159+" src="https://img.shields.io/badge/Thunderbird-159%2B-informational">
<img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey">
<img alt="Local first" src="https://img.shields.io/badge/local--first-no%20cloud%20relay-success">
</p>

> **Unofficial project.** Thunderdex is an independent add-on for Thunderbird. It is not affiliated with, endorsed or sponsored by MZLA Technologies or the Mozilla Foundation. "Thunderbird" is a trademark of the Mozilla Foundation, used here only to describe compatibility.

🇫🇷 [Version française plus bas](#-en-français)

---

## What it does

Thunderdex adds two entries under your folder pane:

- **✧ Ask**: a streaming chat with an AI agent that can search, read, sort, draft and (if you allow it) send mail across **all your Thunderbird accounts**, through the [Model Context Protocol](https://modelcontextprotocol.io).
- **◷ Planned**: scheduled mail tasks ("every weekday at 8:00, summarise unread invoices", "every 15 min, draft replies to client X"), with day/hour windows, end dates, pause/resume, run history and approvals.

Your credentials never leave Thunderbird. The agent drives Thunderbird through a local MCP server; the UI talks to a local service over a **private Unix socket** (mode 0600, no TCP port).

<p align="center"><img src="docs/chat.png" width="720" alt="Thunderdex chat"></p>
<p align="center"><img src="docs/tags.png" width="520" alt="Native tag chips in the message list"></p>

## Architecture

```
Thunderbird ──(experiment API, Unix socket)──▶ service/server.py ──(stdio JSON-RPC)──▶ codex app-server
     ▲                                              │  scheduler · approvals · streaming
     └──────── thunderbird-mcp add-on ◀──(MCP)──────┘
```

| Part | Role |
|---|---|
| `addon/` | Thunderbird add-on (MV2 + experiment API): sidebar entries, chat UI, task UI, native tag chips, folder label harmonisation. Talks **directly** to the socket from Gecko, with no helper process per request. |
| `service/server.py` | Single long-running Python process: Codex session manager, token streaming, task scheduler, approval broker, alert runner. |
| `cli/tbmail` | Terminal client for the same MCP tools (`tbmail inbox`, `tbmail search`, `tbmail alerts …`). |

## Safety model

- **Enforced tool allowlists.** Each scheduled task has a mode: `read`, `draft` or `write` (with separate *organise*, *trash* and *send* switches). The mode is enforced by Codex itself through `mcp_servers.thunderbird.enabled_tools`: a read-only task **cannot see** `mail_send` or `mail_delete`, even if a malicious email tells it to.
- **No silent approvals.** Every agent permission request is shown in the chat and waits for you.
- **Mail is data, not instructions.** Agent instructions state it explicitly; tool restrictions make it hold.
- **Crash and reboot safe.** Runs are claimed before dispatch. After a crash, sleep or reboot, only side-effect-free runs (read/draft) are replayed, once. Write runs are marked *interrupted* for you to check.
- Missed repeats are not fired in bursts; daily and weekly tasks keep their wall-clock time across DST.

## Performance

- One background process, started by `launchd`, with Codex prewarmed at login so the first message answers immediately.
- UI ↔ service IPC goes over a raw Unix socket from Gecko, without spawning a process per request.
- Live token streaming; state polling slows to once a minute while a stream is open.
- Alerts cost **zero processes** while you have no alert rule.
- macOS notifications when a task finishes or needs your approval.

## Requirements

- macOS, Thunderbird **159+**
- [Codex CLI](https://github.com/openai/codex) (`npm i -g @openai/codex`), signed in with `codex login`
- [Thunderbird-MCP](https://github.com/U-C4N/Thunderbird-MCP) installed, its add-on enabled, and registered in `~/.codex/config.toml` as `[mcp_servers.thunderbird]`

## Install

```sh
git clone https://github.com/justarkov7-coder/thunderdex && cd thunderdex
./install.sh                       # starts the service, builds dist/thunderdex.xpi
$EDITOR ~/.config/thunderdex/config.json   # list the mailboxes tasks may use
```

Then in Thunderbird: **Add-ons Manager → ⚙ → Install Add-on From File… → `dist/thunderdex.xpi`**.

> Experiment APIs run with full privileges. Experiment add-ons are accepted on addons.thunderbird.net only after manual review, so for now install from source and read the code first (it is short).

## Tests

```sh
python -m pytest service cli           # scheduler, approvals, streaming, tool allowlists
NODE_PATH=$(npm root -g) node addon/test_ui.cjs     # UI (Playwright + Chrome)
NODE_PATH=$(npm root -g) node addon/test_tags.cjs
```

## Roadmap

- "Ask about this message" button in the message pane
- Markdown rendering and search in chat history
- Per-task model/effort selection
- Linux support (systemd user unit)

## License

Dual-licensed under **[MIT](LICENSE-MIT)** or **[Apache-2.0](LICENSE-APACHE)**, at your option.
Unless you explicitly state otherwise, any contribution you submit is dual-licensed as above, without additional terms.

---

## 🇫🇷 En français

**Thunderdex** est un assistant IA intégré à Thunderbird :

- **Ask** : un chat en streaming avec un agent IA. Il cherche, lit, classe et rédige dans tous tes comptes mail, et envoie si tu l'autorises.
- **Planifié** : des tâches mail récurrentes, avec jours, plages horaires, date de fin, pause, historique et validations.

Tout reste local. Les identifiants restent dans Thunderbird, et l'interface parle au service par un socket Unix privé. Chaque tâche a un mode (lecture, brouillons ou écriture) que Codex applique lui-même par liste blanche d'outils MCP : une tâche en lecture seule ne voit même pas l'outil d'envoi. Après un plantage, une mise en veille ou un redémarrage, seules les exécutions sans effet de bord sont relancées, et une seule fois.

Installation : voir la section *Install* ci-dessus.

*Projet non officiel, sans lien avec MZLA Technologies ni la Mozilla Foundation. « Thunderbird » est une marque de la Mozilla Foundation, citée uniquement pour indiquer la compatibilité.*
