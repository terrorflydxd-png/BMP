/* ЦехУчёт — клиент серверного прототипа */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  data: null,
  demo: [],
  config: { demo_mode: true, db: 'sqlite' },
  taskFilter: 'active',
  search: '',
  historyMachine: 'all',
  historyReason: 'all',
  taskId: null,
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    throw new ApiError('Сервер не отвечает. Проверьте, что он запущен.', 0);
  }
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    if (res.status === 401 && state.user && !path.includes('/auth/login')) showLogin();
    throw new ApiError(payload.detail || 'Не удалось выполнить действие', res.status);
  }
  return payload;
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[c]));

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

function money(value) {
  return `${nf0.format(Math.round(Number(value) || 0))} BYN`;
}

function hours(value) {
  return `${nf1.format(Number(value) || 0)} н/ч`;
}

function num(value, digits = 0) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function timeOf(d) {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function whenLabel(value) {
  const d = parseDate(value);
  if (!d) return '';
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) return `Сегодня, ${timeOf(d)}`;
  if (diff === 1) return `Вчера, ${timeOf(d)}`;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${timeOf(d)}`;
}

function dateLong(value) {
  const d = parseDate(value) || new Date();
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function avatar(user, cls = '') {
  if (!user) return '';
  return `<span class="avatar ${cls}" style="background:${esc(user.color || '#475569')}" aria-hidden="true">${esc(user.short || initials(user.name))}</span>`;
}

function badge(status, label) {
  return `<span class="badge ${esc(status)}">${esc(label || status)}</span>`;
}

function statusBadge(task) {
  return badge(task.status, task.status_label);
}

function icon(name, cls = '') {
  const paths = {
    shift: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    machine: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 8h4M7 11h7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    history: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    move: '<path d="M4 7h11M4 17h7M15 7h3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3"/><path d="M9 4 6 7l3 3M9 14l-3 3 3 3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2c-.6-.6-1.5-.9-2.5-.9-1.5 0-2.5.8-2.5 1.9 0 2.7 5 1.3 5 4 0 1.1-1 1.9-2.5 1.9-1.1 0-2-.4-2.6-1M12 6.5v11"/>',
    box: '<path d="m21 8-9-5-9 5v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2.1-2.1 2.9-2.7Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    download: '<path d="M12 3v11M7 9l5 5 5-5M4 21h16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.08a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  };
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.dot}</svg>`;
}

function brand(sizeCls = '') {
  return `<div class="brand ${sizeCls}"><span class="brand-mark">Ц</span><div><div class="brand-name">ЦехУчёт</div><div class="brand-sub">учёт цеха</div></div></div>`;
}

function showToast(message, type = 'ok') {
  const root = $('#toast-root');
  if (!root) return;
  root.innerHTML = `<div class="toast ${type === 'error' ? 'error' : ''}">${icon(type === 'error' ? 'alert' : 'check')}<span>${esc(message)}</span></div>`;
  root.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => root.classList.remove('show'), 3400);
}

function lockBody() { document.body.classList.add('modal-open'); }
function unlockBody() { if (!$$('.overlay').length) document.body.classList.remove('modal-open'); }

function closeTopOverlay() {
  const overlays = $$('.overlay');
  if (!overlays.length) return;
  overlays[overlays.length - 1].remove();
  unlockBody();
  if (!$$('.overlay').length) state.taskId = null;
}

function closeAllOverlays() {
  $$('.overlay').forEach((el) => el.remove());
  state.taskId = null;
  unlockBody();
}

/* ------------------------------------------------------------------------- */
/* Login                                                                     */
/* ------------------------------------------------------------------------- */

function loginHTML() {
  const accounts = state.demo.length ? state.demo : (state.config.demo_mode ? [
    { name: 'Андрей Соколов', role: 'director', position: 'Директор', pin: '1111', short: 'АС', color: '#1D4ED8' },
    { name: 'Сергей Ковалёв', role: 'master', position: 'Мастер смены', pin: '2222', short: 'СК', color: '#B45309' },
    { name: 'Игорь Петров', role: 'worker', position: 'Токарь', pin: '3101', short: 'ИП', color: '#1D4ED8' },
    { name: 'Роман Зайцев', role: 'worker', position: 'Токарь', pin: '3108', short: 'РЗ', color: '#C2410C' },
  ] : []);
  return `
  <div class="login">
    <section class="login-hero">
      <div class="brand"><span class="brand-mark">Ц</span><div><div class="brand-name">ЦехУчёт</div><div class="brand-sub">${state.config.db === 'postgresql' ? 'облачный сервер' : 'локальный сервер'}</div></div></div>
      <div class="hero-copy">
        <span class="hero-eyebrow"><span class="hero-dot"></span> Данные общие для всей смены</span>
        <h1>Цех, который<br><em>видит смену</em> целиком.</h1>
        <p>Задачи, станки и перемещения хранятся на сервере. Мастер и директор работают с одинаковыми правами, рабочий видит свои задачи и может переставить их на другой станок — с записью в истории.</p>
        <div class="hero-features">
          <span class="hero-feature">${icon('server')} Сервер и база</span>
          <span class="hero-feature">${icon('move')} История перемещений</span>
          <span class="hero-feature">${icon('coin')} Расчёт в BYN</span>
        </div>
      </div>
      <div class="hero-demo">
        <div class="hero-demo-top"><span class="hero-demo-label">Пример записи</span><span class="badge in_progress">В работе</span></div>
        <div class="hero-demo-task">Корпус-10 <small>D-4410 · 58 / 160 шт</small></div>
        <div class="hero-route">
          <div class="hero-machine"><b>VMC650</b><span>Фрезерный ЧПУ №1</span></div>
          <div class="hero-arrow">${icon('arrow')}</div>
          <div class="hero-machine"><b>VMC850</b><span>Фрезерный ЧПУ №2</span></div>
        </div>
        <div class="hero-demo-note">${icon('check')} Мастер Сергей Ковалёв · перегрузка станка · 14:32</div>
      </div>
      <div class="login-foot"><span>Сервер онлайн</span><span>${state.config.db === 'postgresql' ? 'PostgreSQL' : 'SQLite'}</span><span>${state.config.demo_mode ? 'Демо-данные' : 'Рабочие данные'}</span></div>
    </section>
    <section class="login-side">
      <div class="login-card">
        <div class="login-mobile-brand">${brand()}</div>
        <h2>Вход в цех</h2>
        <p>${state.config.demo_mode ? 'Введите PIN или выберите готовый демо-доступ.' : 'Введите свой PIN-код.'}</p>
        <form id="login-form" novalidate>
          <label class="field-label" for="pin-input">PIN-код <span>4 цифры</span></label>
          <div class="pin-wrap">${icon('lock')}<input class="pin-input" id="pin-input" name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="••••" aria-label="PIN-код"></div>
          <button class="login-submit" id="login-btn" type="submit">Войти в цех ${icon('arrow', 'ic-sm')}</button>
          <p class="login-error" id="login-error"></p>
        </form>
        ${accounts.length ? `<div class="demo-block">
          <div class="demo-title">Демо-доступы</div>
          <div class="demo-grid">
            ${accounts.map((a) => `
              <button type="button" class="demo-btn" data-action="demo-login" data-pin="${esc(a.pin)}" aria-label="Войти как ${esc(a.name)}">
                ${avatar(a)}
                <span style="min-width:0"><b>${esc(a.name)}</b><small>${esc(a.role === 'worker' ? a.position : a.role === 'director' ? 'Директор' : 'Мастер')} · PIN ${esc(a.pin)}</small></span>
              </button>`).join('')}
          </div>
        </div>` : ''}
        <p class="login-note">Директор и мастер обладают одинаковыми правами. Рабочий может перемещать только свои задачи; каждое перемещение сохраняется с автором, временем и причиной.</p>
      </div>
    </section>
  </div>`;
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg && typeof cfg === 'object') state.config = { ...state.config, ...cfg };
  } catch (err) { /* работаем с настройками по умолчанию */ }
}

async function loadDemo() {
  if (!state.config.demo_mode) { state.demo = []; return; }
  try {
    const accounts = await api('/api/demo-accounts');
    if (Array.isArray(accounts)) state.demo = accounts;
  } catch (err) { /* офлайн-подсказки уже встроены */ }
}

function showLogin(message = '') {
  state.user = null;
  state.data = null;
  state.taskId = null;
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('modal-open');
  document.title = 'Вход — ЦехУчёт';
  $('#app').innerHTML = loginHTML();
  const err = $('#login-error');
  if (err && message) err.textContent = message;
  const pin = $('#pin-input');
  if (pin && window.matchMedia('(min-width: 981px)').matches) setTimeout(() => pin.focus(), 80);
}

