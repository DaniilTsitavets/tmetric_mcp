/**
 * Deterministic TMetric dataset used by the evaluation suite.
 *
 * The evaluation questions in tmetric_evaluation.xml are answered against exactly
 * this data, which is why it is frozen here rather than pointed at a live
 * workspace: the answers must stay stable and verifiable by string comparison.
 *
 * Timestamps are naive local times, as the real API returns them.
 */

export const account = { id: 42, name: "LegalMation" };

export const user = {
  id: 7001,
  name: "Daniil Tsitavets",
  email: "daniil@example.com",
  activeAccountId: 42,
  timeZone: { ianaId: "Europe/Warsaw", displayName: "(UTC+01:00) Warsaw" },
  accounts: [
    {
      id: 42,
      name: "LegalMation",
      firstWeekDay: 1,
      timeTracking: {
        allowManualEditing: true,
        allowNewProject: false,
        allowNewClient: false,
        allowNewTags: true,
        allowNewTask: true,
        requireDescription: true,
        requireProject: true,
        requireTags: false,
        requireTask: false,
        allowTeamView: true,
      },
    },
  ],
};

export const clients = [
  { id: 90, name: "Acme Legal" },
  { id: 91, name: "Northwind Partners" },
];

export const projects = [
  { id: 501, name: "Platform", client: clients[0], isBillable: true, status: "active", recentUsageTime: "2026-06-19T17:00:00" },
  { id: 502, name: "Internal Tooling", isBillable: false, status: "active", recentUsageTime: "2026-06-17T15:00:00" },
  { id: 503, name: "Discovery Automation", client: clients[1], isBillable: true, status: "active", recentUsageTime: "2026-06-18T18:00:00" },
  { id: 504, name: "Website Redesign", client: clients[0], isBillable: true, status: "done", recentUsageTime: "2025-11-14T16:00:00" },
];

export const tags = [
  { id: 11, name: "Development", isWorkType: true, isWorkTypeBillable: true },
  { id: 12, name: "meeting", isWorkType: false },
  { id: 13, name: "Research", isWorkType: true, isWorkTypeBillable: false },
];

export const tasks = [
  { id: 301, name: "Payment webhook", project: projects[0], isCompleted: true, dueDate: "2026-06-12" },
  { id: 302, name: "Document ingestion pipeline", project: projects[2], isCompleted: false, dueDate: "2026-07-03" },
  { id: 303, name: "CI runner upgrade", project: projects[1], isCompleted: true, dueDate: null },
  { id: 304, name: "Retention policy audit", project: projects[0], isCompleted: false, dueDate: "2026-06-26" },
];

const P = Object.fromEntries(projects.map((project) => [project.id, project]));
const T = Object.fromEntries(tasks.map((task) => [task.id, task]));
const G = Object.fromEntries(tags.map((tag) => [tag.id, tag]));

/**
 * @param id entry id
 * @param d  date, YYYY-MM-DD
 * @param s  start, HH:mm
 * @param e  end, HH:mm ("+HH:mm" means the entry ends on the following day)
 */
function entry(id, d, s, e, note, projectId, taskId, tagIds, isBillable) {
  const crossesMidnight = e.startsWith("+");
  const endClock = crossesMidnight ? e.slice(1) : e;
  const endDate = crossesMidnight
    ? new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : d;
  return {
    id,
    startTime: `${d}T${s}:00`,
    endTime: `${endDate}T${endClock}:00`,
    note,
    project: P[projectId],
    ...(taskId ? { task: { id: taskId, name: T[taskId].name } } : {}),
    tags: (tagIds ?? []).map((tagId) => G[tagId]),
    isBillable,
    isInvoiced: false,
  };
}

