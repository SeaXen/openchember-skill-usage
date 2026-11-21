import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountEmpty, mountSelect, mountSpinner, mountTabs } from '@openchamber/sdk/ui';

type Skill = { id: string; count: number; share: number; lastUsed: number; tokens: number; cache: number; sessions: number };
type Day = { day: string; count: number; tokens: number; skills: string[] };
type Trend = { current: number; previous: number; pct: number | null; label: string };
type Metric = 'tokens' | 'count';
type Breakdown = {
  range: string; label: string; total: number; tokens: number; cache: number;
  skills: Skill[]; days: Day[]; projects: string[]; streak: number; trend: Trend;
  expensive: { id: string; tokens: number; count: number } | null;
  totals: { today: number; week: number; month: number; year: number; all: number }; error?: string;
};

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
const ALL = '__all__';
let ready = false;
let range = 'all';
let project = ALL;
let metric: Metric = 'tokens';
let canPersist = false;
let lastData: Breakdown | null = null;
const PREFS_KEY = 'view';

async function savePrefs(): Promise<void> {
  if (!canPersist) return;
  try { await host.storage.set(PREFS_KEY, { range, project, metric }, { scope: 'device' }); }
  catch { /* preferences are optional */ }
}

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7d' },
  { id: 'month', label: '30d' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All' },
];

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bar(label: string, value: string, pct: number): HTMLElement {
  const row = el('div', 'row');
  const top = el('div', 'row-top');
  top.append(el('span', 'name', label), el('span', 'num', value));
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.append(fill);
  row.append(top, track);
  return row;
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function heatmap(days: Day[]): HTMLElement {
  const wrap = el('div', 'heat-scroll');
  const grid = el('div', 'heat-grid');
  const byDay = new Map(days.map((d) => [d.day, d]));
  const end = range === 'all' && days.length ? new Date(`${days[0].day}T00:00:00`) : new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  if (range === 'all') {
    if (days.length) start.setTime(new Date(`${days[days.length - 1].day}T00:00:00`).getTime());
  } else if (range === 'year') {
    start.setMonth(0, 1);
  } else {
    start.setDate(start.getDate() - ((range === 'today' ? 1 : range === 'week' ? 7 : 30) - 1));
  }
  // Leading blanks so the first column starts on Sunday, like GitHub.
  for (let i = 0; i < start.getDay(); i++) grid.append(el('div', 'heat-cell'));
  const valueOf = (d: Day) => (metric === 'tokens' ? d.tokens : d.count);
  const max = Math.max(...days.map(valueOf), 1);
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const info = byDay.get(ymd(d));
    const cell = el('div', 'heat-cell');
    if (info && valueOf(info) > 0) {
      cell.style.background = 'var(--oc-primary)';
      cell.style.opacity = String([0.3, 0.5, 0.75, 1][Math.min(3, Math.floor((valueOf(info) / max) * 4))]);
      cell.title = `${ymd(d)} · ${info.count} use(s) · ${fmtTok(info.tokens)} tokens${info.skills.length ? ` · ${info.skills.join(', ')}` : ''}`;
    } else {
      cell.title = `${ymd(d)} · no skill use`;
    }
    grid.append(cell);
  }
  wrap.append(grid);
  const legend = el('div', 'heat-legend');
  legend.append(el('span', '', 'Less'));
  for (const o of [0.3, 0.5, 0.75, 1]) {
    const sw = el('i');
    sw.style.opacity = String(o);
    legend.append(sw);
  }
  legend.append(el('span', '', 'More'));
  legend.append(el('span', '', `· by ${metric === 'tokens' ? 'tokens' : 'uses'}`));
  wrap.append(legend);
  return wrap;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function ago(ts: number): string {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function shortPath(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

function draw(data: Breakdown): void {
  root.replaceChildren();
  if (data.error || !data.skills?.length) {
    mountEmpty(root, {
      title: data.error ?? 'No skills used yet',
      body: data.error ? 'Try another project, or load a skill.' : 'Skills you load will appear here.',
    });
    return;
  }

  const topbar = el('div', 'topbar');
  topbar.append(el('div', 'title', 'Skill usage'));
  if (data.projects?.length > 1) {
    const selector = el('div', 'proj');
    mountSelect(selector, {
      value: project,
      options: [
        { id: ALL, label: 'All projects' },
        ...data.projects.map((p) => ({ id: p, label: shortPath(p) })),
      ],
      onChange: (id: string) => { project = id; void savePrefs(); void load(); },
    });
    topbar.append(selector);
  }
  const tabs = el('div');
  mountTabs(tabs, {
    items: RANGES,
    activeId: range,
    onChange: (id: string) => { range = id; void savePrefs(); void load(); },
  });
  topbar.append(tabs);
  const refresh = el('div', 'refresh');
  mountButton(refresh, { label: 'Refresh', variant: 'ghost', size: 'xs', onClick: () => void load(true) });
  topbar.append(refresh);
  root.append(topbar);

  const stats = el('div', 'stats');
  const stat = (value: number | string, label: string): HTMLElement => {
    const box = el('div', 'stat');
    box.append(el('div', 'stat-v', String(value)), el('div', 'stat-l', label));
    return box;
  };
  stats.append(
    stat(data.totals.today, 'Today'),
    stat(data.totals.week, 'Week'),
    stat(data.totals.month, 'Month'),
    stat(data.totals.year, 'Year'),
    stat(data.totals.all, 'All time'),
  );
  root.append(stats);

  const trend = data.trend;
  const trendText = trend.pct === null
    ? `no data ${trend.label}`
    : `${trend.pct >= 0 ? '+' : ''}${trend.pct}% ${trend.label} (${trend.current} vs ${trend.previous})`;
  const meta = el('div', 'meta');
  meta.append(el('div', '', `${data.label}: ${data.total} uses · ${data.skills.length} skills · top ${data.skills[0].id}`));
  meta.append(el('div', '', `${fmtTok(data.tokens)} tokens · ${fmtTok(data.cache)} cached · ${data.streak}-day streak · ${trendText}`));
  if (data.expensive) {
    meta.append(el('div', '', `Most expensive: ${data.expensive.id} · ${fmtTok(data.expensive.tokens)} tok`));
  }
  root.append(meta);

  const max = data.skills[0].count || 1;
  const all = el('div', 'section');
  all.append(el('div', 'section-title', 'Skills in this period · uses · tokens'));
  const list = el('div');
  const addSkills = (items: Skill[]) => {
    for (const s of items) {
      const row = bar(s.id, `${s.count}× · ${s.share}% · ${fmtTok(s.tokens)} tok`, (s.count / max) * 100);
      row.title = `last used ${ago(s.lastUsed)} · ${s.sessions} session(s) · ${fmtTok(s.cache)} cache read`;
      list.append(row);
    }
  };
  addSkills(data.skills.slice(0, 6));
  all.append(list);
  if (data.skills.length > 6) {
    const more = el('div');
    mountButton(more, {
      label: `Show ${data.skills.length - 6} more`,
      variant: 'ghost', size: 'xs',
      onClick: () => { addSkills(data.skills.slice(6)); more.remove(); },
    });
    all.append(more);
  }
  root.append(all);

  const active = data.days.filter((d) => d.count > 0);
  if (active.length) {
    const recent = el('div', 'section');
    const recentHead = el('div', 'toolbar');
    recentHead.append(el('div', 'section-title', `Activity · ${data.label.toLowerCase()}`));
    const toggle = el('div', 'refresh');
    mountButton(toggle, {
      label: metric === 'tokens' ? 'by uses' : 'by tokens',
      variant: 'ghost', size: 'xs',
      onClick: () => { metric = metric === 'tokens' ? 'count' : 'tokens'; void savePrefs(); if (lastData) draw(lastData); },
    });
    recentHead.append(toggle);
    recent.append(recentHead);
    recent.append(heatmap(data.days));
    root.append(recent);

    const detail = el('div', 'section');
    detail.append(el('div', 'section-title', 'Skills used by day'));
    const dayList = el('div');
    const addDays = (items: Day[]) => {
      for (const d of items) {
        const row = el('div', 'day-row');
        row.append(
          el('span', 'day-date', d.day.slice(5)),
          el('span', 'day-skills', d.skills.length ? d.skills.join(' · ') : `${d.count} use(s)`),
          el('span', 'day-tok', `${fmtTok(d.tokens)} tok`),
        );
        row.title = `${d.day} · ${d.count} use(s)`;
        dayList.append(row);
      }
    };
    addDays(active.slice(0, 6));
    detail.append(dayList);
    if (active.length > 6) {
      const more = el('div', 'more');
      mountButton(more, {
        label: `Show ${active.length - 6} more days`,
        variant: 'ghost', size: 'xs',
        onClick: () => { addDays(active.slice(6)); more.remove(); },
      });
      detail.append(more);
    }
    root.append(detail);
  }
}

async function load(force = false): Promise<void> {
  const body = el('div');
  mountSpinner(body, { label: 'Reading skill history…' });
  root.replaceChildren(body);
  try {
    const params = new URLSearchParams({ range, project });
    if (force) params.set('force', '1');
    const res = await host.serviceRequest({ method: 'GET', path: `/breakdown?${params}` });
    const data: Breakdown = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    lastData = data;
    void host.setBadge(data.totals.today ? Math.min(data.totals.today, 999) : null);
    draw(data);
  } catch {
    root.replaceChildren();
    mountEmpty(root, { title: 'Could not read skill history', body: 'Open Work Status and try again.' });
  }
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (ready) return;
  ready = true;
  canPersist = Boolean(ctx.features?.deviceStorage);
  void (async () => {
    if (canPersist) {
      try {
        const saved = await host.storage.get(PREFS_KEY, { scope: 'device' }) as
          | { range?: string; project?: string; metric?: Metric } | undefined;
        if (saved?.range && RANGES.some((r) => r.id === saved.range)) range = saved.range;
        if (typeof saved?.project === 'string') project = saved.project;
        if (saved?.metric === 'tokens' || saved?.metric === 'count') metric = saved.metric;
      } catch { /* defaults are fine */ }
    }
    await load();
  })();
});
