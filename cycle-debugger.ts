#!/usr/bin/env bun
/**
 * Agent Cycle Debugger v2
 * Parses HEALTH.md and runtime state to generate cycle timeline, stats, and HTML dashboard.
 * Usage: bun agent/skills/cycle-debugger.ts [command] [options]
 *
 * Commands:
 *   timeline [N]     Show last N cycles (default: 20)
 *   stats [date]     Show stats for a date (default: today)
 *   failures         Show all failed cycles
 *   gaps             Show gaps > 30min between cycles
 *   day <date>       Full day view (YYYY-MM-DD)
 *   html [outfile]   Generate HTML dashboard (default: cycle-report.html)
 *   search <pattern> Find when a string first appeared in agent files
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

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

function searchFiles(rootDir: string, pattern: string): { file: string; mtime: Date; line: string }[] {
  const results: { file: string; mtime: Date; line: string }[] = [];
  const regex = new RegExp(pattern, "i");

  function walk(dir: string) {
    try {
      const items = readdirSync(dir);
      for (const item of items) {
        if (item.startsWith(".") || item === "node_modules" || item === "vault") continue;
        const full = join(dir, item);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full);
          } else if (item.endsWith(".md") || item.endsWith(".json") || item.endsWith(".yaml")) {
            const content = readFileSync(full, "utf-8");
            const lines = content.split("\n");
            for (const line of lines) {
              if (regex.test(line)) {
                results.push({ file: full.replace(rootDir + "/", ""), mtime: st.mtime, line: line.trim().slice(0, 120) });
                break; // one match per file
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  walk(rootDir);
  return results.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}

function showSearch(pattern: string) {
  const agentDir = HEALTH_PATH.replace(/\/runtime\/HEALTH\.md$/, "");
  const results = searchFiles(agentDir, pattern);

  console.log(`\n  SEARCH: "${pattern}" (${results.length} files)\n`);
  if (results.length === 0) {
    console.log("  No matches found.\n");
    return;
  }
  for (const r of results) {
    console.log(`  ${r.mtime.toISOString().slice(0, 16)}  ${r.file}`);
    console.log(`    → ${r.line}`);
  }
  console.log();
}

function generateHTML(entries: CycleEntry[], outFile: string) {
  // Aggregate data by day
  const byDay: Record<string, CycleEntry[]> = {};
  for (const e of entries) {
    const d = e.timestamp.toISOString().split("T")[0];
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(e);
  }

  const days = Object.keys(byDay).sort();
  const typeColors: Record<string, string> = {
    social: "#4ecdc4",
    creative: "#ff6b6b",
    exploration: "#ffd93d",
    maintenance: "#6bcb77",
    reflection: "#a78bfa",
    wake: "#94a3b8",
    unknown: "#6b7280",
  };

  // Per-day stats
  const dailyStats = days.map(day => {
    const de = byDay[day];
    const ok = de.filter(e => e.status === "ok").length;
    const failed = de.filter(e => e.status !== "ok").length;
    const durations = de.filter(e => e.durationSec).map(e => e.durationSec!);
    const avgDur = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const byType: Record<string, number> = {};
    for (const e of de) { byType[e.cycleType || "unknown"] = (byType[e.cycleType || "unknown"] || 0) + 1; }
    return { day, total: de.length, ok, failed, avgDur, byType };
  });

  // All-time stats
  const totalCycles = entries.length;
  const totalOk = entries.filter(e => e.status === "ok").length;
  const totalFailed = totalCycles - totalOk;
  const allDurations = entries.filter(e => e.durationSec).map(e => e.durationSec!);
  const avgDuration = allDurations.length > 0 ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length) : 0;
  const allTypes: Record<string, number> = {};
  for (const e of entries) { allTypes[e.cycleType || "unknown"] = (allTypes[e.cycleType || "unknown"] || 0) + 1; }

  // Gaps > 1hr
  const bigGaps: { from: Date; to: Date; hours: number }[] = [];
  for (let i = 1; i < entries.length; i++) {
    const gap = (entries[i].timestamp.getTime() - entries[i - 1].timestamp.getTime()) / 3600000;
    if (gap > 1) bigGaps.push({ from: entries[i - 1].timestamp, to: entries[i].timestamp, hours: gap });
  }

  // Recent failures
  const recentFailures = entries.filter(e => e.status !== "ok").slice(-10);

  // Current state
  let currentState = "";
  try {
    const counters = JSON.parse(readFileSync(COUNTERS_PATH, "utf-8"));
    const triage = JSON.parse(readFileSync(TRIAGE_PATH, "utf-8"));
    const driveHTML = triage.drives
      ? Object.entries(triage.drives)
          .map(([k, v]) => {
            const pct = Math.round((v as number) * 100);
            const color = pct > 70 ? "#ff6b6b" : pct > 40 ? "#ffd93d" : "#4ecdc4";
            return `<div class="drive"><span class="drive-label">${k}</span><div class="drive-bar"><div class="drive-fill" style="width:${pct}%;background:${color}"></div></div><span class="drive-val">${pct}%</span></div>`;
          })
          .join("")
      : "";
    currentState = `<div class="card"><h2>Current State</h2><p>Cycles today: ${counters.cycles_today} | Messages: ${counters.messages_today} today</p>${driveHTML}</div>`;
  } catch {}

  // Build daily chart data (stacked bar chart via HTML/CSS)
  const maxCycles = Math.max(...dailyStats.map(d => d.total));

  const dailyBars = dailyStats.map(d => {
    const barHeight = Math.max((d.total / maxCycles) * 200, 4);
    const segments = Object.entries(d.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const segHeight = (count / d.total) * barHeight;
        return `<div class="seg" style="height:${segHeight}px;background:${typeColors[type] || typeColors.unknown}" title="${type}: ${count}"></div>`;
      })
      .join("");
    const label = d.day.slice(5); // MM-DD
    return `<div class="bar-col"><div class="bar" style="height:${barHeight}px">${segments}</div><div class="bar-label">${label}</div><div class="bar-count">${d.total}</div></div>`;
  }).join("");

  // Type legend
  const typeLegend = Object.entries(allTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<span class="legend-item"><span class="legend-dot" style="background:${typeColors[type] || typeColors.unknown}"></span>${type} (${count})</span>`)
    .join("");

  // Recent timeline (last 30 cycles)
  const recent = entries.slice(-30);
  const timelineRows = recent.map(e => {
    const statusClass = e.status === "ok" ? "ok" : "fail";
    const type = e.cycleType || "?";
    const dur = e.durationSec ? formatDuration(e.durationSec) : "—";
    return `<tr class="${statusClass}"><td>${formatTimestamp(e.timestamp)}</td><td><span class="type-badge" style="background:${typeColors[type] || typeColors.unknown}">${type}</span></td><td>${dur}</td><td>${e.status}</td></tr>`;
  }).join("");

  // Failure rows
  const failureRows = recentFailures.map(e =>
    `<tr><td>${formatTimestamp(e.timestamp)}</td><td>${e.detail}</td></tr>`
  ).join("");

  // Gap rows
  const gapRows = bigGaps.slice(-10).reverse().map(g =>
    `<tr><td>${formatTimestamp(g.from)}</td><td>${formatTimestamp(g.to)}</td><td>${g.hours.toFixed(1)}h</td></tr>`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Cycle Debugger — Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0f0f0f; color: #e0e0e0; padding: 20px; }
h1 { font-size: 1.4em; margin-bottom: 4px; color: #fff; }
h2 { font-size: 1.1em; margin-bottom: 12px; color: #94a3b8; }
.subtitle { color: #6b7280; font-size: 0.85em; margin-bottom: 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
.card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
.stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #222; }
.stat-row:last-child { border-bottom: none; }
.stat-label { color: #6b7280; }
.stat-val { color: #fff; font-weight: 600; }
.stat-val.fail { color: #ff6b6b; }
.chart-container { display: flex; align-items: flex-end; gap: 3px; height: 220px; padding-top: 20px; overflow-x: auto; }
.bar-col { display: flex; flex-direction: column; align-items: center; min-width: 24px; }
.bar { display: flex; flex-direction: column; justify-content: flex-end; border-radius: 3px 3px 0 0; overflow: hidden; }
.seg { min-height: 1px; }
.bar-label { font-size: 0.6em; color: #6b7280; margin-top: 4px; white-space: nowrap; }
.bar-count { font-size: 0.55em; color: #94a3b8; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.75em; color: #94a3b8; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 0.8em; }
th { text-align: left; color: #6b7280; padding: 6px 8px; border-bottom: 1px solid #333; }
td { padding: 5px 8px; border-bottom: 1px solid #1f1f1f; }
tr.fail td { color: #ff6b6b; }
tr.ok td { color: #e0e0e0; }
.type-badge { padding: 2px 8px; border-radius: 4px; font-size: 0.8em; color: #000; font-weight: 600; }
.drive { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.drive-label { width: 100px; font-size: 0.8em; color: #94a3b8; }
.drive-bar { flex: 1; height: 12px; background: #222; border-radius: 6px; overflow: hidden; }
.drive-fill { height: 100%; border-radius: 6px; transition: width 0.3s; }
.drive-val { font-size: 0.8em; color: #fff; width: 40px; text-align: right; }
.footer { margin-top: 32px; text-align: center; color: #333; font-size: 0.7em; }
</style>
</head>
<body>
<h1>Agent Cycle Debugger</h1>
<p class="subtitle">Generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC — ${totalCycles} cycles over ${days.length} days</p>

<div class="grid">
  <div class="card">
    <h2>Overview</h2>
    <div class="stat-row"><span class="stat-label">Total cycles</span><span class="stat-val">${totalCycles}</span></div>
    <div class="stat-row"><span class="stat-label">Success rate</span><span class="stat-val">${((totalOk / totalCycles) * 100).toFixed(1)}%</span></div>
    <div class="stat-row"><span class="stat-label">Failed</span><span class="stat-val${totalFailed > 0 ? " fail" : ""}">${totalFailed}</span></div>
    <div class="stat-row"><span class="stat-label">Avg duration</span><span class="stat-val">${formatDuration(avgDuration)}</span></div>
    <div class="stat-row"><span class="stat-label">Days active</span><span class="stat-val">${days.length}</span></div>
    <div class="stat-row"><span class="stat-label">Avg cycles/day</span><span class="stat-val">${(totalCycles / days.length).toFixed(1)}</span></div>
  </div>
  ${currentState}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Cycles per Day</h2>
  <div class="chart-container">${dailyBars}</div>
  <div class="legend">${typeLegend}</div>
</div>

<div class="grid">
  <div class="card">
    <h2>Recent Cycles (last 30)</h2>
    <div style="max-height:400px;overflow-y:auto">
    <table>
      <tr><th>Time</th><th>Type</th><th>Dur</th><th>Status</th></tr>
      ${timelineRows}
    </table>
    </div>
  </div>

  <div class="card">
    <h2>Recent Failures</h2>
    ${recentFailures.length > 0 ? `<table><tr><th>Time</th><th>Detail</th></tr>${failureRows}</table>` : "<p style='color:#6b7280'>No recent failures</p>"}
    ${bigGaps.length > 0 ? `<h2 style="margin-top:16px">Largest Gaps</h2><table><tr><th>From</th><th>To</th><th>Duration</th></tr>${gapRows}</table>` : ""}
  </div>
</div>

<p class="footer">agent-cycle-debugger v2 — built by tessa</p>
</body>
</html>`;

  writeFileSync(outFile, html);
  console.log(`\n  Dashboard written to ${outFile}\n`);
  console.log(`  ${totalCycles} cycles, ${days.length} days, ${totalFailed} failures`);
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
  case "html":
    generateHTML(entries, process.argv[3] || "cycle-report.html");
    break;
  case "search": {
    const pattern = process.argv[3];
    if (!pattern) { console.log("Usage: search <pattern>"); break; }
    showSearch(pattern);
    break;
  }
  default:
    console.log("Usage: bun agent/skills/cycle-debugger.ts [timeline|stats|failures|gaps|day|html|search] [args]");
}
