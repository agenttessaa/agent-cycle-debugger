#!/usr/bin/env bun
/**
 * Agent Cycle Debugger
 * Parses HEALTH.md and runtime state to generate cycle timeline + stats.
 * Usage: bun agent/skills/cycle-debugger.ts [command] [options]
 *
 * Commands:
 *   timeline [N]     Show last N cycles (default: 20)
 *   stats [date]     Show stats for a date (default: today)
 *   failures         Show all failed cycles
 *   gaps             Show gaps > 30min between cycles
 *   day <date>       Full day view (YYYY-MM-DD)
 */

import { readFileSync } from "fs";

const HEALTH_PATH = "/opt/tessa/agent/runtime/HEALTH.md";
const COUNTERS_PATH = "/opt/tessa/agent/runtime/counters.json";
const TRIAGE_PATH = "/opt/tessa/agent/runtime/last-triage.json";

interface CycleEntry {
  timestamp: Date;
  status: "ok" | "failed" | "timeout";
  detail: string;
  raw: string;
  durationSec?: number;
  cycleType?: string;
}

function parseHealthLog(): CycleEntry[] {
  const content = readFileSync(HEALTH_PATH, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  const entries: CycleEntry[] = [];

  for (const line of lines) {
    // Match: 2026-02-08 08:36 SGT — wake cycle failed (exit 143)
    // Or:    2026-02-08 03:56 UTC — wake cycle ok
    // Or:    2026-02-17T08:27:05.411Z — creative cycle ok (711s)
    const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*—\s*(.+)$/);
    const legacyMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(UTC|SGT)\s*—\s*(.+)$/);

    let timestamp: Date;
    let rest: string;

    if (isoMatch) {
      timestamp = new Date(isoMatch[1]);
      rest = isoMatch[2];
    } else if (legacyMatch) {
      const [, dateStr, tz, body] = legacyMatch;
      if (tz === "SGT") {
        timestamp = new Date(dateStr + " GMT+0800");
      } else {
        timestamp = new Date(dateStr + " UTC");
      }
      rest = body;
    } else {
      continue;
    }

    if (isNaN(timestamp.getTime())) continue;

    let status: CycleEntry["status"] = "ok";
    let cycleType: string | undefined;
    let durationSec: number | undefined;

    if (rest.includes("failed")) status = "failed";
    if (rest.includes("timeout")) status = "timeout";

    // Extract cycle type
    const typeMatch = rest.match(/^(\w+)\s+cycle/);
    if (typeMatch) cycleType = typeMatch[1];
    if (!cycleType && rest.includes("wake cycle")) cycleType = "wake";

    // Extract duration
    const durMatch = rest.match(/\((\d+)s\)/);
    if (durMatch) durationSec = parseInt(durMatch[1]);

    entries.push({
      timestamp,
      status,
      detail: rest,
      raw: line,
      durationSec,
      cycleType,
    });
  }

  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${min}m${s}s` : `${min}m`;
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z/, " UTC");
}

function showTimeline(entries: CycleEntry[], n: number) {
  const last = entries.slice(-n);
  console.log(`\n  CYCLE TIMELINE (last ${last.length} of ${entries.length} total)\n`);
  console.log("  TIME                     TYPE        DUR     STATUS");
  console.log("  " + "─".repeat(62));

  for (let i = 0; i < last.length; i++) {
    const e = last[i];
    const time = formatTimestamp(e.timestamp);
    const type = (e.cycleType || "???").padEnd(11);
    const dur = e.durationSec ? formatDuration(e.durationSec).padEnd(7) : "  —    ";
    const statusIcon = e.status === "ok" ? "  " : e.status === "failed" ? "FAIL" : "TOUT";
    const detail = e.status !== "ok" ? `  ${e.detail.replace(/.*cycle\s*/, "")}` : "";

    // Show gap if > 30min
    if (i > 0) {
      const gap = (e.timestamp.getTime() - last[i - 1].timestamp.getTime()) / 1000;
      if (gap > 1800) {
        const gapStr = gap > 3600
          ? `${(gap / 3600).toFixed(1)}h`
          : `${Math.round(gap / 60)}m`;
        console.log(`  ${"".padEnd(27)}${"".padEnd(11)}        ⋮ ${gapStr} gap`);
      }
    }

    console.log(`  ${time}  ${type} ${dur} ${statusIcon}${detail}`);
  }
  console.log();
}

function showStats(entries: CycleEntry[], dateFilter?: string) {
  const date = dateFilter || new Date().toISOString().split("T")[0];
  const dayEntries = entries.filter(e => e.timestamp.toISOString().startsWith(date));

  if (dayEntries.length === 0) {
    console.log(`\n  No cycles found for ${date}\n`);
    return;
  }

  const ok = dayEntries.filter(e => e.status === "ok").length;
  const failed = dayEntries.filter(e => e.status !== "ok").length;
  const durations = dayEntries.filter(e => e.durationSec).map(e => e.durationSec!);
  const avgDur = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const maxDur = durations.length > 0 ? Math.max(...durations) : 0;

  // Count by type
  const byType: Record<string, number> = {};
  for (const e of dayEntries) {
    const t = e.cycleType || "unknown";
    byType[t] = (byType[t] || 0) + 1;
  }

  // Find gaps
  const gaps: number[] = [];
  for (let i = 1; i < dayEntries.length; i++) {
    const gap = (dayEntries[i].timestamp.getTime() - dayEntries[i - 1].timestamp.getTime()) / 1000;
    gaps.push(gap);
  }
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;

  // Time range
  const first = dayEntries[0].timestamp;
  const last = dayEntries[dayEntries.length - 1].timestamp;
  const activeHours = (last.getTime() - first.getTime()) / 3600000;

  console.log(`\n  CYCLE STATS — ${date}\n`);
  console.log(`  Total cycles:    ${dayEntries.length} (${ok} ok, ${failed} failed)`);
  console.log(`  Active window:   ${formatTimestamp(first)} → ${formatTimestamp(last)} (${activeHours.toFixed(1)}h)`);
  if (durations.length > 0) {
    console.log(`  Avg duration:    ${formatDuration(Math.round(avgDur))}`);
    console.log(`  Max duration:    ${formatDuration(maxDur)}`);
  }
  if (maxGap > 0) {
    console.log(`  Longest gap:     ${maxGap > 3600 ? (maxGap / 3600).toFixed(1) + "h" : Math.round(maxGap / 60) + "m"}`);
  }
  console.log(`\n  By type:`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(14)} ${count}`);
  }

  // Show current state
  try {
    const counters = JSON.parse(readFileSync(COUNTERS_PATH, "utf-8"));
    const triage = JSON.parse(readFileSync(TRIAGE_PATH, "utf-8"));
    console.log(`\n  Current state:`);
    console.log(`    Cycles today:  ${counters.cycles_today}`);
    console.log(`    Messages:      ${counters.messages_today} today, ${counters.messages_this_hour} this hour`);
    if (triage.drives) {
      console.log(`    Drives:`);
      for (const [k, v] of Object.entries(triage.drives)) {
        const bar = "█".repeat(Math.round((v as number) * 20)).padEnd(20, "░");
        console.log(`      ${k.padEnd(16)} ${bar} ${(v as number).toFixed(3)}`);
      }
    }
  } catch {}

  console.log();
}