async function performLogin(pin) {
  const clean = String(pin || '').replace(/\D/g, '').slice(0, 4);
  const error = $('#login-error');
  const btn = $('#login-btn');
  if (clean.length !== 4) {
    if (error) error.textContent = 'Введите четыре цифры PIN.';
    return;
  }
  if (btn) { btn.disabled = true; btn.innerHTML = 'Входим…'; }
  if (error) error.textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: { pin: clean } });
    await loadData();
    ensureRoute();
    render();
    showToast('Вы вошли в цех');
  } catch (err) {
    if (error) error.textContent = err.status === 401 ? 'Неверный PIN. Подсказка: 1111 — директор, 2222 — мастер.' : err.message;
    if (btn) { btn.disabled = false; btn.innerHTML = `Войти в цех ${icon('arrow', 'ic-sm')}`; }
    const input = $('#pin-input');
    if (input) { input.select(); }
  }
}

/* ------------------------------------------------------------------------- */
/* Data and routing                                                          */
/* ------------------------------------------------------------------------- */

async function loadData() {
  const data = await api('/api/bootstrap');
  state.data = data;
  state.user = data.user;
  return data;
}

function defaultRoute() {
  return state.user && state.user.is_manager ? 'shift' : 'my';
}

function allowedRoutes() {
  return state.user && state.user.is_manager ? ['shift', 'tasks', 'machines', 'people', 'history'] : ['my', 'machines', 'history'];
}

function currentRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const allowed = allowedRoutes();
  return allowed.includes(raw) ? raw : defaultRoute();
}

function ensureRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const allowed = allowedRoutes();
  const route = allowed.includes(raw) ? raw : defaultRoute();
  if (!allowed.includes(raw)) history.replaceState(null, '', `#/${route}`);
  return route;
}

function navigate(route) {
  if (!allowedRoutes().includes(route)) return;
  if (currentRoute() === route && location.hash) {
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    location.hash = `#/${route}`;
  }
}

function navItems() {
  if (!state.user) return [];
  if (state.user.is_manager) {
    return [
      { id: 'shift', label: 'Смена', icon: 'shift' },
      { id: 'tasks', label: 'Задачи', icon: 'list' },
      { id: 'machines', label: 'Оборудование', icon: 'machine' },
      { id: 'people', label: 'Люди', icon: 'users' },
      { id: 'history', label: 'История', icon: 'history' },
    ];
  }
  return [
    { id: 'my', label: 'Мои задачи', icon: 'list' },
    { id: 'machines', label: 'Оборудование', icon: 'machine' },
    { id: 'history', label: 'История', icon: 'history' },
  ];
}

function pageInfo(route) {
  const pages = {
    shift: { title: 'Смена', sub: 'Обзор цеха' },
    tasks: { title: 'Задачи', sub: 'Все задачи смены' },
    machines: { title: 'Оборудование', sub: 'Станки и загрузка' },
    people: { title: 'Люди', sub: 'Команда цеха' },
    history: { title: 'История', sub: 'Перемещения задач' },
    my: { title: 'Мои задачи', sub: 'Личная смена' },
  };
  return pages[route] || pages.shift;
}

function navCounts() {
  const tasks = state.data ? state.data.tasks : [];
  const mine = state.user && !state.user.is_manager ? tasks.filter((t) => t.worker && t.worker.id === state.user.id) : tasks;
  return {
    active: mine.filter((t) => t.status !== 'done').length,
    blocked: mine.filter((t) => t.status === 'blocked').length,
  };
}

function sidebarHTML(route) {
  const counts = navCounts();
  const u = state.user;
  return `
  <aside class="sidebar">
    ${brand()}
    <button class="user-mini" type="button" data-action="profile" aria-label="Профиль и настройки">
      ${avatar(u)}
      <span style="min-width:0"><span class="user-mini-name">${esc(u.name)}</span><span class="user-mini-role">${esc(u.is_manager ? (u.role === 'director' ? 'Директор' : 'Мастер смены') : u.position)}</span></span>
      ${icon('chevron', 'chev')}
    </button>
    <nav class="side-nav" aria-label="Разделы">
      ${navItems().map((n) => {
        const count = n.id === 'tasks' || n.id === 'my' ? counts.active : 0;
        const alert = n.id === 'tasks' && counts.blocked ? ' alert' : '';
        return `<a class="nav-link ${route === n.id ? 'active' : ''}" href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${esc(n.label)}</span>${count ? `<span class="nav-count${alert}">${count}</span>` : ''}</a>`;
      }).join('')}
    </nav>
    <div class="side-bottom">
      <div class="server-chip"><span class="server-dot" id="server-dot"></span><span><b>Сервер онлайн</b><br>${state.config.db === 'postgresql' ? 'PostgreSQL' : 'SQLite'} · общие данные</span></div>
      <div class="side-rate">Ставка расчёта<br><b style="color:var(--ink-2)">${num(state.data.rate_byn)} BYN / нормо-час</b></div>
      <div class="side-version">${esc(state.data.version)} · демо</div>
    </div>
  </aside>`;
}

function mobileBarHTML(route) {
  const page = pageInfo(route);
  return `
  <header class="mobile-bar">
    ${brand()}
    <div class="mobile-user">
      <span style="font-size:11px;color:var(--muted);font-weight:650">${esc(page.title)}</span>
      <button type="button" class="icon-btn" data-action="profile" aria-label="Профиль">${avatar(state.user, 'avatar-sm')}</button>
    </div>
  </header>`;
}

function bottomNavHTML(route) {
  const counts = navCounts();
  return `
  <nav class="bottom-nav" aria-label="Навигация">
    ${navItems().map((n) => {
      const count = n.id === 'tasks' || n.id === 'my' ? counts.active : 0;
      return `<a class="bottom-link ${route === n.id ? 'active' : ''}" href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${esc(n.label === 'Оборудование' ? 'Станки' : n.label)}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</a>`;
    }).join('')}
  </nav>`;
}

function render() {
  if (!state.user || !state.data) { showLogin(); return; }
  const route = ensureRoute();
  const page = pageInfo(route);
  document.title = `${page.title} — ЦехУчёт`;
  let content = '';
  if (route === 'shift') content = renderShift();
  else if (route === 'tasks') content = renderTasks();
  else if (route === 'machines') content = renderMachines();
  else if (route === 'people') content = renderPeople();
  else if (route === 'history') content = renderHistory();
  else if (route === 'my') content = renderMy();
  $('#app').innerHTML = `<div class="app-shell">${sidebarHTML(route)}<div class="main-col">${mobileBarHTML(route)}<main class="page">${content}</main>${bottomNavHTML(route)}</div></div>`;
}

