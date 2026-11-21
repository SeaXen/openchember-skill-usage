// Data-level regression test. Builds a tiny OpenCode-shaped database, points the
// service at it, and checks that counting, filtering and token sharing are right.
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-test-'));
const dataHome = path.join(tmp, 'data');
const dbDir = path.join(dataHome, 'opencode');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'opencode.db');

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT
  );
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
`);
const now = Date.now();
const part = (id, status = 'completed') => ({
  type: 'tool', name: 'skill',
  state: { status, input: id ? { id } : undefined },
});
const msg = (t, tokens, parts) => JSON.stringify({
  time: { created: t },
  tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  content: parts,
});
const insert = (id, session, seq, t, tokens, parts) => db.prepare(
  'INSERT INTO session_message VALUES (?,?,?,?,?,?,?)',
).run(id, session, 'assistant', seq, t, t, msg(t, tokens, parts));

insert('m1', 's1', 1, now, 100, [part('alpha')]);
insert('m2', 's1', 2, now + 1000, 200, []);
insert('m3', 's1', 3, now + 2000, 10, [part('beta')]);
insert('m4', 's2', 1, now + 3000, 500, [part('gamma', 'error')]);
insert('m5', 's3', 1, now + 4000, 400, [part('alpha'), part('delta')]);
for (const [id, dir] of [['s1', '/proj/one'], ['s2', '/proj/two'], ['s3', '/proj/three']]) {
  db.prepare('INSERT INTO session_v2 VALUES (?,?)').run(id, dir);
}
db.close();

const port = 46300 + Math.floor(Math.random() * 300);
const token = 'test-token';
const child = spawn(process.execPath, [path.join(root, 'service', 'main.js')], {
  env: {
    ...process.env,
    HOME: tmp,
    XDG_DATA_HOME: dataHome,
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
  },
  stdio: 'ignore',
});

const get = async (pathname, auth = true) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const checks = [];
const check = (name, pass) => checks.push([name, Boolean(pass)]);
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await get('/health')).status === 200) { up = true; break; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  check('service starts', up);

  const all = await get('/breakdown?range=all&force=1');
  const skills = Object.fromEntries((all.body.skills ?? []).map((s) => [s.id, s]));
  check('completed calls only (gamma excluded)', all.body.total === 4 && !skills.gamma);
  check('per-skill counts (alpha 2, beta 1, delta 1)',
    skills.alpha?.count === 2 && skills.beta?.count === 1 && skills.delta?.count === 1);
  check('multi-skill turn splits tokens (delta 200)', skills.delta?.tokens === 200);
  check('streak, trend and token trend present',
    typeof all.body.streak === 'number' &&
    typeof all.body.trend?.current === 'number' &&
    typeof all.body.trend?.tokens?.current === 'number');
  check('freshness timestamp present', typeof all.body.builtAt === 'number');
  check('recent log is newest-first and excludes failed calls',
    Array.isArray(all.body.log) && all.body.log.length >= 4 &&
    all.body.log[0].t >= all.body.log[1].t && !all.body.log.some((e) => e.id === 'gamma'));
  check('projects only from successful uses', all.body.projects?.length === 2);

  const status = await get('/status');
  check('status summary', status.body.rows?.[0]?.text === '4 skill uses across 3 skills');
  check('auth enforced', (await get('/status', false)).status === 401);

  const failed = checks.filter(([, pass]) => !pass);
  for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (failed.length) process.exitCode = 1;
} finally {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
