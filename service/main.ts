import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// node:sqlite landed in Node 22.5. Load it lazily so older runtimes still answer
// with a clear note instead of crashing the whole service at import time.
let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'] | null = null;
try { DatabaseSync = (await import('node:sqlite')).DatabaseSync; }
catch { /* handled in the routes below */ }
const SQLITE_READY = () => DatabaseSync !== null;

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const ALL_PROJECTS = '__all__';

type Call = { skill_id: string; t: number; session: string; directory: string; title: string; auto?: boolean };
type Injected = Call & { tc: number };
type Msg = { s: string; q: number; t: number; tok: number; cache: number; skill: string | null; directory: string; title: string };
type Segment = { skill: string; start: number; tokens: number; cache: number; session: string };
type Day = { day: string; count: number; tokens: number; skills: string[] };
type LogEntry = { id: string; t: number; directory: string; session: string; title: string; auto: boolean };
type Row = Record<string, unknown>;

// OpenCode and OpenChamber both write skill tool calls to this database.
function findDb(): string | null {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.env.XDG_DATA_HOME) candidates.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  candidates.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  candidates.push(path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'opencode', 'opencode.db'));
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

const CALLS = `
SELECT sm.session_id AS session,
       json_extract(je.value, '$.state.input.id') AS skill_id,
       json_extract(sm.data, '$.time.created') AS t,
       v.directory AS directory,
       v.title AS title
FROM session_message AS sm
JOIN json_each(json_extract(sm.data, '$.content')) AS je
  ON json_extract(je.value, '$.type') = 'tool'
 AND lower(json_extract(je.value, '$.name')) = 'skill'
 AND lower(json_extract(je.value, '$.state.status')) = 'completed'
LEFT JOIN session_v2 AS v ON v.id = sm.session_id
WHERE sm.type = 'assistant'
`;

// OpenChamber injects skill content into user messages as a `skills` array.
const INJECTED = `
SELECT sm.session_id AS session,
       json_extract(sm.data, '$.time.created') AS t,
       sm.time_created AS tc,
       v.directory AS directory,
       v.title AS title,
       json_extract(je.value, '$.id') AS skill_id
FROM session_message AS sm
LEFT JOIN json_each(json_extract(sm.data, '$.skills')) AS je
LEFT JOIN session_v2 AS v ON v.id = sm.session_id
WHERE sm.type = 'user' AND sm.data LIKE '%"skills"%'
  __FILTER__
`;
const INJECTED_DELTA = INJECTED.replace('__FILTER__', 'AND sm.time_created > ?');

function readInjected(): Injected[] | null {
  if (!SQLITE_READY()) return null;
  const dbPath = findDb();
  if (!dbPath) return null;
  const sql = INJECTED.replace('__FILTER__', '');
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return (db.prepare(sql).all() as unknown as Injected[]).filter((i) => i.skill_id && i.t); }
    finally { db.close(); }
  } catch { return null; }
}

function readCalls(): Call[] | null {
  if (!SQLITE_READY()) return null;
  const dbPath = findDb();
  if (!dbPath) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return (db.prepare(CALLS).all() as unknown as Call[]).filter((c) => c.skill_id && c.t); }
    finally { db.close(); }
  } catch { return null; }
}

// One row per assistant message, with the skill it loaded when it made a skill tool call.
const MESSAGES = `
SELECT sm.session_id AS s, sm.seq AS q, sm.time_created AS t,
       COALESCE(json_extract(sm.data, '$.tokens.input'), 0)
     + COALESCE(json_extract(sm.data, '$.tokens.output'), 0)
     + COALESCE(json_extract(sm.data, '$.tokens.reasoning'), 0) AS tok,
       COALESCE(json_extract(sm.data, '$.tokens.cache.read'), 0) AS cache,
       json_extract(je.value, '$.state.input.id') AS skill,
       v.directory AS directory,
       v.title AS title
FROM session_message AS sm
LEFT JOIN json_each(json_extract(sm.data, '$.content')) AS je
  ON json_extract(je.value, '$.type') = 'tool'
 AND lower(json_extract(je.value, '$.name')) = 'skill'
 AND lower(json_extract(je.value, '$.state.status')) = 'completed'
LEFT JOIN session_v2 AS v ON v.id = sm.session_id
WHERE sm.type = 'assistant' AND sm.data LIKE '%"tokens"%'
  __FILTER__
ORDER BY sm.session_id, sm.seq
`;
const DELTA = MESSAGES.replace('__FILTER__', 'AND sm.time_created > ?');