function pageHead(eyebrow, title, subtitle, actions = '') {
  return `
  <div class="page-head">
    <div>
      <div class="eyebrow">${eyebrow}</div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------------- */
/* Dashboard                                                                 */
/* ------------------------------------------------------------------------- */

function taskById(id) {
  return state.data.tasks.find((t) => t.id === id);
}

function activeTasks() {
  return state.data.tasks.filter((t) => t.status !== 'done');
}

function totals(tasks = state.data.tasks) {
  const plan = tasks.reduce((sum, t) => sum + Number(t.norm_hours || 0), 0);
  const done = tasks.reduce((sum, t) => sum + Number(t.norm_hours || 0) * Number(t.progress || 0), 0);
  const earned = tasks.reduce((sum, t) => sum + Number(t.earned_byn || 0), 0);
  return { plan, done, earned };
}

function taskRow(task, opts = {}) {
  const isGeneral = task.kind === 'general';
  const p = Math.round(Number(task.progress || 0) * 100);
  const moveBtn = opts.showMove && task.status !== 'done'
    ? `<button class="btn btn-soft btn-sm quick-move" type="button" data-action="move" data-task="${esc(task.id)}">${icon('move', 'ic-sm')} Переместить</button>` : '';
  return `
  <div class="task-row" data-open-task="${esc(task.id)}" role="button" tabindex="0" aria-label="Открыть задачу ${esc(task.title)}">
    <span class="prio p${Number(task.priority)}">P${Number(task.priority)}</span>
    <div class="task-main">
      <div class="task-title-line"><span class="task-title">${esc(task.title)}</span>${task.article ? `<span class="article">${esc(task.article)}</span>` : ''}</div>
      <div class="task-meta">${icon('machine', 'ic-sm')}<span>${esc(task.machine ? task.machine.model : '—')}</span><span class="dot"></span>${icon('user', 'ic-sm')}<span class="worker-name">${esc(task.worker ? task.worker.name.split(' ')[0] : '—')}</span><span class="dot"></span>${icon('clock', 'ic-sm')}<span>${esc(task.due_label || '—')}</span></div>
      ${!isGeneral ? `<div class="mini-progress" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, p))}%"></span></div>` : ''}
      ${moveBtn}
    </div>
    <div class="task-side">
      ${statusBadge(task)}
      <strong>${isGeneral ? hours(task.norm_hours) : `${num(task.done_qty)} / ${num(task.qty)}`}</strong>
      <small>${isGeneral ? (task.status === 'done' ? money(task.norm_hours * state.data.rate_byn) : 'фиксированное время') : money(task.earned_byn)}</small>
    </div>
  </div>`;
}

function taskListHTML(tasks, opts = {}) {
  if (!tasks.length) {
    return `<div class="empty"><div class="empty-icon">${icon('list', 'ic-lg')}</div><b>${esc(opts.emptyTitle || 'Здесь пока пусто')}</b><p>${esc(opts.emptyText || 'Задачи появятся, когда мастер поставит смену.')}</p></div>`;
  }
  return `<div class="task-list">${tasks.map((t) => taskRow(t, opts)).join('')}</div>`;
}

function renderShift() {
  const data = state.data;
  const active = activeTasks();
  const inWork = active.filter((t) => t.status === 'in_progress');
  const blocked = active.filter((t) => t.status === 'blocked');
  const plan = totals();
  const donePct = plan.plan ? Math.min(100, Math.round(plan.done / plan.plan * 100)) : 0;
  const busyWorkers = new Set(active.map((t) => t.worker && t.worker.id).filter(Boolean)).size;
  const workingMachines = data.machines.filter((m) => m.status === 'working').length;
  const managers = data.staff.filter((u) => u.is_manager).length;
  const date = dateLong(data.server_time);
  const shiftTasks = [...active].sort((a, b) => a.priority - b.priority).slice(0, 7);

  const attention = blocked.slice(0, 3).map((t) => `
    <div class="attention-item" data-open-task="${esc(t.id)}" role="button" tabindex="0">
      <div class="attention-icon">${icon('alert', 'ic-sm')}</div>
      <div style="min-width:0"><div class="attention-title">${esc(t.title)}${t.article ? ` · ${esc(t.article)}` : ''}</div><div class="attention-sub">${esc(t.worker ? t.worker.name : '')} · ${esc(t.note || 'Нужно решение мастера')}</div></div>
      <span class="attention-cta">Открыть</span>
    </div>`).join('');

  const loadRows = [...data.machines].map((m) => {
    const tasks = active.filter((t) => t.machine && t.machine.id === m.id);
    const h = tasks.reduce((s, t) => s + Number(t.norm_hours || 0), 0);
    return { m, h, count: tasks.length };
  }).sort((a, b) => b.h - a.h).slice(0, 5).map(({ m, h, count }) => {
    const load = Math.min(100, Math.round(h / 22 * 100));
    const cls = m.status === 'repair' ? 'idle' : load > 85 ? 'hot' : load > 65 ? 'warn' : '';
    return `<div class="load-row"><div class="load-top"><b>${esc(m.name)}</b><span>${count} задач · ${hours(h)}</span></div><div class="load-track"><span class="${cls}" style="width:${load}%"></span></div></div>`;
  }).join('');

  const recent = data.movements.slice(0, 4).map((m) => `
    <div class="task-move" style="cursor:pointer" data-open-task="${esc(m.task_id)}">
      <div class="task-move-dot">${icon(m.from_machine ? 'move' : 'plus')}</div>
      <div class="task-move-body"><b>${esc(m.task_title)}</b><p>${m.from_machine ? `${esc(m.from_machine.model)} → ${esc(m.to_machine.model)}` : `На ${esc(m.to_machine.model)}`} · ${esc(m.moved_by ? m.moved_by.short : '')}</p><small>${whenLabel(m.created_at)} · ${esc(m.from_machine ? m.reason_label : 'Создание задачи')}</small></div>
    </div>`).join('');

  return `
  ${pageHead(`${esc(date)} <span class="sep"></span> Смена 08:00–20:00`, `Смена в цеху`, `Общий сервер: ${managers} руководителя и ${data.staff.length - managers} рабочих. Директор и мастер имеют одинаковые права.`, `<button class="btn btn-primary" type="button" data-action="open-create">${icon('plus')} Поставить задачу</button>`)}

  <section class="shift-hero">
    <div class="hero-layout">
      <div>
        <span class="hero-pill"><span class="server-dot"></span> Данные синхронизированы</span>
        <h2 class="hero-title">${blocked.length ? `Смена идёт, <span>${blocked.length} ${blocked.length === 1 ? 'задача ждёт' : 'задачи ждут'}</span> решения` : 'Смена идёт по плану'}</h2>
        <p class="hero-sub">${inWork.length} задач в работе, ${workingMachines} станков задействовано. Все изменения сразу видны на других устройствах.</p>
        <div class="hero-metrics">
          <div class="hero-metric"><b>${active.length}</b><span>активных задач</span></div>
          <div class="hero-metric"><b>${hours(plan.plan)}</b><span>план смены</span></div>
          <div class="hero-metric"><b>${money(plan.earned)}</b><span>заработано</span></div>
        </div>
      </div>
      <div class="hero-right">
        <div class="donut" style="--p:${donePct}"><div class="donut-inner"><b>${donePct}%</b><span>плана</span></div></div>
        <div class="hero-plan">
          <div class="hero-plan-row"><span>Выполнено</span><b>${hours(plan.done)}</b></div>
          <div class="hero-bar"><span style="width:${donePct}%"></span></div>
          <small>${busyWorkers} рабочих занято · ${workingMachines} из ${data.machines.length} станков</small>
        </div>
      </div>
    </div>
  </section>

  <div class="stats-grid">
    <div class="stat"><div class="stat-top"><span class="stat-label">В работе</span><span class="stat-icon">${icon('machine')}</span></div><div class="stat-value">${inWork.length}<small>задач</small></div><div class="stat-foot"><span class="trend-up">${icon('arrowDown', 'ic-sm')} ${active.length - inWork.length}</span> ещё в плане</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">План смены</span><span class="stat-icon teal">${icon('clock')}</span></div><div class="stat-value">${nf1.format(plan.plan)}<small>н/ч</small></div><div class="stat-foot">${active.length} задач в очереди</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Заработано</span><span class="stat-icon">${icon('coin')}</span></div><div class="stat-value">${nf0.format(Math.round(plan.earned))}<small>BYN</small></div><div class="stat-foot">по фактически закрытым операциям</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Нужна помощь</span><span class="stat-icon red">${icon('alert')}</span></div><div class="stat-value">${blocked.length}<small>задач</small></div><div class="stat-foot">${blocked.length ? 'есть вопросы от рабочих' : 'вопросов нет'}</div></div>
  </div>

  <div class="dash-grid">
    <div class="stack">
      ${attention ? `<section class="card card-pad"><div class="section-head"><div><h2>Требуют решения</h2><p>Задачи, которые рабочие отметили как проблемные</p></div><a class="section-link" href="#/tasks" data-nav="tasks">Все задачи ${icon('arrow', 'ic-sm')}</a></div><div class="attention-list">${attention}</div></section>` : ''}
      <section class="card" style="overflow:hidden">
        <div class="section-head" style="padding:17px 16px 0;margin-bottom:8px"><div><h2>Задачи смены</h2><p>Приоритет, станок и фактический прогресс</p></div><a class="section-link" href="#/tasks" data-nav="tasks">Все ${active.length} ${icon('arrow', 'ic-sm')}</a></div>
        ${taskListHTML(shiftTasks, { emptyTitle: 'Активных задач нет', emptyText: 'Смена закрыта. Новые задачи появятся здесь.' })}
      </section>
    </div>
    <div class="stack">
      <section class="card card-pad"><div class="section-head"><div><h2>Загрузка станков</h2><p>Нормо-часы активных задач</p></div><a class="section-link" href="#/machines" data-nav="machines">Все ${icon('arrow', 'ic-sm')}</a></div>${loadRows || '<div class="machine-empty">Нет данных</div>'}</section>
      <section class="card card-pad"><div class="section-head"><div><h2>Последние перемещения</h2><p>Кто, когда и почему</p></div><a class="section-link" href="#/history" data-nav="history">История ${icon('arrow', 'ic-sm')}</a></div><div class="task-timeline">${recent || '<div class="machine-empty">Перемещений пока не было</div>'}</div></section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------------- */
/* Tasks                                                                     */
/* ------------------------------------------------------------------------- */

function filteredTasks() {
  let list = [...state.data.tasks];
  const f = state.taskFilter;
  if (f === 'active') list = list.filter((t) => t.status !== 'done');
  else if (f !== 'all') list = list.filter((t) => t.status === f);
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => [t.title, t.article, t.machine && t.machine.name, t.machine && t.machine.model, t.worker && t.worker.name, t.note].join(' ').toLowerCase().includes(q));
  }
  return list.sort((a, b) => (a.status === 'done') - (b.status === 'done') || a.priority - b.priority);
}

