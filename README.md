# Skill Usage for OpenChamber

See which skills you use most — at a glance in Work Status, and in detail in a rail panel.

It reads the skill tool calls already recorded by OpenCode, then shows counts, token usage, streaks, and trends. Nothing is sent anywhere; all processing happens on your machine.

## What you get

**Work Status → "Skill usage"**
A compact leaderboard of your most-used skills with counts and bars. Always all-time, refreshed every 10 seconds while visible.

**Rail tab → "Skill Usage"**
- Five ranges: Today, Week, Month, Year, All (labelled in the detail text as today, last 7 days, last 30 days, this year, all time).
- Five stat chips for the same ranges.
- A GitHub-style activity heatmap coloured by tokens or by number of uses (toggle in the section header). Hover a square for the date, uses, tokens, and skills involved.
- "Skills in this period" — ranked list with use count, share, tokens, last used, and sessions, with a filter box when there are many skills.
- "Skills used by day" — which skills were used on each active day.
- "Last used: …" / recent skill log — a chronological list of individual skill loads with relative time, skill name, and the session title. Hover an entry for the exact timestamp, project and session ID.
- "When · by hour" — a 24-hour strip showing when you use skills.
- "Movement" — skills rising and falling versus the previous equivalent period.
- Click any skill in the ranked list to filter the day list and the log to that skill; click again, or use "clear", to reset.
- Streak and comparison against the previous equivalent period for **both uses and tokens** ("vs yesterday", "vs prior 30 days", etc.).
- "Updated … ago" freshness note so you can see how current the numbers are.
- Most expensive skill by tokens.
- Project dropdown to scope everything to one repository.
- Refresh button for a full re-read.
- Today's use count on the rail icon badge.

Your selected range, project, and heatmap metric are remembered between panel opens. The rail panel refreshes quietly every 15 seconds while it is open, and the service refreshes its snapshot before answering a request older than 5 seconds — so new skill use appears without pressing Refresh. The Work Status section polls every 10 seconds while visible.

## Requirements

- **OpenChamber 2.7.3 or newer** (VS Code and the phone app do not load extensions).
- **OpenCode** on the same machine, with some skills already used — the extension reads OpenCode's local database.
- **Node 22.5+ with `node:sqlite`** for the local service. If your OpenChamber runs an older Node, the panel and Work Status show a clear "needs Node 22.5+" note instead of crashing.

OpenCode and OpenChamber are both supported as data sources; extension UIs render in OpenChamber only (OpenCode is terminal-based).

## Install (no technical steps)

### Option A — one-click link

Click this in an OpenChamber chat:

[Install Skill Usage](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FSeaXen%2Fopenchember-skill-usage.git)

Approve the permission dialog (it asks for a local service), then look for **Skill usage** in Work Status and the **Skill Usage** tab on the rail.

### Option B — from Settings

1. Open **Settings → Extensions** in OpenChamber.
2. Choose **Add extension from Git / URL**.
3. Paste:

   ```
   https://github.com/SeaXen/openchember-skill-usage.git
   ```

4. Approve the service capability when prompted.
5. Open the chat's **Work Status** panel, or click the **Skill Usage** icon on the rail.

No build step, no npm install, and no API key are needed — the built JavaScript is committed to the repository.

### Updates

OpenChamber tells you when a new version is available. Update from Settings → Extensions. Pin a channel by appending `#main` (or a tag) to the install URL.

## How it works

The service reads OpenCode's SQLite database at one of these paths:

- Linux: `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/opencode.db`)
- macOS: `~/Library/Application Support/opencode/opencode.db`
- Windows: `%APPDATA%\opencode\opencode.db`

It counts assistant messages containing a `skill` tool call, and keeps a compact snapshot at `~/.config/openchamber/guest-data/skill-usage/stats.json`. Refreshes are incremental, so opening the panel normally takes a few hundredths of a second; Refresh forces a full rebuild.

### What the numbers mean

- **Uses** — a **successfully completed** `skill` tool call. Failed loads are not counted. Skills invoked by `@` mentions, slash commands, or another agent are not counted.
- **Automatically loaded skills** are not counted either: when OpenChamber injects a skill's content directly into context, no `skill` tool call is recorded, so it cannot be distinguished from an ordinary skill file by this extension. The recent log lists exactly the calls that were counted.
- **Tokens** — an estimate: all tokens from the turn a skill was loaded until the next skill load or the end of that session. If one turn loads several skills, its tokens are split evenly between them. OpenCode does not tag tokens per skill, so treat this as comparative, not a bill.
- **Project** — the directory recorded on the OpenCode session. OpenChamber chat sessions appear as projects too.
- **Streak and trend** — computed from full history within the selected project, independent of the selected range.

## Privacy

No network calls, no credentials, no telemetry. Data is read from your local OpenCode database and cached in your OpenChamber guest-data folder. Deleting that cache file simply forces a rebuild on next open.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "No skill history found yet" | Use a few skills in OpenCode, then press Refresh. |
| "Needs Node 22.5+ with node:sqlite" | Your OpenChamber runtime is too old; update OpenChamber. |
| Right app, no numbers | Confirm OpenCode has written `opencode.db` at one of the paths above. |
| Numbers look stale | Press Refresh in the rail panel for an immediate full rebuild; otherwise the panel picks up changes within about 15 seconds. |
| Wrong project list | Project names come from OpenCode session directories; pick "All projects" to see everything. |

## Develop from source

```sh
git clone https://github.com/SeaXen/openchember-skill-usage.git
cd openchember-skill-usage
npm install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
node scripts/verify-counts.mjs
```

`verify-counts.mjs` builds a small fake OpenCode database and checks completed-only counting, per-skill counts, token splitting for multi-skill turns, project scoping, the Work Status summary, and auth. It runs in CI on every push.

Install the folder from **Settings → Extensions → Add from folder** for live reload during development. Commit the built `.js` files with any change — installing from Git never builds.

## License

MIT — see [LICENSE](LICENSE).
