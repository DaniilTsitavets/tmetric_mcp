/**
 * Read-only TMetric API v3 stand-in serving the frozen evaluation fixture.
 *
 * Start it, point the MCP server at it with TMETRIC_BASE_URL, and the evaluation
 * questions become answerable and reproducible:
 *
 *   node evaluation/fixture-server.mjs        # prints the port it bound to
 *   TMETRIC_API_TOKEN=eval-token \
 *   TMETRIC_BASE_URL=http://127.0.0.1:<port> node dist/index.js
 */

import http from "node:http";
import { clients, projects, recentEntries, tags, tasks, timeEntries, user } from "./fixture.mjs";

const TOKEN = process.env.EVAL_TOKEN ?? "eval-token";

/** Seconds of a naive-local span, ignoring DST as the fixture does. */
function seconds(entry) {
  return (Date.parse(`${entry.endTime}Z`) - Date.parse(`${entry.startTime}Z`)) / 1000;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Invalid token" });
  if (req.method !== "GET") return send(403, { message: "The evaluation fixture is read-only." });

  const path = url.pathname;

  if (path === "/api/v3/user") return send(200, user);
  if (path === "/api/v3/accounts/42/timeentries/projects") return send(200, projects);
  if (path === "/api/v3/accounts/42/timeentries/tags") {
    const projectId = url.searchParams.get("projectId");
    return send(200, projectId === "502" ? tags.filter((tag) => tag.id !== 13) : tags);
  }
  if (path === "/api/v3/accounts/42/clients") return send(200, clients);
  if (path === "/api/v3/accounts/42/tasks") {
    const projectFilter = url.searchParams.getAll("ProjectList").map(Number);
    const completed = url.searchParams.get("Completed");
    return send(
      200,
      tasks
        .filter((task) => (projectFilter.length ? projectFilter.includes(task.project.id) : true))
        .filter((task) => (completed === null ? true : task.isCompleted === (completed === "true"))),
    );
  }
  if (path === "/api/v3/accounts/42/timeentries/recent") return send(200, recentEntries);
  if (path === "/api/v3/accounts/42/timeentries/latest") {
    return send(200, [...timeEntries].sort((a, b) => b.startTime.localeCompare(a.startTime))[0] ?? null);
  }

  if (path === "/api/v3/accounts/42/timeentries") {
    const start = url.searchParams.get("startDate");
    const end = url.searchParams.get("endDate");
    return send(
      200,
      timeEntries.filter((entry) => entry.startTime.slice(0, 10) >= start && entry.startTime.slice(0, 10) <= end),
    );
  }

  if (path === "/api/v3/accounts/42/reports/projects") {
    const start = url.searchParams.get("startDate") ?? "0000-01-01";
    const end = url.searchParams.get("endDate") ?? "9999-12-31";
    const projectFilter = url.searchParams.getAll("projectId").map(Number);
    const clientFilter = url.searchParams.getAll("clientId").map(Number);

    const totals = new Map();
    for (const entry of timeEntries) {
      const day = entry.startTime.slice(0, 10);
      if (day < start || day > end) continue;
      if (projectFilter.length && !projectFilter.includes(entry.project.id)) continue;
      if (clientFilter.length && !clientFilter.includes(entry.project.client?.id)) continue;
      const bucket = totals.get(entry.project.id) ?? { project: entry.project, totalSeconds: 0, billableSeconds: 0 };
      bucket.totalSeconds += seconds(entry);
      if (entry.isBillable) bucket.billableSeconds += seconds(entry);
      totals.set(entry.project.id, bucket);
    }
    return send(200, [...totals.values()]);
  }

  return send(404, { message: `No fixture route for ${req.method} ${path}` });
});

server.listen(Number(process.env.EVAL_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