function taskFilterCounts() {
  const tasks = state.data.tasks;
  return {
    all: tasks.length,
    active: tasks.filter((t) => t.status !== 'done').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };
}

function filterBarHTML() {
  const c = taskFilterCounts();
  const chips = [
    ['active', 'Активные'], ['all', 'Все'], ['in_progress', 'В работе'], ['blocked', 'Нужна помощь'], ['done', 'Готовые'],
  ];
  return `
    <div class="filter-card card">
      <div class="search-wrap">${icon('search')}<input class="search-input" id="task-search" type="search" placeholder="Поиск по детали, станку или рабочему" value="${esc(state.search)}" autocomplete="off"></div>
      <div class="chip-row">${chips.map(([id, label]) => `<button class="chip ${state.taskFilter === id ? 'active' : ''}" type="button" data-filter="${id}">${label}<span class="n">${c[id]}</span></button>`).join('')}<span class="list-count" id="list-count">${filteredTasks().length} задач</span></div>
    </div>`;
}

function renderTasks() {
  const c = taskFilterCounts();
  return `
  ${pageHead('<span class="sep"></span> Всего ' + c.all + ' задач', 'Задачи цеха', 'Единый список для мастера и директора. Рабочий видит свои задачи в личном разделе.', `<button class="btn btn-primary" type="button" data-action="open-create">${icon('plus')} Поставить задачу</button>`)}
  ${filterBarHTML()}
  <section class="card" style="overflow:hidden"><div id="task-list">${taskListHTML(filteredTasks(), { emptyTitle: 'Ничего не найдено', emptyText: 'Измените фильтр или поисковый запрос.' })}</div></section>`;
}

function updateTaskList() {
  const list = $('#task-list');
  if (!list) return;
  const tasks = filteredTasks();
  list.innerHTML = taskListHTML(tasks, { emptyTitle: 'Ничего не найдено', emptyText: 'Измените фильтр или поисковый запрос.' });
  const count = $('#list-count');
  if (count) count.textContent = `${tasks.length} задач`;
  $$('.chip[data-filter]').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === state.taskFilter));
}

/* ------------------------------------------------------------------------- */
/* My tasks                                                                  */
/* ------------------------------------------------------------------------- */

function renderMy() {
  const data = state.data;
  const me = data.user;
  const mine = data.tasks.filter((t) => t.worker && t.worker.id === me.id);
  const active = mine.filter((t) => t.status !== 'done');
  const blocked = active.filter((t) => t.status === 'blocked');
  const inWork = active.filter((t) => t.status === 'in_progress');
  const done = mine.filter((t) => t.status === 'done');
  const t = totals(mine);
  const pctDone = t.plan ? Math.round(t.done / t.plan * 100) : 0;
  const firstName = me.name.split(' ')[0];
  const attention = blocked.length ? `<div class="attention-item" style="margin-bottom:12px" data-open-task="${esc(blocked[0].id)}" role="button" tabindex="0"><div class="attention-icon">${icon('alert', 'ic-sm')}</div><div style="min-width:0"><div class="attention-title">${esc(blocked[0].title)} · нужна помощь</div><div class="attention-sub">${esc(blocked[0].note || 'Сообщите мастеру о проблеме')}</div></div><span class="attention-cta">Открыть</span></div>` : '';
  return `
  ${pageHead(`${esc(dateLong(data.server_time))} <span class="sep"></span> Моя смена`, `Привет, ${esc(firstName)}`, `${mine.length} задач закреплено за вами. Прогресс и перемещения сохраняются на сервере.`, '')}
  <section class="shift-hero">
    <div class="hero-layout">
      <div>
        <span class="hero-pill"><span class="server-dot"></span> ${esc(me.position)} · смена 08:00–20:00</span>
        <h2 class="hero-title">${active.length ? `У вас <span>${active.length} ${active.length === 1 ? 'активная задача' : 'активные задачи'}</span>` : 'Все задачи закрыты'}</h2>
        <p class="hero-sub">${blocked.length ? `${blocked.length} задача ждёт решения мастера.` : 'Можно продолжать работу или переставить задачу на другой станок.'}</p>
        <div class="hero-metrics">
          <div class="hero-metric"><b>${money(t.earned)}</b><span>заработано</span></div>
          <div class="hero-metric"><b>${hours(t.plan)}</b><span>нормо-часов</span></div>
          <div class="hero-metric"><b>${inWork.length}</b><span>в работе</span></div>
        </div>
      </div>
      <div class="hero-right"><div class="donut" style="--p:${pctDone}"><div class="donut-inner"><b>${pctDone}%</b><span>выполнено</span></div></div></div>
    </div>
  </section>
  <div class="stats-grid">
    <div class="stat"><div class="stat-top"><span class="stat-label">Мои задачи</span><span class="stat-icon">${icon('list')}</span></div><div class="stat-value">${active.length}<small>активных</small></div><div class="stat-foot">${done.length} закрыто</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">В работе</span><span class="stat-icon teal">${icon('machine')}</span></div><div class="stat-value">${inWork.length}<small>задач</small></div><div class="stat-foot">${blocked.length ? `${blocked.length} с проблемой` : 'без проблем'}</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Сделано</span><span class="stat-icon amber">${icon('check')}</span></div><div class="stat-value">${Math.round(t.done)}<small>н/ч</small></div><div class="stat-foot">${pctDone}% личного плана</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Ставка</span><span class="stat-icon">${icon('coin')}</span></div><div class="stat-value">${num(data.rate_byn)}<small>BYN</small></div><div class="stat-foot">за нормо-час</div></div>
  </div>
  ${attention}
  <section class="card" style="overflow:hidden">
    <div class="section-head" style="padding:17px 16px 0;margin-bottom:8px"><div><h2>Мои задачи</h2><p>Нажмите на задачу, чтобы открыть прогресс и историю</p></div></div>
    ${taskListHTML(active, { showMove: true, emptyTitle: 'Активных задач нет', emptyText: 'Мастер ещё не поставил вам задачи на смену.' })}
  </section>`;
}

/* ------------------------------------------------------------------------- */
/* Machines                                                                  */
/* ------------------------------------------------------------------------- */

function machineIconClass(group) {
  return group === 'turn' ? 'turn' : group === 'edm' ? 'edm' : group === 'bench' ? 'bench' : '';
}