function readMessages(sessions: string[]): Msg[] | null {
  if (!SQLITE_READY()) return null;
  if (!sessions.length) return [];
  const dbPath = findDb();
  if (!dbPath) return null;
  const sql = MESSAGES.replace('__FILTER__', `AND sm.session_id IN (${sessions.map(() => '?').join(',')})`);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).all(...sessions) as unknown as Msg[]; }
    finally { db.close(); }
  } catch { return null; }
}

// Compact snapshot kept outside the package, so opening the panel does not rescan the database.
const CACHE = path.join(os.homedir(), '.config', 'openchamber', 'guest-data', 'skill-usage', 'stats.json');
const FRESH_MS = 5_000;
const VERSION = 5;
type Snapshot = { version: number; builtAt: number; watermark: number; calls: Call[]; msgs: Msg[]; injected: Injected[] };
let snapshot: Snapshot | null = null;

function saveSnapshot(next: Snapshot): Snapshot {
  snapshot = next;
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(next));
  } catch { /* a missing cache only costs a rebuild */ }
  return next;
}

function readDisk(): Snapshot | null {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Snapshot;
    if (cached.version === VERSION && Array.isArray(cached.calls) && Array.isArray(cached.msgs) && Array.isArray(cached.injected)) return cached;
  } catch { /* no cache yet */ }
  return null;
}

function rebuild(): Snapshot {
  const calls = readCalls() ?? [];
  const sessions = [...new Set(calls.map((c) => c.session))];
  const msgs = readMessages(sessions) ?? [];
  const injected = readInjected() ?? [];
  const watermark = Math.max(0, ...calls.map((c) => c.t), ...msgs.map((m) => m.t), ...injected.map((i) => i.tc));
  return saveSnapshot({ version: VERSION, builtAt: Date.now(), watermark, calls, msgs, injected });
}

// Only messages newer than the watermark are read; the index keeps this small.
const LOOKBACK_MS = 5 * 60_000;
function refresh(): Snapshot {
  if (!SQLITE_READY()) return snapshot ?? readDisk() ?? rebuild();
  const base = snapshot ?? readDisk();
  if (!base) return rebuild();
  const watermark = typeof base.watermark === 'number' ? base.watermark : Math.max(0, ...base.msgs.map((m) => m.t));
  const dbPath = findDb();
  if (!dbPath) return base;
  let delta: Msg[] = [];
  let injectedDelta: Injected[] = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      delta = db.prepare(DELTA).all(watermark - LOOKBACK_MS) as unknown as Msg[];
      injectedDelta = db.prepare(INJECTED_DELTA).all(watermark - LOOKBACK_MS) as unknown as Injected[];
    } finally { db.close(); }
  } catch { return base; }

  const msgs = new Map(base.msgs.map((m) => [`${m.s}\u0000${m.q}`, m]));
  const calls = new Map(base.calls.map((c) => [`${c.session}\u0000${c.t}\u0000${c.skill_id}`, c]));
  for (const m of delta) {
    msgs.set(`${m.s}\u0000${m.q}`, m);
    if (m.skill) calls.set(`${m.s}\u0000${m.t}\u0000${m.skill}`, {
      session: m.s, t: m.t, skill_id: m.skill, directory: m.directory ?? '', title: m.title ?? '',
    });
  }
  const injected = new Map((base.injected ?? []).map((i) => [`${i.session}\u0000${i.t}\u0000${i.skill_id}`, i]));
  for (const i of injectedDelta) injected.set(`${i.session}\u0000${i.t}\u0000${i.skill_id}`, i);
  return saveSnapshot({
    version: VERSION,
    builtAt: Date.now(),
    watermark: Math.max(watermark, ...delta.map((m) => m.t), ...injectedDelta.map((i) => i.tc)),
    calls: [...calls.values()],
    msgs: [...msgs.values()],
    injected: [...injected.values()],
  });
}

