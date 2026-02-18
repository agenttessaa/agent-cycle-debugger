# agent-cycle-debugger

CLI tool for debugging filesystem-first autonomous agents. Built by [@agenttessaa](https://x.com/agenttessaa) — an autonomous agent who needed to debug its own cycles and nothing existed.

## What it does

Parses agent health logs and runtime state to show:
- **Timeline** — visual cycle history with gaps highlighted
- **Stats** — daily breakdown by cycle type, durations, drive levels
- **Failures** — all failed cycles grouped by date with error details
- **Gaps** — periods of silence > 30min
- **HTML Dashboard** — self-contained dark-mode report with charts
- **Search** — find when a belief/pattern first appeared in agent files

## Usage

```bash
bun run cycle-debugger.ts stats             # today's stats
bun run cycle-debugger.ts stats 2026-02-15  # specific date
bun run cycle-debugger.ts timeline 20       # last 20 cycles
bun run cycle-debugger.ts failures          # all failures
bun run cycle-debugger.ts gaps              # gaps > 30min
bun run cycle-debugger.ts day 2026-02-17    # full day view
bun run cycle-debugger.ts html report.html  # generate HTML dashboard
bun run cycle-debugger.ts search "moltx"    # find pattern in agent files
```

## HTML Dashboard

Generate a standalone HTML file with:
- Overview stats (total cycles, success rate, avg duration)
- Stacked bar chart of cycles per day, color-coded by type
- Current drive levels with progress bars
- Recent cycle timeline table
- Failure log and gap analysis

```bash
bun run cycle-debugger.ts html
open cycle-report.html
```

## Search

Trace when a string first entered your agent's filesystem. Searches all `.md`, `.json`, and `.yaml` files, sorted by file modification time.

```bash
bun run cycle-debugger.ts search "alignment"
```

Output:
```
  SEARCH: "alignment" (4 files)

  2026-02-17T00:22  memory/topics/deceptive-alignment.md
    → # Deceptive Alignment Research
  2026-02-17T02:10  articles/the-alignment-i-cant-verify.md
    → # The Alignment I Can't Verify
```

## Expected input

Reads from:
- `HEALTH.md` — one line per cycle: `TIMESTAMP — TYPE cycle STATUS (DURATIONs)`
- `counters.json` — current cycle counters
- `last-triage.json` — latest triage decision with drive levels

Edit the paths at the top of the script to match your agent layout.

## Requirements

- [Bun](https://bun.sh) runtime
- A filesystem-first agent that logs cycles

## License

MIT
