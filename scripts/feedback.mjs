#!/usr/bin/env node
// The feedback a user typed on the page, and the one deliberate step that moves it anywhere.
//
//   node scripts/feedback.mjs                what is on this machine, readable
//   node scripts/feedback.mjs --json         the same, raw, for an agent
//   node scripts/feedback.mjs --export DIR   copy it into DIR/feedback/<date>.jsonl
//   node scripts/feedback.mjs --clear        forget what is on this machine
//
// Nothing here uploads anything. Export writes into a checkout that a human then commits and
// pushes, having read what is in it — which is the whole point of the split: the records
// contain what someone said out loud, and that is not something a background process gets to
// publish on their behalf.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDBACK_FILE, formatRecord, loadFeedback, readFeedback } from "../src/feedback.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// The date a record belongs to, from the record itself: exporting yesterday's comments today
// must not file them under today.
export const dayOf = (record) => String(record?.at ?? "").slice(0, 10) || "undated";

// Records already in the target file, so exporting twice does not duplicate. Identity is the
// timestamp plus the comment: two records from the same instant with the same text are the
// same record, and nothing else about a record is guaranteed to be stable.
export const identity = (r) => `${r?.at ?? ""}::${r?.comment ?? ""}`;

export function newRecords(records, existing) {
  const seen = new Set(existing.map(identity));
  return records.filter((r) => !seen.has(identity(r)));
}

function exportTo(dir, records) {
  const outDir = join(dir, "feedback");
  mkdirSync(outDir, { recursive: true });
  const byDay = new Map();
  for (const r of records) {
    const day = dayOf(r);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const written = [];
  for (const [day, rs] of byDay) {
    const file = join(outDir, `${day}.jsonl`);
    const existing = existsSync(file) ? readFeedback(readFileSync(file, "utf8")) : [];
    const fresh = newRecords(rs, existing);
    if (!fresh.length) continue;
    appendFileSync(file, `${fresh.map((r) => JSON.stringify(r)).join("\n")}\n`);
    written.push({ file, added: fresh.length });
  }
  return written;
}

function main() {
  const records = loadFeedback();

  if (has("--json")) {
    process.stdout.write(`${JSON.stringify({ file: FEEDBACK_FILE, count: records.length, records }, null, 2)}\n`);
    return;
  }

  if (has("--clear")) {
    if (!has("--yes")) {
      process.stderr.write("--clear deletes every comment on this machine. Add --yes if that is what you want.\n");
      process.exitCode = 1;
      return;
    }
    writeFileSync(FEEDBACK_FILE, "");
    process.stdout.write(`Cleared ${records.length} record(s) from ${FEEDBACK_FILE}.\n`);
    return;
  }

  const dir = valueOf("--export");
  if (dir) {
    if (!existsSync(dir)) {
      process.stderr.write(`No such directory: ${dir}\n`);
      process.exitCode = 1;
      return;
    }
    const written = exportTo(dir, records);
    if (!written.length) {
      process.stdout.write(`Nothing new to export (${records.length} record(s) already there).\n`);
      return;
    }
    for (const w of written) process.stdout.write(`${w.added} record(s) -> ${w.file}\n`);
    process.stdout.write("Read them before committing: they contain what someone said out loud.\n");
    return;
  }

  if (!records.length) {
    process.stdout.write(`No feedback on this machine (${FEEDBACK_FILE}).\n`);
    return;
  }
  process.stdout.write(`${records.length} record(s) in ${FEEDBACK_FILE}\n\n`);
  process.stdout.write(`${records.map((r, i) => formatRecord(r, i)).join("\n\n")}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("feedback.mjs")) main();