function current(): Snapshot {
  if (snapshot && Date.now() - snapshot.builtAt < FRESH_MS) return snapshot;
  if (!snapshot) snapshot = readDisk();
  if (snapshot && Date.now() - snapshot.builtAt < FRESH_MS) return snapshot;
  // Refresh before answering so a poll never shows stale numbers.
  return snapshot ? refresh() : rebuild();
}

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const lastNDays = (n: number) => { const d = new Date(midnight()); d.setDate(d.getDate() - (n - 1)); return d.getTime(); };
const startOfYear = () => new Date(new Date().getFullYear(), 0, 1).getTime();

const CUTOFFS: Record<string, () => number> = {
  today: midnight, week: () => lastNDays(7), month: () => lastNDays(30), year: startOfYear, all: () => 0,
};
const LABELS: Record<string, string> = {
  today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'This year', all: 'All time',
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function aggregate(calls: Call[], cutoff: number) {
  const counts = new Map<string, { count: number; last: number }>();
  const days = new Map<string, number>();
  for (const c of calls) {
    if (c.t < cutoff) continue;
    const entry = counts.get(c.skill_id) ?? { count: 0, last: 0 };
    entry.count++;
    entry.last = Math.max(entry.last, c.t);
    counts.set(c.skill_id, entry);
    const key = dayKey(c.t);
    days.set(key, (days.get(key) ?? 0) + 1);
  }
  const skills = [...counts].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count);
  const dayList = [...days].map(([day, count]) => ({ day, count })).sort((a, b) => b.day.localeCompare(a.day));
  return { total: skills.reduce((sum, s) => sum + s.count, 0), skills, days: dayList };
}