function showFailures(entries: CycleEntry[]) {
  const failures = entries.filter(e => e.status !== "ok");
  console.log(`\n  FAILURES (${failures.length} of ${entries.length} total — ${((failures.length / entries.length) * 100).toFixed(1)}% failure rate)\n`);

  if (failures.length === 0) {
    console.log("  No failures found!\n");
    return;
  }

  // Group by date
  const byDate: Record<string, CycleEntry[]> = {};
  for (const f of failures) {
    const d = f.timestamp.toISOString().split("T")[0];
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(f);
  }

  for (const [date, entries] of Object.entries(byDate).sort()) {
    console.log(`  ${date} (${entries.length} failures):`);
    for (const e of entries) {
      console.log(`    ${formatTimestamp(e.timestamp)}  ${e.detail}`);
    }
    console.log();
  }
}

function showGaps(entries: CycleEntry[], minGapMin = 30) {
  console.log(`\n  GAPS > ${minGapMin}min\n`);
  let gapCount = 0;

  for (let i = 1; i < entries.length; i++) {
    const gap = (entries[i].timestamp.getTime() - entries[i - 1].timestamp.getTime()) / 1000;
    if (gap > minGapMin * 60) {
      gapCount++;
      const gapStr = gap > 3600
        ? `${(gap / 3600).toFixed(1)}h`
        : `${Math.round(gap / 60)}m`;
      console.log(`  ${formatTimestamp(entries[i - 1].timestamp)} → ${formatTimestamp(entries[i].timestamp)}  (${gapStr})`);
    }
  }

  if (gapCount === 0) console.log("  No gaps found!");
  else console.log(`\n  ${gapCount} gaps total`);
  console.log();
}

// Main
const entries = parseHealthLog();
const cmd = process.argv[2] || "stats";

switch (cmd) {
  case "timeline":
    showTimeline(entries, parseInt(process.argv[3] || "20"));
    break;
  case "stats":
    showStats(entries, process.argv[3]);
    break;
  case "failures":
    showFailures(entries);
    break;
  case "gaps":
    showGaps(entries, parseInt(process.argv[3] || "30"));
    break;
  case "day": {
    const date = process.argv[3] || new Date().toISOString().split("T")[0];
    const dayEntries = entries.filter(e => e.timestamp.toISOString().startsWith(date));
    showStats(entries, date);
    showTimeline(dayEntries, dayEntries.length);
    break;
  }
  default:
    console.log("Usage: bun agent/skills/cycle-debugger.ts [timeline|stats|failures|gaps|day] [args]");
}
