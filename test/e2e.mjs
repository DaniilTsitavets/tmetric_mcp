/**
 * End-to-end checks for the TMetric MCP server.
 *
 * The server is launched exactly as an MCP client would launch it, but pointed at
 * an in-memory stand-in for the TMetric API (test/mock-tmetric.mjs). That covers
 * the parts this server actually owns: identity resolution, slot placement,
 * overlap refusal, midnight handling, merge-on-update and error wording.
 *
 * Run with: npm test
 */

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mock = spawn("node", ["test/mock-tmetric.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
process.on("exit", () => mock.kill());
const port = await new Promise((r) => mock.stdout.once("data", (d) => r(d.toString().trim())));
const baseUrl = `http://127.0.0.1:${port}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, TMETRIC_API_TOKEN: "test-token", TMETRIC_BASE_URL: baseUrl },
  stderr: "pipe",
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

let pass = 0, fail = 0;
async function step(label, name, args, check) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const ok = check ? check(res, text) : !res.isError;
  console.log(`\n${ok ? "PASS" : "FAIL"} :: ${label}`);
  console.log(text.split("\n").slice(0, 18).join("\n"));
  ok ? pass++ : fail++;
  return res;
}

await step("profile resolves workspace + rules", "tmetric_get_current_user", {},
  (r, t) => !r.isError && r.structuredContent.user_id === 7001 && r.structuredContent.default_account_id === 42 && t.includes("project, description"));

await step("projects sorted by recent usage", "tmetric_list_projects", { limit: 5 },
  (r) => !r.isError && r.structuredContent.projects[0].id === 501);

await step("existing day listing with totals", "tmetric_list_time_entries", { start_date: "2026-08-20" },
  (r, t) => !r.isError && r.structuredContent.total_human === "2h 30m" && t.includes("Thursday"));

await step("append after last entry (no start_time)", "tmetric_create_time_entry",
  { date: "2026-08-20", duration_hours: 2, note: "Payment webhook fix", project_id: 501 },
  (r) => !r.isError && r.structuredContent.result.start_time === "11:30" && r.structuredContent.result.end_time === "13:30");

await step("explicit overlap is refused with detail", "tmetric_create_time_entry",
  { date: "2026-08-20", start_time: "10:00", duration_hours: 1, note: "x", project_id: 501 },
  (r, t) => r.isError && t.includes("overlaps an existing entry") && t.includes("allow_overlap"));

await step("dry run plans without writing", "tmetric_create_time_entries_bulk",
  { entries: [ { date: "2026-08-21", duration_hours: 3, note: "Migration", project_id: 501 },
               { date: "2026-08-21", duration_minutes: 90, note: "Review", project_id: 501 } ], dry_run: true },
  (r) => !r.isError && r.structuredContent.results[0].start_time === "09:00" && r.structuredContent.results[1].start_time === "12:00" && r.structuredContent.results.every((x) => x.status === "planned"));

await step("bulk writes two days end-to-end", "tmetric_create_time_entries_bulk",
  { entries: [ { date: "2026-08-21", duration_hours: 3, note: "Migration", project_id: 501 },
               { date: "2026-08-21", duration_minutes: 90, note: "Review", project_id: 501 },
               { date: "2026-08-22", duration_hours: 4, note: "Docs", project_id: 502 } ] },
  (r) => !r.isError && r.structuredContent.succeeded === 3 && r.structuredContent.day_totals.length === 2);

await step("workspace validation error surfaces per entry", "tmetric_create_time_entries_bulk",
  { entries: [ { date: "2026-08-23", duration_hours: 1, note: "No project here" } ] },
  (r, t) => !r.isError && r.structuredContent.failed === 1 && t.includes("project is required"));

await step("midnight crossing via end_time", "tmetric_create_time_entry",
  { date: "2026-08-24", start_time: "22:00", end_time: "01:30", note: "Night deploy", project_id: 501 },
  (r) => !r.isError && r.structuredContent.result.duration_minutes === 210 && r.structuredContent.result.entry.date === "2026-08-24");

const listed = await step("list range groups days", "tmetric_list_time_entries",
  { start_date: "2026-08-20", end_date: "2026-08-24", response_format: "json" },
  (r) => !r.isError && r.structuredContent.days.length === 4);

const targetId = listed.structuredContent.days[0].entries[1].id;
await step("update merges instead of wiping", "tmetric_update_time_entry",
  { time_entry_id: targetId, date: "2026-08-20", duration_hours: 3 },
  (r) => !r.isError && r.structuredContent.entry.duration_human === "3h" && r.structuredContent.entry.project?.name === "Platform" && r.structuredContent.entry.note === "Payment webhook fix");

await step("update rejects wrong day with the ids present", "tmetric_update_time_entry",
  { time_entry_id: 999999, date: "2026-08-20" },
  (r, t) => r.isError && t.includes("No time entry with id 999999"));

await step("summary reports shares", "tmetric_get_time_summary",
  { start_date: "2026-08-01", end_date: "2026-08-31" },
  (r) => !r.isError && r.structuredContent.projects[0].share_percent === 71.4);

await step("active timer says nothing is running", "tmetric_get_active_timer", {},
  (r) => !r.isError && r.structuredContent.is_running === false);

await step("stop timer is safe when idle", "tmetric_stop_timer", {},
  (r) => !r.isError && r.structuredContent.stopped === false);

await step("delete removes the entry", "tmetric_delete_time_entry", { time_entry_id: targetId },
  (r) => !r.isError && r.structuredContent.deleted === true);

await step("strict schema rejects unknown args", "tmetric_list_projects", { bogus_param: 1 },
  (r) => r.isError === true || String(r.content?.[0]?.text).includes("Invalid"));

await step("bad date gives an actionable message", "tmetric_list_time_entries", { start_date: "20-08-2026" },
  (r, t) => r.isError && t.includes("YYYY-MM-DD"));

console.log(`\n================\nPASS ${pass}  FAIL ${fail}`);
await client.close();
mock.kill();
process.exit(fail === 0 ? 0 : 1);