// Tokens spent from the turn a skill was loaded until the next skill or the session ends.
function tokenSegments(msgs: Msg[]): Segment[] {
  const groups = new Map<string, { q: number; t: number; tok: number; cache: number; skills: string[] }>();
  for (const m of msgs) {
    const key = `${m.s}\u0000${m.q}`;
    let g = groups.get(key);
    if (!g) { g = { q: m.q, t: m.t, tok: m.tok, cache: m.cache, skills: [] }; groups.set(key, g); }
    if (m.skill && !g.skills.includes(m.skill)) g.skills.push(m.skill);
    g.tok = Math.max(g.tok, m.tok);
    g.cache = Math.max(g.cache, m.cache);
  }
  const ordered = [...groups.entries()].map(([key, g]) => ({ key, ...g }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.q - b.q);
  const segments: Segment[] = [];
  let current: { skills: string[]; start: number; tokens: number; cache: number; session: string } | null = null;
  let session = '';
  const flush = () => {
    if (!current) return;
    // A turn that loads several skills shares its tokens between them.
    const tokens = current.tokens / current.skills.length;
    const cache = current.cache / current.skills.length;
    for (const skill of current.skills) {
      segments.push({ skill, start: current.start, tokens, cache, session: current.session });
    }
    current = null;
  };
  for (const m of ordered) {
    const s = m.key.slice(0, m.key.indexOf('\u0000'));
    if (s !== session) { flush(); session = s; }
    if (m.skills.length) {
      flush();
      current = { skills: m.skills, start: m.t, tokens: 0, cache: 0, session: s };
    }
    if (!current) continue;
    current.tokens += m.tok;
    current.cache += m.cache;
  }
  flush();
  return segments;
}

function streakOf(days: Day[]): number {
  const active = new Set(days.filter((d) => d.count > 0).map((d) => d.day));
  if (!active.size) return 0;
  const cursor = new Date(midnight());
  if (!active.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (active.has(dayKey(cursor.getTime()))) { n++; cursor.setDate(cursor.getDate() - 1); }
  return n;
}

// Compare the selected period against the immediately preceding period of equal length.
type Bounds = { start: Date; end: Date; prevStart: Date; prevEnd: Date; label: string };

function boundsFor(allDays: Day[], range: string): Bounds {
  const today = new Date(midnight());
  let start: Date, prevStart: Date, prevEnd: Date, end = today, label: string;
  if (range === 'today') {
    start = new Date(today);
    prevStart = new Date(today); prevStart.setDate(prevStart.getDate() - 1);
    prevEnd = new Date(today);
    label = 'vs yesterday';
  } else if (range === 'week' || range === 'month') {
    const n = range === 'week' ? 7 : 30;
    start = new Date(today); start.setDate(start.getDate() - (n - 1));
    prevEnd = new Date(start);
    prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - n);
    label = `vs prior ${n} days`;
  } else if (range === 'year') {
    start = new Date(today.getFullYear(), 0, 1);
    prevEnd = new Date(today); prevEnd.setFullYear(prevEnd.getFullYear() - 1);
    prevStart = new Date(prevEnd.getFullYear(), 0, 1);
    label = 'vs last year';
  } else {
    const active = allDays.filter((d) => d.count > 0);
    if (!active.length) return { start: today, end: today, prevStart: today, prevEnd: today, label: 'vs previous period' };
    start = new Date(`${active[active.length - 1].day}T00:00:00`);
    end = new Date(`${active[0].day}T00:00:00`);
    const length = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (length - 1));
    label = 'vs previous period';
  }
  return { start, end, prevStart, prevEnd, label };
}

function trendOf(allDays: Day[], range: string, tokenByDay: Map<string, number>) {
  const counts = new Map(allDays.map((d) => [Date.parse(`${d.day}T00:00:00`), d.count]));
  const tokenCounts = new Map(allDays.map((d) => [Date.parse(`${d.day}T00:00:00`), tokenByDay.get(d.day) ?? 0]));
  const b = boundsFor(allDays, range);
  const sum = (from: number, to: number, source: Map<number, number>) => {
    let total = 0;
    for (const [t, n] of source) if (t >= from && t <= to) total += n;
    return Math.round(total);
  };
  const current = sum(b.start.getTime(), b.end.getTime(), counts);
  const previous = sum(b.prevStart.getTime(), b.prevEnd.getTime(), counts);
  const tokCurrent = sum(b.start.getTime(), b.end.getTime(), tokenCounts);
  const tokPrevious = sum(b.prevStart.getTime(), b.prevEnd.getTime(), tokenCounts);
  return {
    current, previous, pct: previous ? Math.round(((current - previous) / previous) * 100) : null, label: b.label,
    tokens: {
      current: tokCurrent, previous: tokPrevious,
      pct: tokPrevious ? Math.round(((tokCurrent - tokPrevious) / tokPrevious) * 100) : null,
    },
  };
}

function momentumOf(calls: Call[], b: Bounds) {
  const current = new Map<string, number>();
  const previous = new Map<string, number>();
  for (const c of calls) {
    const t = c.t;
    if (t >= b.start.getTime() && t <= b.end.getTime()) current.set(c.skill_id, (current.get(c.skill_id) ?? 0) + 1);
    else if (t >= b.prevStart.getTime() && t <= b.prevEnd.getTime()) previous.set(c.skill_id, (previous.get(c.skill_id) ?? 0) + 1);
  }
  const rows = [...new Set([...current.keys(), ...previous.keys()])].map((id) => ({
    id, current: current.get(id) ?? 0, previous: previous.get(id) ?? 0,
    delta: (current.get(id) ?? 0) - (previous.get(id) ?? 0),
  })).filter((r) => r.delta !== 0).sort((a, z) => Math.abs(z.delta) - Math.abs(a.delta));
  return { up: rows.filter((r) => r.delta > 0).slice(0, 3), down: rows.filter((r) => r.delta < 0).slice(0, 3) };
}

