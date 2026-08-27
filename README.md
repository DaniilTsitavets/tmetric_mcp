# tmetric-mcp-server

An MCP server for [TMetric](https://tmetric.com) time tracking, built for one job: **reviewing and filling in your hours for specific days**.

Point it at a TMetric workspace and an agent can answer "what did I log last week?", then write "three hours on the migration, two on review" into the right day — without you having to invent clock times.

It pairs naturally with other MCP servers: an agent can pull what you wrote in Slack on a given day, ask you to fill in the gaps, and log the result here in the same conversation.

Built on the TMetric **REST API v3**, over **stdio**.

---

## Quick start

```bash
npm install
npm run build
```

Get a personal API token: in TMetric, click your name (bottom left) → **My Profile** → **Get new API token**. Tokens are valid for one year, and generating a new one invalidates the previous.

Register the server with Claude Code:

```bash
claude mcp add tmetric \
  --env TMETRIC_API_TOKEN=<your token> \
  -- node "$(pwd)/dist/index.js"
```

Or add it to `.mcp.json` / `claude_desktop_config.json` by hand:

```json
{
  "mcpServers": {
    "tmetric": {
      "command": "node",
      "args": ["/absolute/path/to/tmetric_mcp/dist/index.js"],
      "env": { "TMETRIC_API_TOKEN": "your token" }
    }
  }
}
```

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TMETRIC_API_TOKEN` | yes | Personal API token. Never commit it; see `.env.example`. |
| `TMETRIC_ACCOUNT_ID` | no | Default workspace when a tool call omits `account_id`. Otherwise the active workspace from your profile is used. |
| `TMETRIC_USER_ID` | no | Default user when a tool call omits `user_id`. Otherwise you. |
| `TMETRIC_BASE_URL` | no | Host override for on-premises installs. Default `https://app.tmetric.com`. |

Check the server starts and prints its configuration:

```bash
node dist/index.js --help
```

---

## Tools

Fifteen tools, grouped by what they are for. Every tool takes `response_format` (`markdown`, the default, or `json`) and every list tool takes `limit` / `offset`.

### Identity

| Tool | What it does |
| --- | --- |
| `tmetric_get_current_user` | Your user id, your workspaces, the workspace timezone, and the rules that decide whether a write will be accepted (project required? description required? manual editing allowed?). **Call this first.** |

### Catalogue — turning names into ids

| Tool | What it does |
| --- | --- |
| `tmetric_list_projects` | Projects you can book time to, most recently used first. |
| `tmetric_list_clients` | Clients in the workspace. |
| `tmetric_list_tags` | Tags and work types, optionally for one project. |
| `tmetric_list_tasks` | Tasks, filtered by project, assignee, completion or due date. |

### Time entries — the core

| Tool | What it does |
| --- | --- |
| `tmetric_list_time_entries` | Entries for a date range, grouped by day with per-day totals and the entry ids needed to edit them. |
| `tmetric_create_time_entry` | Log one block of work. Give a date and a duration; the slot is chosen for you. |
| `tmetric_create_time_entries_bulk` | Log up to 50 blocks in one call, filling whole days or a whole week. |
| `tmetric_update_time_entry` | Correct an entry — description, project, task, tags, times or day. |
| `tmetric_delete_time_entry` | Remove an entry permanently. |
| `tmetric_list_recent_time_entries` | The task/project combinations you tracked most recently, to reuse rather than reinvent. |

### Timer

| Tool | What it does |
| --- | --- |
| `tmetric_get_active_timer` | Whether a timer is running, and on what. |
| `tmetric_start_timer` | Start tracking from now. |
| `tmetric_stop_timer` | Close the running timer. Safe to call when nothing is running. |

### Reporting

| Tool | What it does |
| --- | --- |
| `tmetric_get_time_summary` | Hours per project over a period, with each project's share of the total. |

---

## How logging a day works

The design assumption is that you remember *what* you did and *for how long*, not *when*.

**Durations are enough.** Omit `start_time` and the entry is appended right after the last thing already logged that day. An empty day starts at `day_start_time` (`09:00` by default).

```jsonc
// "Yesterday I spent 3 hours on the API migration"
{ "date": "yesterday", "duration_hours": 3, "note": "API migration", "project_id": 500001 }
```

**A whole day in one call.** Entries sharing a date are laid end to end in the order given, and the day is read only once:

```jsonc
{
  "entries": [
    { "date": "2026-08-20", "duration_hours": 3,   "note": "Payment webhook fix", "project_id": 500001 },
    { "date": "2026-08-20", "duration_minutes": 90, "note": "Code review",        "project_id": 500001 },
    { "date": "2026-08-20", "duration_hours": 2,   "note": "Client call",        "project_id": 500002 }
  ]
}
```
→ `09:00–12:00`, `12:00–13:30`, `13:30–15:30`.

**Preview before writing.** `dry_run: true` returns the exact layout without touching TMetric.

**Overlaps are refused, not silently merged.** If a slot collides with existing time, the call fails and names the conflict:

> The requested slot on 2026-08-20 overlaps an existing entry: 09:00–11:30 Standup and planning (id 900). Omit start_time to append after the last entry of the day, choose a free slot, or pass `allow_overlap=true` to let TMetric adjust the neighbouring entry.

This is deliberate — an unattended agent should not be able to quietly corrupt a timesheet.

**Exact times when they matter.** Pass `start_time` and `end_time`; an end earlier than the start means the work crossed midnight.

**Updates merge.** `tmetric_update_time_entry` reads the entry first, so fields you do not mention keep their values. That is why it needs the `date` the entry currently sits on.

---

## Notes on the API

- **Timestamps are naive local times.** TMetric interprets `2026-08-20T09:00:00` in the workspace timezone; a UTC offset or `Z` suffix silently shifts the entry to the wrong day. This server never sends one, and does all date arithmetic on parsed components rather than on `Date` objects in the process timezone.
- **`today` / `yesterday` / `tomorrow`** are accepted anywhere a date is, and resolve against the machine running the server.
- **Workspace rules vary.** Many workspaces require a project and a description on every entry, and some disable manual editing entirely. `tmetric_get_current_user` reports these, and a rejected write points back to it.
- **Responses are capped at 25 000 characters.** Long ranges are trimmed to whole days with a message saying where the data stops and how to fetch the rest. Markdown is roughly three times more compact than JSON — a full month of entries fits comfortably.
- `docs/tmetric-openapi-v3.json` is the upstream OpenAPI document (v3.2.1) this server was built against, kept for maintenance.

---

## Development

```bash
npm run dev          # watch mode
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
npm test             # build, then end-to-end checks against a mock TMetric API
npm run inspect      # open the MCP Inspector against the built server
```

`npm test` launches the server exactly as an MCP client would, pointed at `test/mock-tmetric.mjs`. It covers the parts this server actually owns: identity resolution, slot placement, overlap refusal, midnight handling, merge-on-update, per-entry failure reporting in bulk writes, and the wording of errors.

### Evaluation

`evaluation/` holds ten read-only questions used to check that an LLM can drive these tools to a correct answer, together with the frozen dataset the answers come from.

```bash
npm run verify:eval  # recompute every declared answer from the fixture
npm run eval:server  # serve the fixture; prints the port it bound to
```

To run the questions end to end, start the fixture server on a fixed port and point the MCP server at it:

```bash
EVAL_PORT=8931 node evaluation/fixture-server.mjs &
TMETRIC_API_TOKEN=eval-token TMETRIC_BASE_URL=http://127.0.0.1:8931 node dist/index.js
```

The fixture is read-only, so a mistaken write during an evaluation run fails loudly instead of skewing later answers.

---

## Security

- The API token is read from the environment only, never from a file in the repo or from tool arguments. `.env` is gitignored.
- A missing token fails at startup with an explicit message rather than at the first tool call.
- All inputs are validated with strict Zod schemas: unknown fields are rejected rather than forwarded to the API.
- Error messages relay TMetric's own explanation and a suggested next step; they do not expose the token, internal paths or stack traces.
- Destructive behaviour is annotated: `tmetric_delete_time_entry` is the only tool marked `destructiveHint: true`, so clients can gate it.

## License

MIT
