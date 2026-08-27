/**
 * Recomputes every answer in tmetric_evaluation.xml directly from the frozen
 * fixture and asserts they still match.
 *
 * This is what keeps the evaluation trustworthy: if the fixture is ever edited,
 * this script fails instead of the questions silently going stale.
 *
 * Run with: npm run verify:eval
 */

import { readFileSync } from "node:fs";
import { timeEntries } from "./fixture.mjs";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const minutes = (entry) => (Date.parse(`${entry.endTime}Z`) - Date.parse(`${entry.startTime}Z`)) / 60_000;
const day = (entry) => entry.startTime.slice(0, 10);
const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

const june = timeEntries.filter((entry) => entry.startTime.slice(0, 7) === "2026-06");

const minutesPerDay = new Map();
for (const entry of june) minutesPerDay.set(day(entry), (minutesPerDay.get(day(entry)) ?? 0) + minutes(entry));

const sumRange = (from, to) =>
  june.filter((entry) => day(entry) >= from && day(entry) <= to).reduce((sum, entry) => sum + minutes(entry), 0) / 60;

const groupSum = (items, key) => {
  const totals = new Map();
  for (const item of items) {
    const bucket = key(item);
    if (bucket === undefined) continue;
    totals.set(bucket, (totals.get(bucket) ?? 0) + minutes(item));
  }
  return totals;
};

const largest = (totals) => [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];

const computed = [
  largest(groupSum(june, (entry) => weekday(day(entry)))),
  String(sumRange("2026-06-08", "2026-06-12")),
  String(june.find((entry) => entry.startTime.slice(0, 10) !== entry.endTime.slice(0, 10)).id),
  [...new Set(june.filter((entry) => !entry.project.client).map((entry) => entry.project.name))][0],
  String(june.filter((entry) => entry.isBillable && entry.project.isBillable === false).length),
  [...minutesPerDay.entries()]
    .filter(([date]) => date >= "2026-06-01" && date <= "2026-06-05")
    .sort((a, b) => a[1] - b[1])[0][0],
  largest(groupSum(june, (entry) => entry.task?.name)),
  String(
    june
      .filter((entry) => entry.project.client?.name.startsWith("Acme") && entry.project.status === "active")
      .filter((entry) => !entry.isBillable)
      .reduce((sum, entry) => sum + minutes(entry), 0) / 60,
  ),
  [...minutesPerDay.entries()].filter(([, total]) => total >= 480).sort()[0][0],
  String(timeEntries.filter((entry) => entry.startTime < "2026").reduce((sum, entry) => sum + minutes(entry), 0) / 60),
];

const xml = readFileSync(new URL("./tmetric_evaluation.xml", import.meta.url), "utf8");
const declared = [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((match) => match[1].trim());

let failures = 0;
declared.forEach((expected, index) => {
  const actual = computed[index];
  const ok = expected === actual;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  Q${index + 1}: declared "${expected}"  computed "${actual}"`);
});

console.log(`\n${declared.length - failures}/${declared.length} answers verified against the fixture.`);
process.exit(failures === 0 ? 0 : 1);
