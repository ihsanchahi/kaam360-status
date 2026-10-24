// The status page's history (#302): pure functions, no network, no files. check.mjs feeds in one sample every run and writes the
// result to data/status.json on the gh-pages branch; the page only draws what is here. Tested by aggregate.test.mjs (node --test tools/status).
//
// The history file is kept small on purpose: every check of the last 24 hours in detail ("recent"), and one line per day for the last
// 90 days ("days": how many checks, how many failed, average and slowest answer). A 5-minute schedule makes 288 checks a day, so the
// detail would be 26,000 lines over 90 days; the day lines are 90.

export const HISTORY_DAYS = 90;
export const RECENT_HOURS = 24;

/** The checks the workflow runs. The key is what the history is filed under; the page shows the name. */
export const CHECKS = [
  { key: 'health', name: 'Application and database', path: '/health' },
  { key: 'signin', name: 'Sign-in page', path: '/account/login' },
];

/** An empty history. */
export function emptyHistory() {
  return { version: 1, updatedAt: null, checks: CHECKS.map(c => ({ key: c.key, name: c.name })), recent: [], days: {}, incidents: null, summary: null };
}

const dayOf = iso => iso.slice(0, 10);
const monthOf = iso => iso.slice(0, 7);
const round = (n, places = 0) => { const p = 10 ** places; return Math.round(n * p) / p; };

/**
 * Adds one sample. A sample is { at: ISO string, results: { [checkKey]: { ok: boolean, ms: number, status?: number, error?: string } } }.
 * Returns a new history (the input is not changed): recent trimmed to 24 hours, the day lines updated and trimmed to 90 days.
 */
export function record(history, sample) {
  const h = history && history.version === 1 ? structuredClone(history) : emptyHistory();
  const at = new Date(sample.at);
  if (Number.isNaN(at.getTime())) throw new Error('sample.at must be an ISO date');
  const iso = at.toISOString();
  const keys = CHECKS.map(c => c.key);
  const results = {};
  for (const k of keys) {
    const r = sample.results?.[k];
    results[k] = r ? { ok: !!r.ok, ms: Math.max(0, Math.round(r.ms || 0)), ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: String(r.error).slice(0, 120) } : {}) } : { ok: false, ms: 0, error: 'not checked' };
  }
  const ok = keys.every(k => results[k].ok);
  const ms = Math.max(...keys.map(k => results[k].ms));

  // the detail of the last 24 hours
  h.recent = h.recent.filter(s => s.at !== iso);
  h.recent.push({ at: iso, ok, ms, results });
  h.recent.sort((a, b) => a.at < b.at ? -1 : 1);
  const cutoff = new Date(at.getTime() - RECENT_HOURS * 3600 * 1000).toISOString();
  h.recent = h.recent.filter(s => s.at > cutoff);

  // one line per day: n checks, f failures, avg ms, max ms, and the same per check
  const day = dayOf(iso);
  const d = h.days[day] || { n: 0, f: 0, ms: 0, max: 0, per: Object.fromEntries(keys.map(k => [k, { n: 0, f: 0 }])) };
  d.ms = round((d.ms * d.n + ms) / (d.n + 1));
  d.n += 1; if (!ok) d.f += 1; d.max = Math.max(d.max, ms);
  for (const k of keys) { d.per[k] ||= { n: 0, f: 0 }; d.per[k].n += 1; if (!results[k].ok) d.per[k].f += 1; }
  h.days[day] = d;
  const oldest = dayOf(new Date(at.getTime() - (HISTORY_DAYS - 1) * 86400 * 1000).toISOString());
  for (const k of Object.keys(h.days)) if (k < oldest) delete h.days[k];

  h.updatedAt = iso;
  h.summary = summarize(h, iso);
  return h;
}

/** Uptime as a percentage of checks that passed, or null when there were no checks. */
export function uptime(n, f) { return n === 0 ? null : round(((n - f) / n) * 100, 2); }

/**
 * What the page shows: the current state, uptime over 24 hours / 7 / 30 / 90 days, one entry per day for 90 days (for the bars),
 * one per month, and the average answer time of the last 24 hours. "now" is an ISO date, so the summary is the same for the same input.
 */
export function summarize(history, now) {
  const at = new Date(now || history.updatedAt || Date.now());
  const today = dayOf(at.toISOString());
  const last = history.recent[history.recent.length - 1] || null;
  const keys = CHECKS.map(c => c.key);

  const days = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const day = dayOf(new Date(at.getTime() - i * 86400 * 1000).toISOString());
    const d = history.days[day];
    days.push({ day, n: d?.n || 0, f: d?.f || 0, pct: d ? uptime(d.n, d.f) : null, ms: d?.ms ?? null, per: Object.fromEntries(keys.map(k => [k, d?.per?.[k] ? uptime(d.per[k].n, d.per[k].f) : null])) });
  }
  const over = count => { const slice = days.slice(-count); const n = slice.reduce((a, d) => a + d.n, 0), f = slice.reduce((a, d) => a + d.f, 0); return uptime(n, f); };
  const recentN = history.recent.length, recentF = history.recent.filter(s => !s.ok).length;

  const months = {};
  for (const [day, d] of Object.entries(history.days)) {
    const m = monthOf(day); months[m] ||= { month: m, n: 0, f: 0 };
    months[m].n += d.n; months[m].f += d.f;
  }
  const monthList = Object.values(months).sort((a, b) => a.month < b.month ? -1 : 1).map(m => ({ ...m, pct: uptime(m.n, m.f) }));

  const perCheck = Object.fromEntries(keys.map(k => {
    const n = days.reduce((a, d) => a + (history.days[d.day]?.per?.[k]?.n || 0), 0);
    const f = days.reduce((a, d) => a + (history.days[d.day]?.per?.[k]?.f || 0), 0);
    return [k, { pct90: uptime(n, f), ok: last ? !!last.results?.[k]?.ok : null, ms: last ? last.results?.[k]?.ms ?? null : null }];
  }));

  const recentMs = history.recent.filter(s => s.ok).map(s => s.ms);
  // Downtime in the last 24 hours, in minutes: each failed check stands for the gap until the next one (5 minutes on the schedule).
  const gap = history.recent.length > 1 ? Math.max(1, Math.round((new Date(history.recent[history.recent.length - 1].at) - new Date(history.recent[0].at)) / 60000 / (history.recent.length - 1))) : 5;

  return {
    now: at.toISOString(), today,
    state: last ? (last.ok ? 'up' : 'down') : 'unknown',
    lastCheckAt: last?.at || null, lastMs: last?.ms ?? null,
    uptime: { h24: uptime(recentN, recentF), d7: over(7), d30: over(30), d90: over(90) },
    downMinutes24h: recentF * gap,
    avgMs24h: recentMs.length ? Math.round(recentMs.reduce((a, b) => a + b, 0) / recentMs.length) : null,
    days, months: monthList, perCheck,
  };
}

/** The incident feed from the site, kept as it came, with when it was fetched. When the site is down, the last copy stays. */
export function keepIncidents(history, feed, fetchedAt) {
  const h = structuredClone(history);
  if (feed && typeof feed === 'object' && Array.isArray(feed.open)) h.incidents = { fetchedAt, ...feed };
  return h;
}
