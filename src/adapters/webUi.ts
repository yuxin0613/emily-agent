export function webAppHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emily AgentOS</title>
  <style>
    :root {
      color-scheme: light;
      --blue: #1976d2;
      --blue-dark: #0d47a1;
      --teal: #00897b;
      --red: #c62828;
      --amber: #b26a00;
      --ink: #17202a;
      --muted: #607080;
      --line: #d9e0e7;
      --panel: #ffffff;
      --surface: #f3f6f9;
      --nav: #243447;
      --nav-2: #1b2a39;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--surface); color: var(--ink); }
    button, input, textarea, select { font: inherit; }
    button { cursor: pointer; }
    .app { display: grid; grid-template-columns: 256px minmax(0, 1fr); min-height: 100vh; }
    .sidebar { background: var(--nav); color: #dce8f3; display: flex; flex-direction: column; min-height: 100vh; }
    .brand { height: 58px; display: flex; align-items: center; gap: 10px; padding: 0 18px; background: var(--nav-2); border-bottom: 1px solid rgba(255,255,255,0.08); }
    .brand-mark { width: 30px; height: 30px; border-radius: 6px; background: var(--blue); color: white; display: grid; place-items: center; font-weight: 800; }
    .brand-title { font-size: 15px; font-weight: 700; line-height: 1.1; }
    .brand-subtitle { font-size: 11px; color: #9fb5c8; margin-top: 2px; }
    .nav { padding: 14px 10px 20px; overflow-y: auto; }
    .nav-group { margin: 16px 0 6px; padding: 0 10px; color: #8fa8bd; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; }
    .nav-btn { width: 100%; min-height: 34px; border: 0; border-radius: 6px; background: transparent; color: #dce8f3; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 10px; text-align: left; }
    .nav-btn:hover { background: rgba(255,255,255,0.08); }
    .nav-btn.active { background: var(--blue); color: white; }
    .nav-icon { width: 20px; height: 20px; border-radius: 5px; display: grid; place-items: center; background: rgba(255,255,255,0.12); font-size: 11px; font-weight: 700; }
    .nav-count { min-width: 22px; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 11px; text-align: center; }
    .main { min-width: 0; min-height: 100vh; display: flex; flex-direction: column; }
    .topbar { height: 58px; background: var(--panel); border-bottom: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 0 20px; }
    .crumb { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .crumb small { color: var(--muted); }
    .page-title { margin: 0; font-size: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-actions { display: flex; align-items: center; gap: 8px; }
    .search { width: min(360px, 36vw); height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: #fbfcfd; }
    .content { padding: 18px 20px 28px; overflow: auto; }
    .grid { display: grid; gap: 14px; }
    .grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .panel-head { min-height: 46px; padding: 12px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .panel-title { margin: 0; font-size: 14px; font-weight: 700; }
    .panel-body { padding: 14px; }
    .metric { min-height: 88px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between; }
    .metric-label { color: var(--muted); font-size: 12px; }
    .metric-value { font-size: 27px; font-weight: 800; line-height: 1; }
    .metric.blue { border-top: 3px solid var(--blue); }
    .metric.teal { border-top: 3px solid var(--teal); }
    .metric.amber { border-top: 3px solid var(--amber); }
    .metric.red { border-top: 3px solid var(--red); }
    .btn { min-height: 32px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: #fff; color: var(--ink); display: inline-flex; align-items: center; gap: 6px; }
    .btn:hover { border-color: var(--blue); color: var(--blue-dark); }
    .btn.primary { background: var(--blue); border-color: var(--blue); color: white; }
    .btn.danger { background: #fff5f5; border-color: #efb9b9; color: var(--red); }
    .btn.ghost { background: transparent; }
    .pill { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border-radius: 999px; background: #edf3f8; color: #33546e; font-size: 12px; white-space: nowrap; }
    .pill.ok { background: #e7f5ef; color: #0b6f55; }
    .pill.warn { background: #fff4dc; color: #875200; }
    .pill.bad { background: #fdeaea; color: #a21c1c; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #edf1f5; vertical-align: top; }
    th { background: #f7f9fb; color: #526476; font-size: 12px; font-weight: 700; }
    tr:hover td { background: #fbfdff; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #eef3f8; border-radius: 4px; padding: 1px 4px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #15202b; color: #e9f1f8; padding: 12px; border-radius: 6px; max-height: 360px; overflow: auto; }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; }
    .form-row { display: grid; gap: 6px; margin-bottom: 10px; }
    .form-row label { font-size: 12px; color: var(--muted); }
    textarea { width: 100%; min-height: 118px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fbfcfd; }
    input.compact { height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: #fbfcfd; }
    .message { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; }
    .message.user { border-left: 3px solid var(--blue); }
    .message.agent { border-left: 3px solid var(--teal); }
    .muted { color: var(--muted); }
    .empty { color: var(--muted); padding: 18px; text-align: center; border: 1px dashed var(--line); border-radius: 8px; background: #fbfcfd; }
    .status-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
    .chat-shell { height: calc(100vh - 106px); min-height: 520px; display: flex; flex-direction: column; gap: 12px; }
    .chat-log { flex: 1; min-height: 0; overflow: auto; padding: 14px; background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; }
    .composer textarea { min-height: 96px; }
    @media (max-width: 1040px) {
      .app { grid-template-columns: 72px minmax(0, 1fr); }
      .brand-title, .brand-subtitle, .nav-label, .nav-count { display: none; }
      .brand { justify-content: center; padding: 0; }
      .nav-btn { grid-template-columns: 1fr; justify-items: center; padding: 8px 0; }
      .grid.cols-4, .grid.cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { min-height: auto; }
      .nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 8px; }
      .nav-group { display: none; }
      .brand { display: none; }
      .main { min-height: 0; }
      .topbar { grid-template-columns: 1fr; height: auto; padding: 12px; }
      .top-actions { justify-content: space-between; }
      .search { width: 100%; }
      .grid.cols-4, .grid.cols-3, .grid.cols-2 { grid-template-columns: 1fr; }
      .content { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">E</div>
        <div>
          <div class="brand-title">Emily AgentOS</div>
          <div class="brand-subtitle">Runtime Workspace</div>
        </div>
      </div>
      <nav class="nav" id="nav"></nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="crumb">
          <small>AgentOS</small>
          <h1 class="page-title" id="page-title">Overview</h1>
        </div>
        <div class="top-actions">
          <input class="search" id="global-search" placeholder="Search experience or run id">
          <span class="pill" id="connection-pill">connecting</span>
          <button class="btn" id="refresh-btn" type="button">Refresh</button>
        </div>
      </header>
      <section class="content" id="content"></section>
    </main>
  </div>
<script>
const views = [
  { id: 'dashboard', group: 'Workspace', label: 'Overview', icon: 'O' },
  { id: 'chat', group: 'Workspace', label: 'Chat', icon: 'C' },
  { id: 'sessions', group: 'Workspace', label: 'Sessions', icon: 'N', countKey: 'activeSessions' },
  { id: 'timeline', group: 'Workspace', label: 'Timeline', icon: 'T' },
  { id: 'providers', group: 'Runtime', label: 'Providers', icon: 'P' },
  { id: 'roles', group: 'Runtime', label: 'Roles', icon: 'R' },
  { id: 'tools', group: 'Runtime', label: 'Tools', icon: 'L' },
  { id: 'skills', group: 'Knowledge', label: 'Skills', icon: 'S' },
  { id: 'candidates', group: 'Knowledge', label: 'Skill Candidates', icon: 'K', countKey: 'proposedSkillCandidates' },
  { id: 'experiences', group: 'Knowledge', label: 'Experiences', icon: 'E' },
  { id: 'diagnostics', group: 'System', label: 'Diagnostics', icon: 'D' }
];
const state = {
  view: 'dashboard',
  health: null,
  lastRunId: localStorage.getItem('emily.lastRunId') || '',
  sessionId: localStorage.getItem('emily.sessionId') || 'web',
  messages: [],
  events: [],
  sessions: []
};
const qs = (selector) => document.querySelector(selector);
const api = {
  get: async (url) => request(url),
  post: async (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
};

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  qs('#refresh-btn').addEventListener('click', () => loadView(state.view));
  qs('#global-search').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const value = event.currentTarget.value.trim();
    if (!value) return;
    if (/^[a-f0-9-]{12,}$/i.test(value)) {
      state.lastRunId = value;
      localStorage.setItem('emily.lastRunId', value);
      navigate('timeline');
    } else {
      navigate('experiences', { query: value });
    }
  });
  startEventStream();
  refreshHealth()
    .then(() => loadSessions())
    .then(() => navigate(location.hash.replace('#', '') || 'dashboard'));
});

window.addEventListener('hashchange', () => {
  navigate(location.hash.replace('#', '') || 'dashboard');
});

async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && data.error ? data.error : response.statusText;
    throw new Error(message);
  }
  return data;
}

function renderNav() {
  const nav = qs('#nav');
  nav.replaceChildren();
  let lastGroup = '';
  for (const view of views) {
    if (view.group !== lastGroup) {
      lastGroup = view.group;
      nav.append(el('div', { className: 'nav-group' }, view.group));
    }
    const btn = el('button', { className: 'nav-btn', type: 'button', dataset: { view: view.id } },
      el('span', { className: 'nav-icon' }, view.icon),
      el('span', { className: 'nav-label' }, view.label),
      el('span', { className: 'nav-count', dataset: { countKey: view.countKey || '' } }, '')
    );
    btn.addEventListener('click', () => navigate(view.id));
    nav.append(btn);
  }
  updateNavState();
}

function updateNavState() {
  for (const button of document.querySelectorAll('.nav-btn')) {
    button.classList.toggle('active', button.dataset.view === state.view);
  }
  for (const count of document.querySelectorAll('[data-count-key]')) {
    const key = count.dataset.countKey;
    const value = key && state.health ? state.health[key] : '';
    count.textContent = value ? String(value) : '';
  }
}

async function navigate(view, options) {
  if (!views.some((item) => item.id === view)) view = 'dashboard';
  state.view = view;
  if (location.hash.replace('#', '') !== view) location.hash = view;
  qs('#page-title').textContent = views.find((item) => item.id === view).label;
  updateNavState();
  await loadView(view, options || {});
}

async function loadView(view, options) {
  const content = qs('#content');
  content.replaceChildren(el('div', { className: 'empty' }, 'Loading'));
  try {
    if (view === 'dashboard') return renderDashboard(content);
    if (view === 'chat') return renderChat(content);
    if (view === 'sessions') return renderSessions(content);
    if (view === 'timeline') return renderTimeline(content);
    if (view === 'providers') return renderProviders(content);
    if (view === 'roles') return renderRoles(content);
    if (view === 'tools') return renderTools(content);
    if (view === 'skills') return renderSkills(content);
    if (view === 'candidates') return renderCandidates(content);
    if (view === 'experiences') return renderExperiences(content, options.query || '');
    if (view === 'diagnostics') return renderDiagnostics(content);
  } catch (error) {
    content.replaceChildren(errorPanel(error));
  }
}

async function refreshHealth() {
  const payload = await api.get('/health');
  state.health = payload.runtime || {};
  qs('#connection-pill').textContent = 'online';
  qs('#connection-pill').className = 'pill ok';
  updateNavState();
}

async function loadSessions({ includeHidden = false, includeTrashed = false } = {}) {
  const query = new URLSearchParams({
    includeHidden: String(includeHidden),
    includeTrashed: String(includeTrashed),
    limit: '80'
  });
  let sessions = await api.get('/sessions?' + query.toString());
  if (!sessions.length && !includeHidden && !includeTrashed) {
    const created = await api.post('/sessions/new', { title: 'New session', source: 'web' });
    sessions = [created];
  }
  state.sessions = sessions;
  const activeSessions = sessions.filter((session) => session.status === 'active');
  const selected = activeSessions.find((session) => session.id === state.sessionId) || activeSessions[0];
  if (selected) {
    state.sessionId = selected.id;
    localStorage.setItem('emily.sessionId', selected.id);
  }
  updateNavState();
  return sessions;
}

async function newSession() {
  const created = await api.post('/sessions/new', { title: 'New session', source: 'web' });
  state.sessionId = created.id;
  state.messages = [];
  localStorage.setItem('emily.sessionId', created.id);
  await refreshHealth();
  await loadSessions();
  return created;
}

async function clearSession() {
  const result = await api.post('/sessions/clear', { sessionId: state.sessionId, reason: 'cleared from web' });
  state.sessionId = result.next.id;
  state.messages = [];
  localStorage.setItem('emily.sessionId', result.next.id);
  await refreshHealth();
  await loadSessions();
  return result;
}

async function renderDashboard(content) {
  await refreshHealth();
  const usage = await api.get('/providers/usage');
  const candidates = await api.get('/skill-candidates?status=proposed&limit=5');
  const events = await api.get('/events-snapshot').catch(() => state.events.slice(0, 8));
  const health = state.health || {};
  content.replaceChildren(
    el('div', { className: 'grid cols-4' },
      metric('Running Tasks', health.runningTasks || 0, 'blue'),
      metric('Pending Tasks', health.pendingTasks || 0, 'teal'),
      metric('Open Graphs', health.openTaskGraphs || 0, 'amber'),
      metric('Diagnostics', health.diagnostics || 0, health.diagnostics ? 'red' : 'blue')
    ),
    el('div', { className: 'split', style: 'margin-top:14px' },
      section('Runtime', [
        button('Maintenance', 'primary', async () => {
          const result = await api.post('/maintenance', {});
          notifyJson(result);
          await refreshHealth();
          await renderDashboard(content);
        }),
        button('Diagnostics', '', () => navigate('diagnostics'))
      ], el('div', { className: 'grid cols-3' },
        metric('Provider Calls', usage.totals && usage.totals.calls || 0, 'blue'),
        metric('Tokens', usage.totals && usage.totals.totalTokens || 0, 'teal'),
        metric('Skill Proposals', candidates.length, candidates.length ? 'amber' : 'blue')
      )),
      section('Recent Events', [
        button('Open Timeline', '', () => navigate('timeline'))
      ], eventList(events && Array.isArray(events) ? events : state.events.slice(0, 8)))
    )
  );
}

async function renderChat(content) {
  await loadSessions();
  const activeSessions = state.sessions.filter((session) => session.status === 'active');
  const sessionSelect = el('select', { className: 'compact', id: 'session-select' },
    ...activeSessions.map((session) => el('option', { value: session.id }, session.title || session.id))
  );
  sessionSelect.value = state.sessionId;
  sessionSelect.addEventListener('change', () => {
    state.sessionId = sessionSelect.value;
    state.messages = [];
    localStorage.setItem('emily.sessionId', state.sessionId);
    loadSessions().catch(console.error);
  });
  const log = el('div', { className: 'chat-log stack' });
  const redraw = () => {
    log.replaceChildren(...(state.messages.length ? state.messages.map((message) =>
      el('article', { className: 'message ' + message.kind },
        el('div', { className: 'status-line' }, el('strong', {}, message.kind === 'user' ? 'You' : 'Emily'), message.runId ? el('code', {}, message.runId) : ''),
        el('div', {}, message.content),
        message.delegatedTo && message.delegatedTo.length ? el('div', { className: 'status-line' }, 'delegated: ' + message.delegatedTo.join(', ')) : ''
      )
    ) : [el('div', { className: 'empty' }, 'No messages')]));
    log.scrollTop = log.scrollHeight;
  };
  const textarea = el('textarea', { placeholder: '输入需求、问题或维护指令' });
  const form = el('form', { className: 'panel composer' },
    el('div', { className: 'panel-body' },
      el('div', { className: 'form-row' }, el('label', {}, 'Message'), textarea),
      el('div', { className: 'row' }, el('button', { className: 'btn primary', type: 'submit' }, 'Send'), state.lastRunId ? el('span', { className: 'pill' }, 'last run ' + state.lastRunId) : '')
    )
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = textarea.value.trim();
    if (!message) return;
    if (message === '/new') {
      textarea.value = '';
      await newSession();
      await renderChat(content);
      return;
    }
    if (message === '/clear') {
      textarea.value = '';
      await clearSession();
      await renderChat(content);
      return;
    }
    state.sessionId = sessionSelect.value || state.sessionId;
    localStorage.setItem('emily.sessionId', state.sessionId);
    state.messages.push({ kind: 'user', content: message });
    textarea.value = '';
    redraw();
    try {
      const response = await api.post('/chat', { sessionId: state.sessionId, message });
      if (response.runId) {
        state.lastRunId = response.runId;
        localStorage.setItem('emily.lastRunId', response.runId);
      }
      state.messages.push({ kind: 'agent', content: response.content || '', runId: response.runId || '', delegatedTo: response.delegatedTo || [] });
      redraw();
      await refreshHealth();
    } catch (error) {
      state.messages.push({ kind: 'agent', content: error.message });
      redraw();
    }
  });
  redraw();
  content.replaceChildren(el('div', { className: 'chat-shell' },
    section('Session', [
      button('New', '', async () => {
        await newSession();
        await renderChat(content);
      }),
      button('Clear', 'danger', async () => {
        await clearSession();
        await renderChat(content);
      }),
      button('Manage', '', () => navigate('sessions'))
    ], el('div', { className: 'row' }, sessionSelect, state.sessionId ? codeText(state.sessionId) : '')),
    log,
    form
  ));
}

async function renderSessions(content) {
  const body = el('div', { className: 'stack' });
  const showArchived = el('select', { className: 'compact' },
    el('option', { value: 'active' }, 'active'),
    el('option', { value: 'all' }, 'active + hidden + trash'),
    el('option', { value: 'hidden' }, 'hidden'),
    el('option', { value: 'trashed' }, 'trash')
  );
  const load = async () => {
    const mode = showArchived.value;
    const query = mode === 'active'
      ? '/sessions?limit=80'
      : mode === 'hidden'
        ? '/sessions?status=hidden&limit=80'
        : mode === 'trashed'
          ? '/sessions?status=trashed&limit=80'
          : '/sessions?includeHidden=true&includeTrashed=true&limit=80';
    const sessions = await api.get(query);
    state.sessions = sessions.filter((session) => session.status === 'active');
    body.replaceChildren(sessions.length ? dataTable(['Title', 'Status', 'Runs', 'Last Active', 'Delete After', 'Actions'], sessions.map((session) => [
      el('div', { className: 'stack' }, el('strong', {}, session.title), codeText(session.id)),
      statusPill(session.status),
      String(session.runCount || 0),
      session.lastActiveAt || session.updatedAt || '',
      session.deleteAfter || '',
      sessionActions(session, load)
    ])) : el('div', { className: 'empty' }, 'No sessions'));
    await refreshHealth();
  };
  showArchived.addEventListener('change', load);
  content.replaceChildren(section('Sessions', [
    button('New', 'primary', async () => {
      await newSession();
      await load();
    }),
    button('Clear Current', 'danger', async () => {
      await clearSession();
      await load();
    }),
    button('Refresh', '', load)
  ], el('div', { className: 'row' }, showArchived)), body);
  await load();
}

function sessionActions(session, reload) {
  const actions = [];
  if (session.status === 'active') {
    actions.push(button('Use', '', async () => {
      state.sessionId = session.id;
      state.messages = [];
      localStorage.setItem('emily.sessionId', session.id);
      await loadSessions({ includeHidden: true, includeTrashed: true });
      navigate('chat');
    }));
    actions.push(button('Clear', 'danger', async () => {
      if (session.id === state.sessionId) {
        await clearSession();
      } else {
        await api.post('/sessions/clear', { sessionId: session.id, reason: 'cleared from web session manager' });
      }
      await reload();
    }));
  }
  if (session.status === 'hidden' || session.status === 'trashed') {
    actions.push(button('Restore', 'primary', async () => {
      const restored = await api.post('/sessions/restore', { sessionId: session.id });
      state.sessionId = restored.id;
      localStorage.setItem('emily.sessionId', restored.id);
      await loadSessions({ includeHidden: true, includeTrashed: true });
      await reload();
    }));
  }
  if (session.status === 'hidden') {
    actions.push(button('Move To Trash', 'danger', async () => {
      await api.post('/sessions/trash', { sessionId: session.id, reason: 'trashed from web session manager' });
      await reload();
    }));
  }
  return el('div', { className: 'row' }, ...actions);
}

async function renderTimeline(content) {
  const runInput = el('input', { className: 'compact', value: state.lastRunId, placeholder: 'run id' });
  const body = el('div', { className: 'stack' }, el('div', { className: 'empty' }, 'No run selected'));
  const load = async () => {
    const runId = runInput.value.trim();
    if (!runId) return;
    state.lastRunId = runId;
    localStorage.setItem('emily.lastRunId', runId);
    const timeline = await api.get('/timeline?runId=' + encodeURIComponent(runId));
    body.replaceChildren(
      section('Run', [], jsonBlock(timeline.run || {})),
      section('Tasks', [], dataTable(['Role', 'Status', 'Title', 'Task'], (timeline.tasks || []).map((task) => [
        task.role, statusPill(task.status), task.title, codeText(task.id)
      ]))),
      section('Events', [], eventList(timeline.events || []))
    );
  };
  content.replaceChildren(
    section('Timeline', [button('Load', 'primary', load)], el('div', { className: 'form-row' }, el('label', {}, 'Run ID'), runInput)),
    body
  );
  if (state.lastRunId) await load();
}

async function renderProviders(content) {
  const providers = await api.get('/providers');
  const health = await api.get('/providers/health');
  const usage = await api.get('/providers/usage');
  content.replaceChildren(
    el('div', { className: 'grid cols-4' },
      metric('Calls', usage.totals.calls, 'blue'),
      metric('Success', usage.totals.success, 'teal'),
      metric('Blocked', usage.totals.blocked, usage.totals.blocked ? 'red' : 'blue'),
      metric('Cost USD', Number(usage.totals.costUsd || 0).toFixed(6), 'amber')
    ),
    section('Providers', [button('Health', '', () => renderProviders(content))], dataTable(['ID', 'Type', 'Model', 'Enabled'], providers.map((provider) => [
      codeText(provider.id), provider.type, provider.model || '', provider.enabled === false ? statusPill('disabled') : statusPill('enabled')
    ]))),
    section('Health', [], dataTable(['Provider', 'Status', 'Message'], health.map((item) => [codeText(item.id), item.ok ? statusPill('ok') : statusPill('failed'), item.message || ''])))
  );
}

async function renderRoles(content) {
  const roles = await api.get('/roles');
  content.replaceChildren(section('Roles', [button('Initialize Defaults', '', async () => {
    await api.post('/roles/defaults', { overwrite: false });
    await renderRoles(content);
  })], dataTable(['Name', 'Provider', 'Model', 'Tools', 'Skills'], roles.map((role) => [
    codeText(role.name), role.provider || '', role.model || '', (role.allowedTools || []).join(', '), (role.skills || []).join(', ')
  ]))));
}

async function renderTools(content) {
  const tools = await api.get('/tools');
  content.replaceChildren(el('div', { className: 'grid cols-3' }, ...tools.map((tool) =>
    card(tool.name, [
      el('p', { className: 'muted' }, tool.description),
      el('div', { className: 'row' }, el('span', { className: 'pill' }, tool.category), el('span', { className: 'pill' }, tool.sideEffects), tool.requiresApproval ? el('span', { className: 'pill warn' }, 'approval') : el('span', { className: 'pill ok' }, 'direct')),
      el('p', {}, tool.instructions)
    ])
  )));
}

async function renderSkills(content) {
  const skills = await api.get('/skills');
  const candidates = await api.get('/skill-candidates?status=proposed&limit=5');
  content.replaceChildren(
    section('Skills', [button('Candidates', '', () => navigate('candidates'))], el('div', { className: 'grid cols-2' }, ...skills.map((skill) =>
      card(skill.title || skill.name, [
        el('div', { className: 'status-line' }, codeText(skill.name), el('span', { className: 'pill' }, skill.source)),
        el('p', { className: 'muted' }, skill.description),
        el('p', {}, (skill.capabilities || []).join(', ')),
        el('p', {}, 'tools: ' + ((skill.toolHints || []).join(', ') || '(none)'))
      ])
    ))),
    section('Proposed', [], candidates.length ? dataTable(['Name', 'Score', 'Type'], candidates.map((candidate) => [
      codeText(candidate.name), Number(candidate.score || 0).toFixed(3), candidate.proposalType
    ])) : el('div', { className: 'empty' }, 'No proposed candidates'))
  );
}

async function renderCandidates(content) {
  const status = el('select', { className: 'compact' },
    el('option', { value: 'proposed' }, 'proposed'),
    el('option', { value: 'approved' }, 'approved'),
    el('option', { value: 'merged' }, 'merged'),
    el('option', { value: 'rejected' }, 'rejected')
  );
  const body = el('div', { className: 'stack' });
  const load = async () => {
    const candidates = await api.get('/skill-candidates?status=' + encodeURIComponent(status.value) + '&limit=50');
    body.replaceChildren(candidates.length ? dataTable(['Name', 'Type', 'Score', 'Frequency', 'Decision', 'Actions'], candidates.map((candidate) => [
      codeText(candidate.name),
      candidate.proposalType,
      Number(candidate.score || 0).toFixed(3),
      String(candidate.frequency || 0),
      candidate.decisionReason || '',
      candidate.status === 'proposed' ? el('div', { className: 'row' },
        button('Approve', 'primary', async () => {
          const reason = prompt('Reason') || 'approved';
          await api.post('/skill-candidates/approve', { candidateId: candidate.id, reason });
          await load();
          await refreshHealth();
        }),
        button('Reject', 'danger', async () => {
          const reason = prompt('Reason') || 'rejected';
          await api.post('/skill-candidates/reject', { candidateId: candidate.id, reason });
          await load();
          await refreshHealth();
        })
      ) : statusPill(candidate.status)
    ])) : el('div', { className: 'empty' }, 'No candidates'));
  };
  const build = async () => {
    const result = await api.post('/skill-candidates/build', { lookbackDays: 2, minOccurrences: 3, minScore: 0.68 });
    notifyJson(result);
    await load();
    await refreshHealth();
  };
  status.addEventListener('change', load);
  content.replaceChildren(section('Skill Candidates', [button('Build', 'primary', build), button('Refresh', '', load)], el('div', { className: 'row' }, status)), body);
  await load();
}

async function renderExperiences(content, initialQuery) {
  const query = el('input', { className: 'compact', value: initialQuery, placeholder: 'query' });
  const body = el('div', { className: 'stack' });
  const load = async () => {
    const url = query.value.trim() ? '/experiences?q=' + encodeURIComponent(query.value.trim()) : '/experiences';
    const experiences = await api.get(url);
    body.replaceChildren(experiences.length ? el('div', { className: 'grid cols-2' }, ...experiences.map((experience) =>
      card(experience.title || experience.topicKey, [
        el('div', { className: 'status-line' }, codeText(experience.topicKey || experience.id), experience.score !== undefined ? el('span', { className: 'pill' }, 'score ' + Number(experience.score).toFixed(3)) : ''),
        el('p', { className: 'muted' }, experience.summary || experience.problemPattern || ''),
        el('p', {}, experience.solutionPattern || '')
      ])
    )) : el('div', { className: 'empty' }, 'No experiences'));
  };
  content.replaceChildren(section('Experiences', [button('Search', 'primary', load), button('Build Daily', '', async () => {
    const result = await api.post('/experiences/build-daily', {});
    notifyJson(result);
    await load();
  })], el('div', { className: 'form-row' }, el('label', {}, 'Query'), query)), body);
  await load();
}

async function renderDiagnostics(content) {
  await refreshHealth();
  const diagnostics = await api.get('/diagnostics');
  content.replaceChildren(
    el('div', { className: 'grid cols-4' },
      metric('Pending', state.health.pendingTasks || 0, 'blue'),
      metric('Running', state.health.runningTasks || 0, 'teal'),
      metric('Expired Leases', state.health.expiredLeases || 0, state.health.expiredLeases ? 'red' : 'blue'),
      metric('Candidates', state.health.proposedSkillCandidates || 0, 'amber')
    ),
    section('Diagnostics', [button('Repair', 'primary', async () => {
      const result = await api.get('/diagnostics?repair=true');
      notifyJson(result);
      await renderDiagnostics(content);
    }), button('Maintenance', '', async () => {
      const result = await api.post('/maintenance', {});
      notifyJson(result);
      await renderDiagnostics(content);
    })], diagnostics.length ? jsonBlock(diagnostics) : el('div', { className: 'empty' }, 'No diagnostics'))
  );
}

function startEventStream() {
  if (!window.EventSource) return;
  const source = new EventSource('/events');
  source.onopen = () => {
    qs('#connection-pill').textContent = 'online';
    qs('#connection-pill').className = 'pill ok';
  };
  source.onerror = () => {
    qs('#connection-pill').textContent = 'offline';
    qs('#connection-pill').className = 'pill bad';
  };
  const pushEvent = (event) => {
    try {
      const payload = JSON.parse(event.data);
      state.events.unshift(payload);
      state.events = state.events.slice(0, 50);
    } catch {}
  };
  source.addEventListener('stored-event', pushEvent);
  source.addEventListener('runtime-event', pushEvent);
}

function section(title, actions, body) {
  return el('section', { className: 'panel' },
    el('div', { className: 'panel-head' }, el('h2', { className: 'panel-title' }, title), el('div', { className: 'row' }, ...(actions || []))),
    el('div', { className: 'panel-body' }, body)
  );
}

function card(title, children) {
  return el('article', { className: 'panel' },
    el('div', { className: 'panel-head' }, el('h2', { className: 'panel-title' }, title)),
    el('div', { className: 'panel-body stack' }, ...(children || []))
  );
}

function metric(label, value, tone) {
  return el('div', { className: 'metric ' + (tone || 'blue') }, el('div', { className: 'metric-label' }, label), el('div', { className: 'metric-value' }, String(value)));
}

function dataTable(headers, rows) {
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((header) => el('th', {}, header)))),
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell)))))
  );
  return el('div', { className: 'table-wrap' }, table);
}

function eventList(events) {
  if (!events || !events.length) return el('div', { className: 'empty' }, 'No events');
  return dataTable(['Type', 'Task', 'Created'], events.slice(0, 20).map((event) => [
    event.type || '',
    event.taskId ? codeText(event.taskId) : '',
    event.createdAt || ''
  ]));
}

function statusPill(status) {
  const value = String(status || '');
  const klass = /ok|done|enabled|approved|merged|active|success/.test(value) ? 'pill ok'
    : /fail|dead|disabled|rejected|error|blocked|deleted|trashed/.test(value) ? 'pill bad'
      : /pending|running|queued|proposed|waiting|hidden/.test(value) ? 'pill warn' : 'pill';
  return el('span', { className: klass }, value);
}

function codeText(value) {
  return el('code', {}, String(value || ''));
}

function jsonBlock(value) {
  return el('pre', {}, JSON.stringify(value, null, 2));
}

function button(label, variant, onClick) {
  const btn = el('button', { className: 'btn ' + (variant || ''), type: 'button' }, label);
  if (onClick) btn.addEventListener('click', () => {
    Promise.resolve(onClick()).catch((error) => {
      alert(error && error.message ? error.message : String(error));
    });
  });
  return btn;
}

function errorPanel(error) {
  return section('Error', [], el('pre', {}, error && error.stack ? error.stack : String(error && error.message || error)));
}

function notifyJson(value) {
  console.log(value);
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  props = props || {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'value') node.value = value;
    else if (key === 'placeholder') node.placeholder = value;
    else if (key === 'id') node.id = value;
    else if (key === 'type') node.type = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
</script>
</body>
</html>`;
}