function machineCard(m) {
  const tasks = state.data.tasks.filter((t) => t.status !== 'done' && t.machine && t.machine.id === m.id);
  const h = tasks.reduce((s, t) => s + Number(t.norm_hours || 0), 0);
  const load = Math.min(100, Math.round(h / 22 * 100));
  const loadCls = m.status === 'repair' ? 'idle' : load > 85 ? 'hot' : load > 65 ? 'warn' : '';
  const taskLines = tasks.slice(0, 2).map((t) => `<div class="machine-task" data-open-task="${esc(t.id)}" role="button" tabindex="0"><b>${esc(t.title)}</b><span>${esc(t.worker ? t.worker.short : '')} · ${t.kind === 'general' ? hours(t.norm_hours) : `${num(t.done_qty)}/${num(t.qty)}`}</span></div>`).join('');
  const statusEditor = state.user.is_manager
    ? `<select class="status-select" data-action="machine-status" data-machine="${esc(m.id)}" aria-label="Статус станка ${esc(m.name)}">${Object.entries(state.data.machine_status_labels).map(([k, v]) => `<option value="${k}" ${m.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
    : `<span style="font-size:10px;color:var(--muted)">обновляется сервером</span>`;
  return `
  <article class="machine-card">
    <div class="machine-head"><div class="machine-icon ${machineIconClass(m.group)}">${icon('machine')}</div><div style="min-width:0"><h3 class="machine-name">${esc(m.name)}</h3><p class="machine-model">${esc(m.model)}</p></div>${badge(m.status, m.status_label)}</div>
    <div class="machine-spec">${esc(m.spec)}</div>
    <div class="machine-stat-line"><span>${tasks.length} задач · ${hours(h)}</span><b>${load}% загрузки</b></div>
    <div class="load-track"><span class="${loadCls}" style="width:${load}%"></span></div>
    <div class="machine-tasks">${taskLines || '<div class="machine-empty">Нет активных задач</div>'}</div>
    <div class="machine-foot"><span style="font-size:10px;color:var(--muted-2)">${m.status === 'repair' ? 'Перемещение сюда недоступно' : 'Можно ставить задачи'}</span>${statusEditor}</div>
  </article>`;
}

function renderMachines() {
  const data = state.data;
  const counts = {};
  data.machines.forEach((m) => { counts[m.status] = (counts[m.status] || 0) + 1; });
  return `
  ${pageHead('<span class="sep"></span> ' + data.machines.length + ' единиц', 'Оборудование', 'Загрузка считается по нормо-часам активных задач. Рабочий может переставить свою задачу на свободный станок.', '')}
  <div class="stats-grid">
    <div class="stat"><div class="stat-top"><span class="stat-label">Работают</span><span class="stat-icon teal">${icon('machine')}</span></div><div class="stat-value">${counts.working || 0}<small>станков</small></div><div class="stat-foot">активные задачи</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Наладка</span><span class="stat-icon amber">${icon('wrench')}</span></div><div class="stat-value">${counts.setup || 0}<small>станков</small></div><div class="stat-foot">подготовка оснастки</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">Свободны</span><span class="stat-icon">${icon('check')}</span></div><div class="stat-value">${counts.free || 0}<small>станков</small></div><div class="stat-foot">можно ставить задачу</div></div>
    <div class="stat"><div class="stat-top"><span class="stat-label">В ремонте</span><span class="stat-icon red">${icon('alert')}</span></div><div class="stat-value">${counts.repair || 0}<small>станков</small></div><div class="stat-foot">перемещение закрыто</div></div>
  </div>
  <div class="machine-grid">${data.machines.map(machineCard).join('')}</div>`;
}

/* ------------------------------------------------------------------------- */
/* People                                                                    */
/* ------------------------------------------------------------------------- */

function personCard(u) {
  const tasks = state.data.tasks.filter((t) => t.worker && t.worker.id === u.id);
  const active = tasks.filter((t) => t.status !== 'done');
  const h = active.reduce((s, t) => s + Number(t.norm_hours || 0), 0);
  const earned = tasks.reduce((s, t) => s + Number(t.earned_byn || 0), 0);
  const load = Math.min(100, Math.round(h / 22 * 100));
  return `
  <article class="person-card">
    <div class="person-top">${avatar(u, 'avatar-lg')}<div style="min-width:0"><div class="person-name">${esc(u.name)}</div><div class="person-pos">${esc(u.position)}</div></div><span class="person-role ${u.is_manager ? 'manager' : ''}">${esc(u.is_manager ? (u.role === 'director' ? 'директор' : 'мастер') : 'рабочий')}</span></div>
    <div class="person-stats"><div class="person-stat"><b>${active.length}</b><span>задач</span></div><div class="person-stat"><b>${nf1.format(h)}</b><span>н/ч</span></div><div class="person-stat"><b>${nf0.format(Math.round(earned))}</b><span>BYN</span></div></div>
    <div class="person-bar"><span style="width:${load}%"></span></div>
  </article>`;
}

function renderPeople() {
  const data = state.data;
  const managers = data.staff.filter((u) => u.is_manager);
  const workers = data.staff.filter((u) => !u.is_manager);
  return `
  ${pageHead('<span class="sep"></span> ' + data.staff.length + ' человек', 'Команда цеха', 'Директор и мастер равноправны: оба видят и меняют всё. Рабочие работают со своими задачами.', '')}
  <div class="info-strip" style="margin-bottom:16px">${icon('lock')}<div><b>Одинаковые права руководителей</b><span>Директор и мастер могут ставить задачи, менять исполнителя, статус станка, перемещать любые задачи и смотреть историю.</span></div></div>
  <div class="section-head"><div><h2>Руководство</h2><p>Полный доступ к смене</p></div></div>
  <div class="people-grid" style="margin-bottom:22px">${managers.map(personCard).join('')}</div>
  <div class="section-head"><div><h2>Рабочие</h2><p>Личные задачи и перемещения</p></div></div>
  <div class="people-grid">${workers.map(personCard).join('')}</div>`;
}

/* ------------------------------------------------------------------------- */
/* History                                                                   */
/* ------------------------------------------------------------------------- */

function movementItem(m) {
  const from = m.from_machine;
  const reasonCls = (m.reason === 'other' || !from) ? 'other' : '';
  const reason = !from ? 'Создание задачи' : m.reason_label;
  return `
  <div class="move-item">
    <div class="move-avatar">${m.moved_by ? avatar(m.moved_by, 'avatar-sm') : ''}</div>
    <div class="move-content">
      <div class="move-text"><b>${esc(m.moved_by ? m.moved_by.name : 'Система')}</b> ${from ? 'переместил' : 'разместил'} задачу <button class="link-btn task-link" type="button" data-open-task="${esc(m.task_id)}">«${esc(m.task_title)}»</button> ${from ? '' : 'на станок'}${from ? '' : ` <b>${esc(m.to_machine ? m.to_machine.name : '')}</b>`}</div>
      <div class="move-route">
        ${from ? `<span class="machine-chip">${icon('machine')} ${esc(from.name)} <em>${esc(from.model)}</em></span><span class="route-arrow">${icon('arrow')}</span>` : ''}
        ${m.to_machine ? `<span class="machine-chip">${icon('machine')} ${esc(m.to_machine.name)} <em>${esc(m.to_machine.model)}</em></span>` : '<span class="machine-chip">—</span>'}
        ${m.task_article ? `<span class="article">${esc(m.task_article)}</span>` : ''}
      </div>
      ${m.comment ? `<div class="move-comment">${esc(m.comment)}</div>` : ''}
      <div class="move-meta"><span class="reason-tag ${reasonCls}">${esc(reason)}</span><span>${whenLabel(m.created_at)}</span><span>·</span><span>${esc(m.moved_by ? m.moved_by.position : '')}</span></div>
    </div>
  </div>`;
}

function filteredMovements() {
  let list = state.data.movements;
  if (state.historyMachine !== 'all') list = list.filter((m) => (m.to_machine && m.to_machine.id === state.historyMachine) || (m.from_machine && m.from_machine.id === state.historyMachine));
  if (state.historyReason !== 'all') {
    list = list.filter((m) => state.historyReason === 'new' ? !m.from_machine : m.reason === state.historyReason);
  }
  return list;
}

function renderHistory() {
  const data = state.data;
  const all = data.movements;
  const today = all.filter((m) => {
    const d = parseDate(m.created_at);
    return d && startOfDay(d) === startOfDay(new Date());
  }).length;
  const unique = new Set(all.map((m) => m.task_id)).size;
  const moves = filteredMovements();
  const reasons = [{ id: 'all', label: 'Все причины' }, ...data.move_reasons, { id: 'new', label: 'Создание' }];
  return `
  ${pageHead('<span class="sep"></span> журнал сервера', 'История перемещений', 'Каждая перестановка фиксируется навсегда: кто, когда, откуда, куда и почему.', state.user.is_manager ? `<a class="btn btn-ghost" href="/api/movements.csv">${icon('download')} CSV</a>` : '')}
  <div class="history-stats"><div class="history-stat"><b>${all.length}</b><span>записей</span></div><div class="history-stat"><b>${today}</b><span>сегодня</span></div><div class="history-stat"><b>${unique}</b><span>задач в журнале</span></div></div>
  <div class="filter-card card">
    <div class="chip-row">${reasons.map((r) => `<button class="chip ${state.historyReason === r.id ? 'active' : ''}" type="button" data-history-reason="${esc(r.id)}">${esc(r.label)}</button>`).join('')}</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><select class="form-select" style="max-width:280px;height:36px" data-action="history-machine" aria-label="Фильтр по станку"><option value="all">Все станки</option>${data.machines.map((m) => `<option value="${esc(m.id)}" ${state.historyMachine === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select><span class="list-count">${moves.length} записей</span></div>
  </div>
  <section class="card" style="overflow:hidden" id="history-list">${moves.length ? moves.map(movementItem).join('') : '<div class="empty"><div class="empty-icon">' + icon('history', 'ic-lg') + '</div><b>Записей нет</b><p>Измените фильтр или переместите задачу.</p></div>'}</section>`;
}

function updateHistoryList() {
  const box = $('#history-list');
  if (!box) return;
  const moves = filteredMovements();
  box.innerHTML = moves.length ? moves.map(movementItem).join('') : `<div class="empty"><div class="empty-icon">${icon('history', 'ic-lg')}</div><b>Записей нет</b><p>Измените фильтр или переместите задачу.</p></div>`;
  const count = box.parentElement.querySelector('.list-count');
  if (count) count.textContent = `${moves.length} записей`;
  $$('.chip[data-history-reason]').forEach((chip) => chip.classList.toggle('active', chip.dataset.historyReason === state.historyReason));
}

/* ------------------------------------------------------------------------- */
/* Task sheet                                                                */
/* ------------------------------------------------------------------------- */

function taskHistory(taskId) {
  return state.data.movements.filter((m) => m.task_id === taskId);
}

function taskSheetHTML(task) {
  const isManager = state.user.is_manager;
  const isOwner = task.worker && task.worker.id === state.user.id;
  const canEdit = isManager || isOwner;
  const isGeneral = task.kind === 'general';
  const p = Math.round(Number(task.progress || 0) * 100);
  const moves = taskHistory(task.id);
  const workers = state.data.staff.filter((u) => u.role === 'worker');

  const subtasks = task.subtasks.length ? `<div class="sheet-section"><div class="sheet-section-title">Подзадачи <span>${task.subtasks.filter((s) => s.done).length} из ${task.subtasks.length}</span></div><div class="subtask-list">${task.subtasks.map((s) => `<button type="button" class="subtask ${s.done ? 'done' : ''}" data-action="toggle-subtask" data-task="${esc(task.id)}" data-subtask="${esc(s.id)}" ${canEdit ? '' : 'disabled'}><span class="subtask-check">${s.done ? icon('check') : ''}</span><span class="subtask-title">${esc(s.title)}</span></button>`).join('')}</div></div>` : '';

  const progressControls = canEdit ? (isGeneral ? `
    <div class="stepper-row"><button class="btn ${task.status === 'done' ? 'btn-ghost' : 'btn-primary'}" type="button" data-action="general-toggle" data-task="${esc(task.id)}">${icon(task.status === 'done' ? 'refresh' : 'check')} ${task.status === 'done' ? 'Вернуть в работу' : 'Отметить выполненной'}</button></div>` : `
    <div class="stepper-row">
      <button class="stepper-btn" type="button" data-action="progress-delta" data-task="${esc(task.id)}" data-delta="-1" aria-label="Минус одна деталь">−1</button>
      <input class="qty-input" id="done-input" type="number" min="0" max="${esc(task.qty)}" value="${esc(task.done_qty)}" aria-label="Сделано штук">
      <button class="stepper-btn" type="button" data-action="progress-delta" data-task="${esc(task.id)}" data-delta="1">+1</button>
      <button class="stepper-btn" type="button" data-action="progress-delta" data-task="${esc(task.id)}" data-delta="5">+5</button>
      <button class="btn btn-primary save-progress" type="button" data-action="save-progress" data-task="${esc(task.id)}">${icon('check', 'ic-sm')} Сохранить</button>
    </div>`) : '';

  const settings = isManager ? `
    <details class="settings-box">
      <summary>${icon('settings', 'ic-sm')} Параметры задачи <span>исполнитель, приоритет, срок</span></summary>
      <div class="form-grid" style="margin-top:11px">
        <label class="form-field"><span class="form-label">Исполнитель</span><select class="form-select" id="task-worker">${workers.map((w) => `<option value="${esc(w.id)}" ${task.worker && task.worker.id === w.id ? 'selected' : ''}>${esc(w.name)} · ${esc(w.position)}</option>`).join('')}</select></label>
        <label class="form-field"><span class="form-label">Приоритет</span><select class="form-select" id="task-priority"><option value="1" ${task.priority === 1 ? 'selected' : ''}>P1 — срочно</option><option value="2" ${task.priority === 2 ? 'selected' : ''}>P2 — обычный</option><option value="3" ${task.priority === 3 ? 'selected' : ''}>P3 — низкий</option></select></label>
        <label class="form-field"><span class="form-label">Срок / подпись</span><input class="form-input" id="task-due" value="${esc(task.due_label)}" maxlength="40"></label>
        <label class="form-field"><span class="form-label">Комментарий</span><input class="form-input" id="task-note" value="${esc(task.note)}" maxlength="1000" placeholder="Например: нужна проверка ОТК"></label>
        <div class="form-field full"><button class="btn btn-dark" type="button" data-action="save-settings" data-task="${esc(task.id)}">${icon('check', 'ic-sm')} Сохранить параметры</button></div>
      </div>
    </details>` : '';

  return `
  <div class="overlay" data-overlay="task">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title">
      <div class="sheet-head">
        <button class="icon-btn sheet-close" type="button" data-close aria-label="Закрыть">${icon('close')}</button>
        <div class="sheet-eyebrow">Задача · P${task.priority} · ${esc(task.status_label)}</div>
        <h2 id="task-sheet-title">${esc(task.title)} ${task.article ? `<span class="article">${esc(task.article)}</span>` : ''}</h2>
        <div>${statusBadge(task)} <span style="font-size:10.5px;color:var(--muted);margin-left:5px">${esc(task.kind === 'general' ? 'общая задача' : `норма ${nf1.format(task.norm_min)} мин/шт`)}</span></div>
      </div>
      <div class="sheet-body">
        <div class="progress-hero">
          <div class="progress-hero-top"><div class="big">${isGeneral ? nf1.format(task.norm_hours) : `${num(task.done_qty)} <small>из ${num(task.qty)} ${esc(task.unit)}</small>`}</div><span class="pct">${isGeneral ? (task.status === 'done' ? 'выполнено' : 'в плане') : `${p}%`}</span></div>
          <div class="big-progress"><span style="width:${isGeneral ? (task.status === 'done' ? 100 : 0) : p}%"></span></div>
          <div class="progress-caption"><span>${isGeneral ? hours(task.norm_hours) : `Сделано ${num(task.done_qty)} из ${num(task.qty)}`}</span><b>${money(task.earned_byn)}</b></div>
        </div>
        <div class="meta-grid">
          <div class="meta-box"><div class="meta-label">${icon('machine')} Станок</div><div class="meta-value">${esc(task.machine ? task.machine.name : '—')}<small>${esc(task.machine ? `${task.machine.model} · ${task.machine.status_label}` : '')}</small></div></div>
          <div class="meta-box"><div class="meta-label">${icon('user')} Исполнитель</div><div class="meta-value">${esc(task.worker ? task.worker.name : '—')}<small>${esc(task.worker ? task.worker.position : '')}</small></div></div>
          <div class="meta-box"><div class="meta-label">${icon('clock')} Срок</div><div class="meta-value">${esc(task.due_label || '—')}<small>${esc(task.kind === 'general' ? 'фиксированное время' : `норма ${nf1.format(task.norm_min)} мин / шт`)}</small></div></div>
          <div class="meta-box"><div class="meta-label">${icon('history')} Перемещений</div><div class="meta-value">${moves.filter((m) => m.from_machine).length}<small>записей в истории</small></div></div>
        </div>
        ${task.note ? `<div class="note-box">${esc(task.note)}</div>` : ''}
        <div class="sheet-section"><div class="sheet-section-title">${canEdit ? 'Отметить выработку' : 'Выработка'} <span>${canEdit ? 'сохраняется на сервере' : 'редактирует исполнитель'}</span></div>${progressControls}${!canEdit ? '<div class="form-hint" style="margin-top:7px">Вы можете смотреть задачу и историю, но менять выработку может только исполнитель или руководитель.</div>' : ''}</div>
        ${subtasks}
        <div class="sheet-section">
          <div class="move-cta"><div class="move-cta-icon">${icon('move')}</div><div><b>Переместить на другой станок</b><p>Рабочий может переставить свою задачу. Причина и автор сохранятся в журнале.</p></div><button class="btn btn-soft" type="button" data-action="move" data-task="${esc(task.id)}" ${task.status === 'done' ? 'disabled' : ''}>Переместить</button></div>
        </div>
        <div class="sheet-section"><div class="sheet-section-title">История перемещений <span>${moves.length} записей</span></div><div class="task-timeline">${moves.length ? moves.map((m) => `<div class="task-move"><div class="task-move-dot">${icon(m.from_machine ? 'move' : 'plus')}</div><div class="task-move-body"><b>${m.from_machine ? `${esc(m.from_machine.model)} → ${esc(m.to_machine.model)}` : `Создана на ${esc(m.to_machine.model)}`}</b><p>${esc(m.moved_by ? m.moved_by.name : 'Система')} · ${esc(!m.from_machine ? 'создание задачи' : m.reason_label)}${m.comment ? ` · ${esc(m.comment)}` : ''}</p><small>${whenLabel(m.created_at)}</small></div></div>`).join('') : '<div class="machine-empty">Записей пока нет</div>'}</div></div>
        ${settings}
      </div>
    </div>
  </div>`;
}

function openTask(id) {
  const task = taskById(id);
  if (!task) return;
  state.taskId = id;
  const root = $('#modal-root');
  const existing = root.querySelector('[data-overlay="task"]');
  if (existing) existing.remove();
  root.insertAdjacentHTML('beforeend', taskSheetHTML(task));
  lockBody();
  const close = root.querySelector('[data-overlay="task"] .sheet-close');
  if (close) setTimeout(() => close.focus(), 40);
}

/* ------------------------------------------------------------------------- */
/* Move sheet                                                                */
/* ------------------------------------------------------------------------- */

function openMove(id) {
  const task = taskById(id);
  if (!task) return;
  const machines = state.data.machines;
  const targets = machines.map((m) => {
    const current = m.id === task.machine.id;
    const disabled = current || m.status === 'repair';
    const why = current ? 'Текущий станок' : m.status === 'repair' ? 'На ремонте — недоступен' : `${m.model} · ${m.status_label}`;
    return `<label class="target-option"><input type="radio" name="target" value="${esc(m.id)}" ${disabled ? 'disabled' : ''}><span class="target-card"><b>${esc(m.name)}</b><span>${esc(why)}</span>${badge(m.status, m.status_label)}</span></label>`;
  }).join('');
  const reasons = state.data.move_reasons.map((r) => `<label class="reason-option"><input type="radio" name="reason" value="${esc(r.id)}"><span>${esc(r.label)}</span></label>`).join('');
  const html = `
  <div class="overlay move-layer" data-overlay="move">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="move-title">
      <div class="sheet-head"><button class="icon-btn sheet-close" type="button" data-close aria-label="Закрыть">${icon('close')}</button><div class="sheet-eyebrow">Перемещение · ${esc(task.article || task.title)}</div><h2 id="move-title">Куда переместить?</h2><div style="font-size:11.5px;color:var(--muted)">Задача «${esc(task.title)}» останется за исполнителем ${esc(task.worker ? task.worker.name : '')}.</div></div>
      <form id="move-form" data-task="${esc(task.id)}">
        <div class="sheet-body">
          <div class="current-machine"><div class="machine-icon ${machineIconClass(task.machine.group)}">${icon('machine')}</div><div><b>Сейчас: ${esc(task.machine.name)}</b><span>${esc(task.machine.model)} · ${esc(task.machine.status_label)}</span></div>${badge(task.machine.status, task.machine.status_label)}</div>
          <div class="sheet-section-title" style="margin-top:0">Новый станок</div>
          <div class="target-grid">${targets}</div>
          <div class="sheet-section-title" style="margin-top:17px">Причина перемещения</div>
          <div class="reason-grid">${reasons}</div>
          <div class="sheet-section" style="margin-top:14px"><label class="form-label" for="move-comment">Комментарий <span style="font-weight:500;color:var(--muted-2)">необязательно</span></label><textarea class="form-textarea" id="move-comment" maxlength="500" placeholder="Например: на VMC650 закончилась оснастка"></textarea></div>
          <div class="move-warning">${icon('history')}<span>В журнал попадёт: кто переместил, время, старый и новый станок, причина и комментарий. Запись нельзя удалить.</span></div>
          <div class="form-error" id="move-error"></div>
        </div>
        <div class="sheet-foot"><button class="btn btn-ghost" type="button" data-close>Отмена</button><button class="btn btn-primary" id="move-submit" type="submit" disabled>${icon('move', 'ic-sm')} Переместить</button></div>
      </form>
    </div>
  </div>`;
  $('#modal-root').insertAdjacentHTML('beforeend', html);
  lockBody();
  const form = $('#move-form');
  form.addEventListener('change', () => {
    const target = form.querySelector('input[name="target"]:checked');
    const reason = form.querySelector('input[name="reason"]:checked');
    const btn = $('#move-submit');
    if (btn) btn.disabled = !(target && reason);
  });
  setTimeout(() => { const first = form.querySelector('input[name="target"]:not(:disabled)'); if (first) first.focus(); }, 60);
}

async function submitMove(form) {
  const taskId = form.dataset.task;
  const target = form.querySelector('input[name="target"]:checked');
  const reason = form.querySelector('input[name="reason"]:checked');
  const comment = $('#move-comment');
  const error = $('#move-error');
  if (!target || !reason) { if (error) error.textContent = 'Выберите станок и причину.'; return; }
  const btn = $('#move-submit');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Перемещаем…'; }
  try {
    const res = await api(`/api/tasks/${encodeURIComponent(taskId)}/move`, { method: 'POST', body: { to_machine_id: target.value, reason: reason.value, comment: comment ? comment.value : '' } });
    const to = res.movement && res.movement.to_machine ? res.movement.to_machine.model : '';
    closeAllOverlays();
    await loadData();
    render();
    showToast(`Задача перемещена${to ? ` на ${to}` : ''}. Запись добавлена в историю.`);
  } catch (err) {
    if (error) error.textContent = err.message;
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('move', 'ic-sm')} Переместить`; }
  }
}