const note = (id: string, text: string, tone = 'muted'): Row =>
  ({ kind: 'note', id, text, tone });

function withAuto(snapshot: Snapshot, includeAuto: boolean): Call[] {
  if (!includeAuto) return snapshot.calls;
  return [
    ...snapshot.calls,
    ...snapshot.injected.map((i) => ({
      skill_id: i.skill_id, t: i.t, session: i.session, directory: i.directory, title: i.title, auto: true,
    })),
  ];
}

function statusRows(includeAuto: boolean): Row[] {
  if (!SQLITE_READY()) return [note('unsupported', 'Needs Node 22.5+ with node:sqlite.', 'warning')];
  const snapshot = current();
  const calls = withAuto(snapshot, includeAuto);
  if (!calls.length) return [note('db', 'No skill history found yet. Load a skill and it will appear here.')];
  const data = aggregate(calls, 0);
  if (!data.skills.length) return [note('empty', 'No skills used yet. Skills you load show up here.')];

  const top = data.skills[0].count || 1;
  const rows: Row[] = [note('summary', `${data.total} skill uses across ${data.skills.length} skills`)];
  for (const s of data.skills.slice(0, 8)) {
    rows.push({
      kind: 'line',
      id: `skill-${s.id}`,
      label: s.id,
      value: `${s.count}×`,
      content: { kind: 'bar', value: Math.round((s.count / top) * 100), tone: s === data.skills[0] ? 'accent' : 'info' },
    });
  }
  return rows;
}

