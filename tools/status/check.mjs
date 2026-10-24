#!/usr/bin/env node
// One run of the status check (#302), as the status-check workflow does it every 5 minutes:
//   node tools/status/check.mjs --site <folder of the gh-pages branch> [--base https://kaam360.com] [--timeout 20000] [--now <ISO>]
// 1. asks the site's /health and sign-in page (each at most twice, so one dropped packet is not an outage),
// 2. fetches /api/status/incidents (the incidents the platform team posted),
// 3. adds the result to <site>/data/status.json (see aggregate.mjs; the file is created when missing).
// It never fails the workflow because the site is down: a down site is exactly what it is there to record. Exit code 2 only for a wrong call.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECKS, emptyHistory, record, keepIncidents } from './aggregate.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : []).filter(Boolean));
const site = args.site;
if (!site) { console.error('usage: node tools/status/check.mjs --site <folder> [--base https://kaam360.com]'); process.exit(2); }
const base = (args.base || 'https://kaam360.com').replace(/\/$/, '');
const timeout = Number(args.timeout || 20000);
const now = args.now ? new Date(args.now) : new Date();

async function probe(url) {
  const started = performance.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'Kaam360-status-check/1 (+https://kaam360.com/status)', 'cache-control': 'no-cache' } });
    const ms = Math.round(performance.now() - started);
    // /health answers 503 with a JSON body when the database cannot be reached: that is "down" too.
    return { ok: res.status >= 200 && res.status < 400, ms, status: res.status };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - started), error: e?.name === 'TimeoutError' ? 'no answer within ' + timeout + ' ms' : (e?.cause?.code || e?.message || 'failed') };
  }
}

async function probeTwice(url) {
  const first = await probe(url);
  if (first.ok) return first;
  await new Promise(r => setTimeout(r, 5000));
  const second = await probe(url);
  return second.ok ? second : { ...second, error: (second.error || 'HTTP ' + second.status) + ' (twice)' };
}

const results = {};
for (const c of CHECKS) results[c.key] = await probeTwice(base + c.path);

let feed = null;
try {
  const res = await fetch(base + '/api/status/incidents', { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
  if (res.ok) feed = await res.json();
} catch { /* the site is down or slow: the last copy of the incidents stays */ }

const file = join(site, 'data', 'status.json');
let history = emptyHistory();
try { history = JSON.parse(await readFile(file, 'utf8')); } catch { /* first run */ }
history = record(history, { at: now.toISOString(), results });
history = keepIncidents(history, feed, now.toISOString());
await mkdir(join(site, 'data'), { recursive: true });
await writeFile(file, JSON.stringify(history) + '\n');

for (const c of CHECKS) { const r = results[c.key]; console.log(`${r.ok ? 'UP  ' : 'DOWN'} ${c.name}: ${r.status || ''} ${r.ms} ms ${r.error || ''}`.trim()); }
console.log(`incidents: ${feed ? (feed.open?.length || 0) + ' open' : 'not fetched (kept the last copy)'}; uptime 24h ${history.summary.uptime.h24 ?? '-'}%, 90d ${history.summary.uptime.d90 ?? '-'}%`);