/* ------------------------------------------------------------------------- */
/* Create task                                                               */
/* ------------------------------------------------------------------------- */

function openCreate() {
  const machines = state.data.machines.filter((m) => m.status !== 'repair');
  const workers = state.data.staff.filter((u) => u.role === 'worker');
  const html = `
  <div class="overlay" data-overlay="create">
    <div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div class="sheet-head"><button class="icon-btn sheet-close" type="button" data-close aria-label="Закрыть">${icon('close')}</button><div class="sheet-eyebrow">Новая задача</div><h2 id="create-title">Поставить задачу</h2><div style="font-size:11.5px;color:var(--muted)">Задача сразу появится у рабочего и на станке. Создание тоже попадёт в историю.</div></div>
      <form id="create-form">
        <div class="sheet-body">
          <div class="form-grid">
            <label class="form-field full"><span class="form-label">Название детали / работы *</span><input class="form-input" id="new-title" required maxlength="120" placeholder="Например: Втулка-04"></label>
            <label class="form-field"><span class="form-label">Артикул</span><input class="form-input" id="new-article" maxlength="40" placeholder="D-1042"></label>
            <label class="form-field"><span class="form-label">Количество, шт *</span><input class="form-input" id="new-qty" type="number" min="1" value="20" required></label>
            <label class="form-field"><span class="form-label">Норма, мин / шт *</span><input class="form-input" id="new-norm" type="number" min="0.1" step="0.1" value="10" required></label>
            <label class="form-field"><span class="form-label">Приоритет</span><select class="form-select" id="new-priority"><option value="1">P1 — срочно</option><option value="2" selected>P2 — обычный</option><option value="3">P3 — низкий</option></select></label>
            <label class="form-field"><span class="form-label">Станок *</span><select class="form-select" id="new-machine" required>${machines.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.model)}</option>`).join('')}</select></label>
            <label class="form-field"><span class="form-label">Исполнитель *</span><select class="form-select" id="new-worker" required>${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} · ${esc(w.position)}</option>`).join('')}</select></label>
            <label class="form-field full"><span class="form-label">Срок / подпись</span><input class="form-input" id="new-due" maxlength="40" value="К концу смены"></label>
            <label class="form-field full"><span class="form-label">Комментарий</span><textarea class="form-textarea" id="new-note" maxlength="1000" placeholder="Что важно знать исполнителю"></textarea></label>
          </div>
          <div class="form-error" id="create-error"></div>
        </div>
        <div class="sheet-foot"><button class="btn btn-ghost" type="button" data-close>Отмена</button><button class="btn btn-primary" type="submit" id="create-submit">${icon('plus', 'ic-sm')} Создать задачу</button></div>
      </form>
    </div>
  </div>`;
  $('#modal-root').insertAdjacentHTML('beforeend', html);
  lockBody();
  setTimeout(() => { const el = $('#new-title'); if (el) el.focus(); }, 60);
}

