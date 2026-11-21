import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountEmpty, mountSearchField, mountSelect, mountSpinner, mountTabs } from '@openchamber/sdk/ui';

type Skill = { id: string; count: number; share: number; lastUsed: number; tokens: number; cache: number; sessions: number };
type Day = { day: string; count: number; tokens: number; skills: string[] };
type Trend = {
  current: number; previous: number; pct: number | null; label: string;
  tokens: { current: number; previous: number; pct: number | null };
};
type Metric = 'tokens' | 'count';
type Breakdown = {
  range: string; label: string; total: number; tokens: number; cache: number;
  skills: Skill[]; days: Day[]; projects: string[]; streak: number; trend: Trend; builtAt: number;
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
let search = '';
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
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
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
  // Layout is not settled during the first paint, so defer the scroll to the newest days.
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
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

function weekBars(days: Day[]): HTMLElement {
  const wrap = el('div', 'week-bars');
  const byDay = new Map(days.map((d) => [d.day, d]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const entries = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today); date.setDate(date.getDate() - i);
    const info = byDay.get(ymd(date));
    entries.push({ date, info, value: info ? (metric === 'tokens' ? info.tokens : info.count) : 0 });
  }
  const max = Math.max(...entries.map((e) => e.value), 1);
  for (const { date, info, value } of entries) {
    const col = el('div', 'week-col');
    const track = el('div', 'week-track');
    const fill = el('div', 'week-bar');
    // Square root keeps small days visible next to one dominant day.
    fill.style.height = value ? `${Math.max(8, Math.sqrt(value / max) * 100)}%` : '0';
    fill.title = info
      ? `${ymd(date)} · ${info.count} use(s) · ${fmtTok(info.tokens)} tokens`
      : `${ymd(date)} · no skill use`;
    track.append(fill);
    const valueText = value ? (metric === 'tokens' ? fmtTok(value) : String(value)) : '·';
    col.append(
      el('span', 'week-value', valueText),
      track,
      el('span', 'week-label', weekdays[date.getDay()]),
    );
    wrap.append(col);
  }
  return wrap;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function freshness(builtAt: number): string {
  if (!builtAt) return 'fresh';
  const secs = Math.max(0, Math.round((Date.now() - builtAt) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
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
  const bothEmpty = trend.pct === null && trend.tokens.pct === null;

  const meta = el('div', 'meta');
  const line1 = el('div');
  const add = (parent: HTMLElement, text: string, bold = false) => {
    parent.append(bold ? el('b', '', text) : el('span', '', text));
  };
  add(line1, `${data.label}: `);
  add(line1, String(data.total), true);
  add(line1, ' uses · ');
  add(line1, String(data.skills.length), true);
  add(line1, ' skills · top ');
  add(line1, data.skills[0].id, true);
  add(line1, ' · ');
  add(line1, fmtTok(data.tokens), true);
  add(line1, ' tokens · ');
  add(line1, fmtTok(data.cache), true);
  add(line1, ' cached');

  const line2 = el('div');
  add(line2, `${data.streak}-day`, true);
  add(line2, ' streak · ');
  const comparisons: { text: string; strong: boolean }[] = [];
  if (bothEmpty) {
    comparisons.push({ text: `no data ${trend.label}`, strong: false });
  } else {
    comparisons.push({
      text: trend.pct === null ? `no use data ${trend.label}`
        : `${trend.pct >= 0 ? '+' : ''}${trend.pct}% uses ${trend.label}`,
      strong: trend.pct !== null,
    });
    if (trend.tokens.pct !== null) comparisons.push({
      text: `${trend.tokens.pct >= 0 ? '+' : ''}${trend.tokens.pct}% tokens ${trend.label}`,
      strong: true,
    });
  }
  comparisons.forEach((part, i) => {
    if (i) add(line2, ' · ');
    add(line2, part.text, part.strong);
  });
  add(line2, ' · updated ');
  add(line2, freshness(data.builtAt), true);
  if (data.expensive) {
    add(line2, ' · most: ');
    add(line2, data.expensive.id, true);
    add(line2, ' ');
    add(line2, fmtTok(data.expensive.tokens), true);
  }
  meta.append(line1, line2);
  root.append(meta);

  const max = data.skills[0].count || 1;
  const all = el('div', 'section');
  all.append(el('div', 'section-title', 'Skills in this period · uses · tokens'));
  if (data.skills.length > 6) {
    const searchBox = el('div');
    mountSearchField(searchBox, {
      value: search,
      placeholder: 'Filter skills…',
      onChange: (value: string) => { search = value; renderSkills(); },
    });
    all.append(searchBox);
  }
  const list = el('div');
  const more = el('div', 'more');
  let expanded = false;
  const renderSkills = () => {
    list.replaceChildren();
    more.replaceChildren();
    const query = search.trim().toLowerCase();
    const matched = query ? data.skills.filter((s) => s.id.toLowerCase().includes(query)) : data.skills;
    const shown = expanded ? matched : matched.slice(0, 6);
    for (const s of shown) {
      const row = bar(s.id, `${s.count}× · ${s.share}% · ${fmtTok(s.tokens)} tok`, (s.count / max) * 100);
      row.title = `last used ${ago(s.lastUsed)} · ${s.sessions} session(s) · ${fmtTok(s.cache)} cache read`;
      list.append(row);
    }
    if (!shown.length) list.append(el('div', 'sub', 'No matching skill.'));
    if (!expanded && matched.length > 6) {
      mountButton(more, {
        label: `Show ${matched.length - 6} more`,
        variant: 'ghost', size: 'xs',
        onClick: () => { expanded = true; renderSkills(); },
      });
    }
  };
  all.append(list, more);
  renderSkills();
  root.append(all);

  const active = data.days.filter((d) => d.count > 0);
  if (active.length && range !== 'today') {
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
    recent.append(range === 'week' ? weekBars(data.days) : heatmap(data.days));
    root.append(recent);
  }

  if (active.length) {
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