function breakdown(range: string, project: string, includeAuto: boolean): Row {
  const snapshot = current();
  const { msgs } = snapshot;
  const calls = withAuto(snapshot, includeAuto);
  const projects = [...new Set(calls.map((c) => c.directory).filter(Boolean))].sort();
  const empty = { range, label: LABELS[range] ?? LABELS.all, total: 0, skills: [], days: [], tokens: 0, cache: 0,
    projects, streak: 0, builtAt: snapshot.builtAt, log: [], logTotal: 0,
    loadedTotal: snapshot.calls.length, injectedTotal: snapshot.injected.length, includeAuto,
    hours: Array(24).fill(0), momentum: { up: [], down: [] },
    trend: { current: 0, previous: 0, pct: null, label: 'vs previous period', tokens: { current: 0, previous: 0, pct: null } },
    expensive: null, totals: { today: 0, week: 0, month: 0, year: 0, all: 0 } };
  if (!calls.length) {
    return { ...empty, error: SQLITE_READY()
      ? 'No skill history found yet.'
      : 'This OpenChamber runtime needs Node 22.5+ with node:sqlite.' };
  }

  const scoped = project === ALL_PROJECTS ? calls : calls.filter((c) => c.directory === project);
  if (!scoped.length) return { ...empty, error: 'No skill history in this project.' };

  const totals = {
    today: scoped.filter((c) => c.t >= midnight()).length,
    week: scoped.filter((c) => c.t >= lastNDays(7)).length,
    month: scoped.filter((c) => c.t >= lastNDays(30)).length,
    year: scoped.filter((c) => c.t >= startOfYear()).length,
    all: scoped.length,
  };
  const cutoff = (CUTOFFS[range] ?? CUTOFFS.all)();
  const data = aggregate(scoped, cutoff);
  const sessionDir = new Map(calls.map((c) => [c.session, c.directory]));
  const scopedMsgs = project === ALL_PROJECTS ? msgs : msgs.filter((m) => sessionDir.get(m.s) === project);
  const allSegments = tokenSegments(scopedMsgs);
  const segments = allSegments.filter((seg) => seg.start >= cutoff);
  const tokenTotals = new Map<string, { tokens: number; cache: number; sessions: Set<string> }>();
  for (const seg of segments) {
    const entry = tokenTotals.get(seg.skill) ?? { tokens: 0, cache: 0, sessions: new Set<string>() };
    entry.tokens += seg.tokens;
    entry.cache += seg.cache;
    entry.sessions.add(seg.session);
    tokenTotals.set(seg.skill, entry);
  }
  const skills = data.skills.map((s) => {
    const t = tokenTotals.get(s.id);
    return {
      id: s.id, count: s.count,
      share: data.total ? Math.round((s.count / data.total) * 100) : 0,
      lastUsed: s.last,
      tokens: t?.tokens ?? 0,
      cache: t?.cache ?? 0,
      sessions: t?.sessions.size ?? 0,
    };
  });
  const byTokens = [...skills].sort((a, b) => b.tokens - a.tokens)[0];
  const dayInfo = new Map<string, { tokens: number; skills: Set<string> }>();
  for (const seg of allSegments) {
    const key = dayKey(seg.start);
    const info = dayInfo.get(key) ?? { tokens: 0, skills: new Set<string>() };
    info.tokens += seg.tokens;
    info.skills.add(seg.skill);
    dayInfo.set(key, info);
  }
  const days: Day[] = data.days.map((d) => {
    const info = dayInfo.get(d.day);
    return { day: d.day, count: d.count, tokens: info?.tokens ?? 0, skills: info ? [...info.skills].sort() : [] };
  });
  // Streak and both trends are always about full history, never the selected range.
  const allDays: Day[] = aggregate(scoped, 0).days.map((d) => {
    const info = dayInfo.get(d.day);
    return { day: d.day, count: d.count, tokens: info?.tokens ?? 0, skills: info ? [...info.skills].sort() : [] };
  });
  const tokenByDay = new Map(allDays.map((d) => [d.day, d.tokens]));
  const inRange = scoped.filter((c) => c.t >= cutoff);
  const log: LogEntry[] = [...inRange]
    .sort((a, b) => b.t - a.t)
    .slice(0, 20)
    .map((c) => ({
      id: c.skill_id, t: c.t, directory: c.directory, session: c.session, title: c.title ?? '', auto: c.auto === true,
    }));
  const hours = Array<number>(24).fill(0);
  for (const c of scoped) {
    if (c.t >= cutoff) hours[new Date(c.t).getHours()]++;
  }
  const momentum = momentumOf(scoped, boundsFor(allDays, range));
  return {
    range,
    builtAt: current().builtAt,
    log,
    logTotal: inRange.length,
    loadedTotal: snapshot.calls.length,
    injectedTotal: snapshot.injected.length,
    includeAuto,
    hours,
    momentum,
    label: LABELS[range] ?? LABELS.all,
    project,
    total: data.total,
    skills,
    days,
    tokens: segments.reduce((sum, seg) => sum + seg.tokens, 0),
    cache: segments.reduce((sum, seg) => sum + seg.cache, 0),
    projects,
    streak: streakOf(allDays),
    trend: trendOf(allDays, range, tokenByDay),
    expensive: byTokens?.tokens ? { id: byTokens.id, tokens: byTokens.tokens, count: byTokens.count } : null,
    totals,
  };
}

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return; }
  const includeAuto = url.searchParams.get('source') === 'auto';
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ rows: statusRows(includeAuto) }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/breakdown') {
    if (url.searchParams.get('force') === '1') rebuild();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(breakdown(
      url.searchParams.get('range') ?? 'all',
      url.searchParams.get('project') ?? ALL_PROJECTS,
      includeAuto,
    )));
    return;
  }
  res.writeHead(404).end();
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