async function submitCreate(form) {
  const errBox = $('#create-error');
  const btn = $('#create-submit');
  const title = $('#new-title').value.trim();
  const qty = Number($('#new-qty').value);
  const norm = Number($('#new-norm').value);
  if (!title || !qty || qty < 1 || !norm || norm <= 0) {
    if (errBox) errBox.textContent = 'Заполните название, количество и норму времени.';
    return;
  }
  if (btn) { btn.disabled = true; btn.innerHTML = 'Создаём…'; }
  try {
    const task = await api('/api/tasks', { method: 'POST', body: {
      title, article: $('#new-article').value.trim(), qty, norm_min: norm,
      machine_id: $('#new-machine').value, worker_id: $('#new-worker').value,
      priority: Number($('#new-priority').value), due_label: $('#new-due').value.trim() || 'К концу смены',
      note: $('#new-note').value.trim(),
    } });
    closeTopOverlay();
    await loadData();
    render();
    openTask(task.id);
    showToast('Задача создана. Запись добавлена в историю.');
  } catch (err) {
    if (errBox) errBox.textContent = err.message;
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('plus', 'ic-sm')} Создать задачу`; }
  }
}

/* ------------------------------------------------------------------------- */
/* Task actions                                                              */
/* ------------------------------------------------------------------------- */

async function setProgress(taskId, value) {
  try {
    const task = taskById(taskId);
    if (!task) return;
    const done = Math.max(0, Math.min(Number(value) || 0, Number(task.qty)));
    const updated = await api(`/api/tasks/${encodeURIComponent(taskId)}/progress`, { method: 'POST', body: { done_qty: done } });
    await loadData();
    openTask(taskId);
    render();
    showToast(updated.status === 'done' ? 'Задача закрыта' : `Выработка обновлена: ${num(updated.done_qty)} из ${num(updated.qty)}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function saveProgress(taskId) {
  const input = $('#done-input');
  if (input) await setProgress(taskId, input.value);
}

async function toggleGeneral(taskId) {
  const task = taskById(taskId);
  if (!task) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/status`, { method: 'POST', body: { status: task.status === 'done' ? 'in_progress' : 'done' } });
    await loadData();
    openTask(taskId);
    render();
    showToast(task.status === 'done' ? 'Задача возвращена в работу' : 'Задача отмечена выполненной');
  } catch (err) { showToast(err.message, 'error'); }
}

async function toggleSubtask(taskId, subtaskId) {
  const btn = $(`.subtask[data-subtask="${CSS.escape(subtaskId)}"]`);
  if (btn) btn.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}`, { method: 'POST' });
    await loadData();
    openTask(taskId);
    render();
  } catch (err) { showToast(err.message, 'error'); }
}