/** Time entries for user 7001. Frozen — the evaluation answers depend on it. */
export const timeEntries = [
  // --- 2025, kept so questions can reach past "old" data -----------------------
  entry(700, "2025-11-13", "10:00", "16:00", "Landing page rebuild", 504, null, [11], true),
  entry(701, "2025-11-14", "09:30", "16:00", "Design QA pass", 504, null, [11], true),

  // --- Week 1: Mon 2026-06-01 … Fri 2026-06-05 --------------------------------
  entry(801, "2026-06-01", "09:00", "10:30", "Sprint planning", 501, null, [12], false),
  entry(802, "2026-06-01", "10:30", "14:00", "Payment webhook retries", 501, 301, [11], true),
  entry(803, "2026-06-01", "14:00", "17:00", "Payment webhook retries", 501, 301, [11], true),

  entry(804, "2026-06-02", "09:00", "12:00", "Document ingestion pipeline design", 503, 302, [13], true),
  entry(805, "2026-06-02", "13:00", "15:30", "Document ingestion pipeline design", 503, 302, [13], true),

  entry(806, "2026-06-03", "08:30", "12:30", "Payment webhook retries", 501, 301, [11], true),
  entry(807, "2026-06-03", "13:30", "18:00", "Ingestion pipeline prototype", 503, 302, [11], true),

  entry(808, "2026-06-04", "10:00", "12:00", "CI runner upgrade", 502, 303, [11], true),

  entry(809, "2026-06-05", "09:00", "11:00", "Weekly sync", 501, null, [12], false),
  entry(810, "2026-06-05", "11:00", "13:00", "Retention policy audit", 501, 304, [13], true),

  // --- Week 2: Mon 2026-06-08 … Fri 2026-06-12 --------------------------------
  entry(811, "2026-06-08", "09:00", "13:00", "Ingestion pipeline prototype", 503, 302, [11], true),
  entry(812, "2026-06-08", "14:00", "18:00", "Ingestion pipeline prototype", 503, 302, [11], true),

  entry(813, "2026-06-09", "09:00", "12:30", "Payment webhook retries", 501, 301, [11], true),
  entry(814, "2026-06-09", "13:30", "18:00", "Retention policy audit", 501, 304, [13], true),

  entry(815, "2026-06-10", "08:00", "12:00", "Ingestion pipeline prototype", 503, 302, [11], true),
  entry(816, "2026-06-10", "12:30", "17:30", "Payment webhook retries", 501, 301, [11], true),

  entry(817, "2026-06-11", "09:00", "10:00", "Standup and triage", 501, null, [12], false),
  entry(818, "2026-06-11", "10:00", "14:00", "CI runner upgrade", 502, 303, [11], true),

  entry(819, "2026-06-12", "09:00", "12:00", "Payment webhook retries", 501, 301, [11], true),
  entry(820, "2026-06-12", "13:00", "16:00", "Release checklist", 501, null, [12], true),

  // --- Week 3: Mon 2026-06-15 … Fri 2026-06-19 --------------------------------
  entry(821, "2026-06-15", "09:00", "12:00", "Retention policy audit", 501, 304, [13], true),
  entry(822, "2026-06-15", "13:00", "17:00", "Retention policy audit", 501, 304, [13], true),

  entry(823, "2026-06-16", "09:30", "13:30", "Ingestion pipeline hardening", 503, 302, [11], true),
  entry(824, "2026-06-16", "14:30", "17:30", "Ingestion pipeline hardening", 503, 302, [11], true),

  entry(825, "2026-06-17", "09:00", "12:00", "CI runner upgrade", 502, 303, [11], true),
  entry(826, "2026-06-17", "12:00", "15:00", "Internal docs cleanup", 502, null, [11], true),

  entry(827, "2026-06-18", "10:00", "14:00", "Ingestion pipeline hardening", 503, 302, [11], true),
  entry(828, "2026-06-18", "15:00", "18:00", "Northwind status call", 503, null, [12], true),

  entry(829, "2026-06-19", "09:00", "13:00", "Payment webhook retries", 501, 301, [11], true),
  entry(830, "2026-06-19", "22:00", "+02:00", "Production release window", 501, null, [11], true),
];

/** Recent-work shortcuts, as the TMetric "recent" list returns them. */
export const recentEntries = [
  { note: "Payment webhook retries", task: { id: 301, name: "Payment webhook" }, project: projects[0], tags: [tags[0]], isBillable: true, isPinned: true },
  { note: "Ingestion pipeline hardening", task: { id: 302, name: "Document ingestion pipeline" }, project: projects[2], tags: [tags[0]], isBillable: true, isPinned: false },
  { note: "CI runner upgrade", task: { id: 303, name: "CI runner upgrade" }, project: projects[1], tags: [tags[0]], isBillable: true, isPinned: false },
];
