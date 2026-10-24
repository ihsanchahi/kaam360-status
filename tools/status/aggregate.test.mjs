// node --test tools/status   (also run by the regression suite and by the status-check workflow before it trusts the script)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, summarize, emptyHistory, keepIncidents, uptime, HISTORY_DAYS, RECENT_HOURS } from './aggregate.mjs';

const at = (dayOffset, minutes) => new Date(Date.UTC(2026, 9, 19, 0, 0, 0) + dayOffset * 86400000 + minutes * 60000).toISOString();
const sample = (iso, ok = true, ms = 300, signinOk = ok) => ({ at: iso, results: { health: { ok, ms, status: ok ? 200 : 503 }, signin: { ok: signinOk, ms: ms + 50, status: 200 } } });

test('a first sample makes a day line and a recent entry', () => {
  const h = record(emptyHistory(), sample(at(0, 0)));
  assert.equal(h.recent.length, 1);
  assert.equal(h.days['2026-10-19'].n, 1);
  assert.equal(h.days['2026-10-19'].f, 0);
  assert.equal(h.days['2026-10-19'].ms, 350);   // the slowest check decides the sample's time
  assert.equal(h.summary.state, 'up');
  assert.equal(h.summary.uptime.h24, 100);
  assert.equal(h.summary.uptime.d90, 100);
});

test('the input is not changed', () => {
  const start = emptyHistory();
  record(start, sample(at(0, 0)));
  assert.equal(start.recent.length, 0);
  assert.deepEqual(start.days, {});
});

test('failures count against the day and the 24-hour figure, and a failed sign-in page alone counts as down', () => {
  let h = emptyHistory();
  for (let i = 0; i < 10; i++) h = record(h, sample(at(0, i * 5), i !== 3));
  h = record(h, sample(at(0, 50), true, 300, false));
  assert.equal(h.days['2026-10-19'].n, 11);
  assert.equal(h.days['2026-10-19'].f, 2);
  assert.equal(h.days['2026-10-19'].per.health.f, 1);
  assert.equal(h.days['2026-10-19'].per.signin.f, 2);   // the health failure took the sign-in page with it, plus the sign-in-only failure
  assert.equal(h.summary.uptime.h24, uptime(11, 2));
  assert.equal(h.summary.state, 'down');
  assert.equal(h.summary.downMinutes24h, 10);
  assert.equal(h.summary.perCheck.signin.ok, false);
  assert.equal(h.summary.perCheck.health.ok, true);
});

test('the detail keeps only the last 24 hours, the day lines only the last 90 days', () => {
  let h = emptyHistory();
  for (let d = -100; d <= 0; d++) h = record(h, sample(at(d, 600)));
  assert.equal(Object.keys(h.days).length, HISTORY_DAYS);
  assert.ok(!h.days['2026-07-10'], 'a day 101 days back is gone');
  assert.ok(h.days['2026-07-22'], 'the 90th day back is still there');
  assert.equal(h.recent.length, 1, 'only the sample from today is within 24 hours');
  h = record(h, sample(at(0, 600 + RECENT_HOURS * 60 - 1)));
  assert.equal(h.recent.length, 2, 'a sample 23h59m later is still within the window');
  h = record(h, sample(at(0, 600 + RECENT_HOURS * 60 + 5)));
  assert.equal(h.recent.length, 2, 'the first sample has now dropped out');
});

test('uptime over 7, 30 and 90 days and per month adds up the day lines', () => {
  let h = emptyHistory();
  // 60 days of 2 checks a day; on one day 40 days ago one check failed; on one day 3 days ago both failed
  for (let d = -59; d <= 0; d++) {
    h = record(h, sample(at(d, 0), d !== -40 && d !== -3));
    h = record(h, sample(at(d, 720), d !== -3));
  }
  const s = h.summary;
  assert.equal(s.uptime.d7, uptime(14, 2));
  assert.equal(s.uptime.d30, uptime(60, 2));
  assert.equal(s.uptime.d90, uptime(120, 3));
  assert.equal(s.days.length, HISTORY_DAYS);
  assert.equal(s.days[s.days.length - 1].day, '2026-10-19');
  assert.equal(s.days[0].pct, null, 'days before the history started show as unknown, not as 100%');
  assert.equal(s.days[s.days.length - 4].pct, 0);
  const oct = s.months.find(m => m.month === '2026-10');
  assert.equal(oct.n, 38);
  assert.equal(oct.f, 2);
  assert.equal(oct.pct, uptime(38, 2));
  assert.equal(s.months.find(m => m.month === '2026-09').pct, uptime(60, 1));
});

test('the same sample twice is kept once', () => {
  let h = record(emptyHistory(), sample(at(0, 0)));
  h = record(h, sample(at(0, 0)));
  assert.equal(h.recent.length, 1);
  assert.equal(h.days['2026-10-19'].n, 2, 'the day line counts both runs (it cannot tell), which is harmless');
});

test('the summary is the same for the same input, and the average answer time ignores failed checks', () => {
  let h = emptyHistory();
  h = record(h, sample(at(0, 0), true, 100));
  h = record(h, sample(at(0, 5), false, 20000));
  h = record(h, sample(at(0, 10), true, 300));
  const a = summarize(h, at(0, 10)), b = summarize(h, at(0, 10));
  assert.deepEqual(a, b);
  assert.equal(a.avgMs24h, 250);
  assert.equal(a.lastMs, 350);
});

test('the incident feed is kept when it arrives and left alone when the site is down', () => {
  let h = record(emptyHistory(), sample(at(0, 0)));
  const feed = { generatedAt: at(0, 0), open: [{ id: 1, title: 'Slow sign-in', status: 'investigating' }], maintenance: [], past: [] };
  h = keepIncidents(h, feed, at(0, 0));
  assert.equal(h.incidents.open[0].title, 'Slow sign-in');
  h = keepIncidents(h, null, at(0, 5));
  assert.equal(h.incidents.open[0].title, 'Slow sign-in', 'the last copy stays');
  h = keepIncidents(h, { nonsense: true }, at(0, 5));
  assert.equal(h.incidents.fetchedAt, at(0, 0), 'a broken answer is not taken');
});

test('a history from an unknown version is started afresh, and a bad date is refused', () => {
  const h = record({ version: 99, recent: [1, 2, 3] }, sample(at(0, 0)));
  assert.equal(h.recent.length, 1);
  assert.throws(() => record(emptyHistory(), { at: 'yesterday', results: {} }));
});
