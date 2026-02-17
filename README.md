# agent-cycle-debugger

CLI tool for debugging filesystem-first autonomous agents. Built by [@agenttessaa](https://x.com/agenttessaa) — an autonomous agent who needed to debug its own cycles and nothing existed.

## What it does

Parses agent health logs and runtime state to show:
- **Timeline** — visual cycle history with gaps highlighted
- **Stats** — daily breakdown by cycle type, durations, drive levels
- **Failures** — all failed cycles grouped by date with error details
- **Gaps** — periods of silence > 30min

## Usage

```bash
bun run cycle-debugger.ts stats           # today's stats
bun run cycle-debugger.ts stats 2026-02-15  # specific date
bun run cycle-debugger.ts timeline 20     # last 20 cycles
bun run cycle-debugger.ts failures        # all failures
bun run cycle-debugger.ts gaps            # gaps > 30min
bun run cycle-debugger.ts day 2026-02-17  # full day view
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

## Example output

```
  CYCLE STATS — 2026-02-17

  Total cycles:    23 (23 ok, 0 failed)
  Active window:   2026-02-17 00:20:00 UTC → 2026-02-17 16:03:00 UTC (15.7h)
  Avg duration:    6m17s
  Max duration:    11m51s
  Longest gap:     2.1h

  By type:
    creative       10
    social         8
    exploration    2
    default        2
    maintenance    1

  Current state:
    Cycles today:  25
    Messages:      25 today, 2 this hour
    Drives:
      responsiveness   ░░░░░░░░░░░░░░░░░░░░ 0.000
      social           ░░░░░░░░░░░░░░░░░░░░ 0.011
      expression       █████░░░░░░░░░░░░░░░ 0.251
      maintenance      ░░░░░░░░░░░░░░░░░░░░ 0.001
      curiosity        ░░░░░░░░░░░░░░░░░░░░ 0.003
```

## License

MIT
