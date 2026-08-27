/** Minimal in-memory stand-in for the TMetric API v3, for end-to-end tool checks. */
import http from "node:http";

let nextId = 1000;
const state = {
  entries: [
    { id: 900, startTime: "2026-08-20T09:00:00", endTime: "2026-08-20T11:30:00",
      note: "Standup and planning", project: { id: 501, name: "Platform", client: { id: 90, name: "Acme" }, isBillable: true }, tags: [], isBillable: true },
  ],
};

const user = {
  id: 7001, name: "Daniil T", email: "daniil@example.com", activeAccountId: 42,
  timeZone: { ianaId: "Europe/Warsaw" },
  accounts: [{ id: 42, name: "LegalMation", firstWeekDay: 1,
    timeTracking: { allowManualEditing: true, allowNewProject: false, allowNewClient: false, allowNewTags: true,
      allowNewTask: true, requireDescription: true, requireProject: true, requireTags: false, requireTask: false, allowTeamView: true } }],
};

const projects = [
  { id: 501, name: "Platform", client: { id: 90, name: "Acme" }, isBillable: true, recentUsageTime: "2026-08-20T11:30:00" },
  { id: 502, name: "Internal tooling", isBillable: false, recentUsageTime: "2026-08-12T16:00:00" },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const auth = req.headers.authorization;
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };

  if (auth !== "Bearer test-token") return send(401, { message: "Invalid token" });

  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : undefined;
  const p = url.pathname;

  if (p === "/api/v3/user") return send(200, user);
  if (p === "/api/v3/accounts/42/timeentries/projects") return send(200, projects);
  if (p === "/api/v3/accounts/42/timeentries/tags") return send(200, [{ id: 11, name: "Development", isWorkType: true, isWorkTypeBillable: true }, { id: 12, name: "meeting", isWorkType: false }]);
  if (p === "/api/v3/accounts/42/clients") return send(200, [{ id: 90, name: "Acme" }]);

  if (p === "/api/v3/accounts/42/timeentries" && req.method === "GET") {
    const start = url.searchParams.get("startDate"), end = url.searchParams.get("endDate");
    return send(200, state.entries.filter((e) => e.startTime.slice(0, 10) >= start && e.startTime.slice(0, 10) <= end));
  }
  if (p === "/api/v3/accounts/42/timeentries" && req.method === "POST") {
    if (!json.note) return send(400, { message: "A description is required in this workspace." });
    if (!json.project?.id) return send(400, { message: "A project is required in this workspace." });
    const created = { ...json, id: nextId++, project: projects.find((x) => x.id === json.project.id) ?? json.project };
    state.entries.push(created);
    const day = created.startTime.slice(0, 10);
    return send(200, state.entries.filter((e) => e.startTime.slice(0, 10) === day));
  }
  const put = /^\/api\/v3\/accounts\/42\/timeentries\/(\d+)$/.exec(p);
  if (put && req.method === "PUT") {
    const id = Number(put[1]);
    const idx = state.entries.findIndex((e) => e.id === id);
    if (idx < 0) return send(404, { message: "Not found" });
    state.entries[idx] = { ...state.entries[idx], ...json, id, project: json.project?.id ? (projects.find((x) => x.id === json.project.id) ?? json.project) : state.entries[idx].project };
    return send(200, state.entries[idx]);
  }
  if (put && req.method === "DELETE") {
    state.entries = state.entries.filter((e) => e.id !== Number(put[1]));
    return send(204);
  }
  if (p === "/api/v3/accounts/42/timeentries/latest") {
    const sorted = [...state.entries].sort((a, b) => b.startTime.localeCompare(a.startTime));
    return send(200, sorted[0] ?? null);
  }
  if (p === "/api/v3/accounts/42/timeentries/recent") {
    return send(200, [{ note: "Standup and planning", project: projects[0], tags: [], isBillable: true, isPinned: true }]);
  }
  if (p === "/api/v3/accounts/42/reports/projects") {
    return send(200, [
      { project: projects[0], totalSeconds: 9000, billableSeconds: 9000, billableAmount: 375, billableCurrency: "USD" },
      { project: projects[1], totalSeconds: 3600, billableSeconds: 0 },
    ]);
  }
  if (p === "/api/v3/accounts/42/tasks") return send(200, [{ id: 301, name: "Payment webhook", project: projects[0], isCompleted: false }]);

  return send(404, { message: `No mock route for ${req.method} ${p}` });
});

server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