async function saveSettings(taskId) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: {
      worker_id: $('#task-worker').value,
      priority: Number($('#task-priority').value),
      due_label: $('#task-due').value.trim(),
      note: $('#task-note').value.trim(),
    } });
    await loadData();
    openTask(taskId);
    render();
    showToast('Параметры задачи сохранены');
  } catch (err) { showToast(err.message, 'error'); }
}

/* ------------------------------------------------------------------------- */
/* Profile                                                                   */
/* ------------------------------------------------------------------------- */

function openProfile() {
  const u = state.user;
  const manager = u.is_manager;
  const html = `
  <div class="overlay" data-overlay="profile">
    <div class="sheet" style="max-width:460px" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <div class="sheet-head"><button class="icon-btn sheet-close" type="button" data-close aria-label="Закрыть">${icon('close')}</button><div class="sheet-eyebrow">Профиль</div><h2 id="profile-title">${esc(u.name)}</h2><div style="font-size:11.5px;color:var(--muted)">${esc(u.is_manager ? (u.role === 'director' ? 'Директор' : 'Мастер смены') : u.position)}</div></div>
      <div class="sheet-body">
        <div class="profile-hero">${avatar(u, 'avatar-lg')}<div><h2 style="font-size:16px">${esc(u.name)}</h2><p>${esc(u.position)} · ${esc(u.is_manager ? 'полный доступ' : 'свои задачи')}</p></div></div>
        <div class="profile-row"><span>Права</span><b>${u.is_manager ? 'как у директора' : 'рабочий'}</b></div>
        <div class="profile-row"><span>Сервер</span><b>${state.config.db === 'postgresql' ? 'PostgreSQL' : 'SQLite'} · онлайн</b></div>
        <div class="profile-row"><span>Ставка</span><b>${num(state.data.rate_byn)} BYN / н-ч</b></div>
        <div class="profile-row"><span>Версия</span><b>${esc(state.data.version)}</b></div>
        <div class="profile-actions">
          ${manager ? `<a class="btn btn-ghost btn-block" href="/api/movements.csv">${icon('download')} Скачать историю CSV</a><button class="btn btn-danger btn-block" type="button" data-action="reset">${icon('refresh')} Сбросить демо-данные</button>` : ''}
          <button class="btn btn-dark btn-block" type="button" data-action="logout">${icon('logout')} Выйти</button>
        </div>
      </div>
    </div>
  </div>`;
  $('#modal-root').insertAdjacentHTML('beforeend', html);
  lockBody();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (err) { /* всё равно выходим */ }
  location.hash = '';
  showLogin('Вы вышли из системы.');
}

async function resetDemo() {
  if (!window.confirm('Сбросить все демо-данные? Задачи и история вернутся к исходному состоянию.')) return;
  try {
    await api('/api/admin/reset', { method: 'POST' });
    location.hash = '';
    showLogin('Демо-данные сброшены. Войдите снова.');
    showToast('Демо-данные сброшены');
  } catch (err) { showToast(err.message, 'error'); }
}

/* ------------------------------------------------------------------------- */
/* Events                                                                    */
/* ------------------------------------------------------------------------- */

document.addEventListener('click', async (event) => {
  const closeEl = event.target.closest('[data-close]');
  if (closeEl) { closeTopOverlay(); return; }

  const navEl = event.target.closest('[data-nav]');
  if (navEl) {
    event.preventDefault();
    navigate(navEl.dataset.nav);
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    const taskId = actionEl.dataset.task;
    if (action === 'profile') { openProfile(); return; }
    if (action === 'logout') { logout(); return; }
    if (action === 'reset') { resetDemo(); return; }
    if (action === 'demo-login') { event.preventDefault(); performLogin(actionEl.dataset.pin); return; }
    if (action === 'open-create') { openCreate(); return; }
    if (action === 'move') { if (taskId) openMove(taskId); return; }
    if (action === 'progress-delta') {
      const input = $('#done-input');
      if (input) {
        const delta = Number(actionEl.dataset.delta) || 0;
        input.value = Math.max(0, Math.min(Number(input.max) || 0, (Number(input.value) || 0) + delta));
      }
      return;
    }
    if (action === 'save-progress') { await saveProgress(taskId); return; }
    if (action === 'general-toggle') { await toggleGeneral(taskId); return; }
    if (action === 'toggle-subtask') { await toggleSubtask(taskId, actionEl.dataset.subtask); return; }
    if (action === 'save-settings') { await saveSettings(taskId); return; }
    if (action === 'machine-status') { return; }
  }

  const filterEl = event.target.closest('[data-filter]');
  if (filterEl) { state.taskFilter = filterEl.dataset.filter; render(); return; }

  const histReasonEl = event.target.closest('[data-history-reason]');
  if (histReasonEl) { state.historyReason = histReasonEl.dataset.historyReason; updateHistoryList(); return; }

  const taskEl = event.target.closest('[data-open-task]');
  if (taskEl) { openTask(taskEl.dataset.openTask); return; }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeTopOverlay(); return; }
  if (event.key === 'Enter' || event.key === ' ') {
    const row = event.target.closest('[data-open-task][role="button"]');
    if (row && !event.target.closest('button, a, input, select, textarea')) {
      event.preventDefault();
      openTask(row.dataset.openTask);
    }
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'task-search') {
    state.search = event.target.value;
    updateTaskList();
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target.closest('[data-action="machine-status"]');
  if (el) {
    const machineId = el.dataset.machine;
    try {
      await api(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'PATCH', body: { status: el.value } });
      await loadData();
      render();
      showToast('Статус станка обновлён');
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  const hist = event.target.closest('[data-action="history-machine"]');
  if (hist) { state.historyMachine = hist.value; updateHistoryList(); }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const pin = $('#pin-input');
    await performLogin(pin ? pin.value : '');
  } else if (event.target.id === 'create-form') {
    event.preventDefault();
    await submitCreate(event.target);
  } else if (event.target.id === 'move-form') {
    event.preventDefault();
    await submitMove(event.target);
  }
});

window.addEventListener('hashchange', () => {
  if (state.user && state.data) render();
});

/* ------------------------------------------------------------------------- */
/* Boot                                                                      */
/* ------------------------------------------------------------------------- */

async function poll() {
  if (!state.user || !state.data || document.hidden) return;
  if ($$('.overlay').length) return;
  const ae = document.activeElement;
  if (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) return;
  try {
    await loadData();
    render();
  } catch (err) { /* тихо ждём следующий цикл */ }
}

async function init() {
  await loadConfig();
  await loadDemo();
  try {
    await loadData();
    ensureRoute();
    render();
  } catch (err) {
    showLogin(err.status === 0 ? 'Сервер не запущен. Запустите его и обновите страницу.' : '');
  }
  setInterval(poll, 12000);
}

init();
