/* Wetoes frontend (GitHub Pages build). No inline scripts (strict CSP). */
'use strict';

/* ========== API ========== */
// Static build: the "API" runs in the browser (engine.js). Same paths as the server version.
const api = (method, path, body) => window.WetoesEngine.api(method, path, body);
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');

const ERR_COPY = {
  invalid_email: 'that email doesn’t look right.',
  email_taken: 'you already have an account with this email. tap “i’ve been here” to sign in.',
  wrong_login: 'email or password is wrong.',
  too_many_tries: 'too many wrong tries. wait 15 minutes and try again.',
  password_short: 'password needs at least 6 characters.',
  password_long: 'that password is too long.',
  password_common: 'that password is too easy to guess. try another.',
  wrong_password: 'your current password is wrong.',
  empty_feedback: 'tap a rating or write a line first.',
  email_domain: 'that email domain can’t receive mail. typo?',
  slow_down: 'too fast. give it a minute.',
  llm_busy: 'the free AI is busy. try again in a few seconds.',
  bad_request: 'something in that didn’t look right.',
  nothing_to_undo: 'nothing to undo.',
  llm_unavailable: 'the writer is offline right now. try again soon.',
  llm_daily_limit: 'that’s today’s writing limit. back tomorrow.',
  nothing_to_pick: 'nothing fits that. try a different budget.',
  too_short: 'say a little more.',
  already_decided: 'already done.',
  too_late: 'too late to undo that one.',
};
const errCopy = (e) => (e && e.message === 'llm_busy' && e.wait ? 'the free AI is busy. try again in ~' + e.wait + 's.' : ERR_COPY[e && e.message] || 'something broke. try again.');

/* ========== STATE ========== */
const S = {
  me: null,                 // profile from /api/me
  ctx: { mood: null, budget: null, category: null, genre: null },
  cur: null,                // current pick or draft response
  lastVetoed: null,
  keptEvent: null,
  mem: null,                // /api/memory
  say: { to: 'ma', about: '', tone: 'warm', lang: 'english' },
  busy: false,
  authMode: 'new',          // 'new' | 'back'
  fb: { rating: null, sent: false },
};
let screen = 'welcome';
let screenTimer = null;

/* ========== HELPERS ========== */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clockStr() {
  const d = new Date();
  let h = d.getHours(); let m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12; m = m < 10 ? '0' + m : m;
  return h + ':' + m + ap;
}
const dayStr = () => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
const isNight = () => { const h = new Date().getHours(); return h >= 22 || h < 6; };
const checkNight = () => document.body.classList.toggle('dark', isNight());
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function toast(msg, ms) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || 3200);
}
const back = (a) => `<button class="backbtn" data-a="${a || 'nav-mood'}"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M8 2 L3 6 L8 10" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> back</button>`;
const wordmark = '<span class="wordmark">wetoes<span class="dot">.</span></span>';
const budgetLabel = (b) => ({ free: 'free', u100: '< ₹100', u300: '< ₹300', splurge: 'treat me' }[b] || '');
const openUrl = (u) => window.open(u, '_blank', 'noopener');

/* ========== NAV ========== */
function goto(name) {
  if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
  screen = name;
  document.getElementById('app').innerHTML = SCREENS[name]();
  window.scrollTo(0, 0);
  checkNight();
  const f = document.querySelector('[data-autofocus]');
  if (f) f.focus();
  if (AFTER[name]) AFTER[name]();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  e.preventDefault();
  handle(el.dataset.a, el.dataset.v, el).catch((err) => { console.error(err); toast(errCopy(err)); });
});
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const a = e.target.dataset.submit;
  if (a) handle(a, null, e.target).catch((err) => { console.error(err); toast(errCopy(err)); });
});

/** Run an async action once at a time, with a busy label on the clicked button. */
async function busy(el, label, fn) {
  if (S.busy) return;
  S.busy = true;
  const old = el && el.innerHTML;
  if (el && label) { el.innerHTML = `<span class="loading"><span class="spin"></span>${esc(label)}</span>`; el.disabled = true; }
  try { return await fn(); } finally {
    S.busy = false;
    if (el && document.body.contains(el)) { el.innerHTML = old; el.disabled = false; }
  }
}

async function handle(a, v, el) {
  switch (a) {
    case 'start-welcome': return goto('auth');
    case 'start-signin': return goto('auth');
    case 'submit-auth': return submitAuth(el);
    case 'set-diet': await saveProfile({ diet: v }); return goto(screen === 'settings' ? 'settings' : 'mood');
    case 'pick-mood': S.ctx.mood = v; return goto('context');
    case 'mood-text': return moodText(el);
    case 'pick-cat':
      S.ctx.category = v;
      if (v === 'listen') return goto('music');
      if (v === 'say') return goto('saycompose');
      return servePick(el);
    case 'pick-genre': S.ctx.genre = v; return servePick(el);
    case 'surprise-genre': S.ctx.genre = null; return servePick(el);
    case 'pick-budget': S.ctx.budget = S.ctx.budget === v ? null : v; return goto('context');
    case 'say-to': S.say.to = v; return rerenderSay();
    case 'say-tone': S.say.tone = v; return rerenderSay();
    case 'say-lang': S.say.lang = v; return rerenderSay();
    case 'say-write': return sayWrite(el);
    case 'cycle-tone': return vetoCurrent(el, nextTone());
    case 'veto': return vetoCurrent(el);
    case 'yes': return acceptCurrent(el);
    case 'start-over': clearCtx(); return goto('mood');
    case 'another-one': return anotherOne(el);
    case 'fb-rate': return rate(v);
    case 'fb-send': return sendFeedback(el, 'pick');
    case 'bye-send': return sendFeedback(el, 'session');
    case 'bye-skip': return signOut();
    case 'nav-feedback': S.fb = { rating: null, sent: false }; S.byeMode = 'feedback'; return goto('bye');
    case 'export': return exportData();
    case 'nav-hub': await loadMemory(); return goto('hub');
    case 'nav-trust': await loadMemory(); return goto('trust');
    case 'nav-mood': clearCtx(); return goto('mood');
    case 'nav-settings': return goto('settings');
    case 'back-context': return goto('context');
    case 'save-name': await saveProfile({ name: document.getElementById('name-input').value.trim() || null }); toast('saved.'); return goto('mood');
    case 'set-city': await saveProfile({ city: v }); return goto('settings');
    case 'open': return openUrl(v);
    case 'share': return sharePick();
    case 'copy-draft': return copyDraft();
    case 'logout': S.fb = { rating: null, sent: false }; S.byeMode = 'signout'; return goto('bye');
    case 'delete-account':
      if (confirm('delete your profile and all your history from this device? this cannot be undone.')) {
        await api('DELETE', '/api/me'); S.me = null; toast('deleted. everything is gone.'); goto('welcome');
      }
      return;
    case 'nav-welcome': return goto('welcome');
    case 'nav-privacy': S.privacyBack = screen; return goto('privacy');
    case 'privacy-back': return goto(S.privacyBack || 'welcome');
  }
}

function clearCtx() { S.ctx = { mood: null, budget: null, category: null, genre: null }; S.cur = null; S.lastVetoed = null; }

async function saveProfile(patch) { S.me = await api('PATCH', '/api/me', patch); }
async function loadMemory() { S.mem = await api('GET', '/api/memory'); }

async function submitAuth(form) {
  const email = form.querySelector('[name=email]').value;
  const name = form.querySelector('[name=name]').value;
  const errEl = form.querySelector('.err');
  errEl.textContent = '';
  try {
    const r = await busy(form.querySelector('button[type=submit]'), 'checking', () => api('POST', '/api/start', { email, name }));
    if (!r) return;
    S.me = r;
    if (!r.isNew) toast('welcome back' + (r.name ? ', ' + r.name : '') + '. your history is here.');
    goto(S.me.diet ? 'mood' : 'diet');
  } catch (e) { errEl.textContent = errCopy(e); }
}

function exportData() {
  api('GET', '/api/me/export').then((d) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    a.download = 'wetoes-my-data.json';
    document.body.appendChild(a); a.click(); a.remove();
  });
}

async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* already out */ }
  S.me = null; clearCtx();
  goto('welcome');
}

function rate(v) {
  S.fb.rating = v;
  document.querySelectorAll('[data-a="fb-rate"]').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  const more = document.getElementById('fb-more');
  if (more) more.hidden = false;
}

async function sendFeedback(el, kind) {
  const box = document.getElementById('fb-text');
  const comment = box ? box.value.trim() : '';
  const body = { kind, rating: S.fb.rating, comment };
  if (kind === 'pick' && S.keptEvent) body.event_id = S.keptEvent;
  if (!body.rating && !comment) {
    if (kind === 'session' && S.byeMode === 'signout') return signOut();
    return toast(errCopy({ message: 'empty_feedback' }));
  }
  await busy(el, 'sending', () => api('POST', '/api/feedback', body));
  S.fb.sent = true;
  if (kind === 'session') {
    toast('thank you. we read every one.');
    return S.byeMode === 'signout' ? signOut() : goto('mood');
  }
  const w = document.getElementById('fb-widget');
  if (w) w.innerHTML = '<div class="serif" style="font-size:18px">thank you — noted. ✦</div>';
}

async function moodText(form) {
  const input = form.querySelector('input');
  const text = input.value.trim();
  if (text.length < 2) return;
  const r = await busy(form.querySelector('button'), '', () => api('POST', '/api/mood/parse', { text }));
  if (!r) return;
  S.ctx.mood = r.mood;
  if (r.budget) S.ctx.budget = r.budget;
  if (r.echo) toast(r.echo + ' · reading it as “' + r.mood + '”');
  if (r.category === 'say') { S.ctx.category = 'say'; return goto('saycompose'); }
  if (r.category && r.category !== 'listen') { S.ctx.category = r.category; return servePick(null); }
  if (r.category === 'listen') { S.ctx.category = 'listen'; return goto('music'); }
  goto('context');
}

async function servePick(el) {
  const r = await busy(el, '', () => api('POST', '/api/pick', {
    category: S.ctx.category, mood: S.ctx.mood, budget: S.ctx.budget, genre: S.ctx.category === 'listen' ? S.ctx.genre : null,
  }));
  if (!r) return;
  S.cur = r; S.lastVetoed = null;
  goto('pick');
}

const TONES = ['warm', 'firm', 'clear', 'funny', 'professional', 'apologetic'];
function nextTone() { const t = (S.cur && S.cur.tone) || 'warm'; return TONES[(TONES.indexOf(t) + 1) % TONES.length]; }

async function vetoCurrent(el, tone) {
  if (!S.cur) return;
  const isSay = S.ctx.category === 'say';
  const prevTitle = isSay ? S.cur.text : S.cur.item.title;
  const r = await busy(el, isSay ? 'rewriting' : '', () => isSay
    ? api('POST', '/api/say/' + S.cur.event_id + '/veto', tone ? { tone } : {})
    : api('POST', '/api/events/' + S.cur.event_id + '/veto'));
  if (!r) return;
  S.cur = r; S.lastVetoed = prevTitle;
  goto('pick');
}

async function acceptCurrent(el) {
  if (!S.cur) return;
  const r = await busy(el, '', () => api('POST', '/api/events/' + S.cur.event_id + '/keep'));
  if (!r) return;
  S.keptEvent = S.cur.event_id;
  S.fb = { rating: null, sent: false };
  if (S.ctx.category === 'say') copyDraft(true);
  goto('yes');
}

/** "not this — show me another": take back the yes (if still possible) and get a fresh pick. */
async function anotherOne(el) {
  if (S.keptEvent) {
    try { await api('POST', '/api/events/' + S.keptEvent + '/undo'); } catch (_) { /* window passed: keep the yes, still show another */ }
    S.keptEvent = null;
  }
  if (S.ctx.category === 'say') return goto('saycompose');
  return servePick(el);
}

async function sayWrite(el) {
  const about = document.getElementById('say-about').value.trim();
  S.say.about = about;
  const errEl = document.getElementById('say-err');
  if (about.length < 2) { errEl.textContent = 'tell me what it’s about.'; return; }
  try {
    const r = await busy(el, 'writing…', () => api('POST', '/api/say', S.say));
    if (!r) return;
    S.cur = r; S.lastVetoed = null;
    goto('pick');
  } catch (e) { errEl.textContent = errCopy(e); }
}

function rerenderSay() {
  const t = document.getElementById('say-about');
  if (t) S.say.about = t.value;
  goto('saycompose');
}

function curTitle() {
  if (!S.cur) return '';
  return S.ctx.category === 'say' ? S.cur.text : S.cur.item.title;
}

async function copyDraft(silent) {
  if (!S.cur || !S.cur.text) return;
  try { await navigator.clipboard.writeText(S.cur.text); if (!silent) toast('copied.'); else toast('copied. paste it anywhere.'); } catch (_) { /* clipboard blocked */ }
}

async function sharePick() {
  const title = curTitle();
  const text = S.ctx.category === 'say' ? title : 'wetoes picked “' + title + '” for me. one pick, not ten.';
  if (navigator.share) { try { await navigator.share({ text, url: APP_URL }); } catch (_) { /* cancelled */ } return; }
  openUrl('https://wa.me/?text=' + encodeURIComponent(text + ' ' + APP_URL));
}

/* ========== SCREENS ========== */
const SCREENS = {};
const AFTER = {};

SCREENS.welcome = () => `
<div class="screen active" style="padding-top:28px">
  <div class="topbar">
    ${wordmark}
    <span class="topmeta">FREE &middot; NO DOWNLOAD</span>
  </div>
  <div class="blob" style="top:-70px;right:-90px;width:240px;height:240px;background:#E8B4A5;opacity:0.42"></div>
  <div class="blob" style="top:360px;left:-110px;width:220px;height:220px;background:#F2D97F;opacity:0.32"></div>
  <div style="position:relative;z-index:2;margin-top:40px">
    <div class="eyebrow red">§ YOUR MOOD, SORTED</div>
    <h1 class="hero" style="margin-top:14px;font-size:64px;line-height:0.92">tell us how<br>you <span class="red">feel.</span></h1>
    <p class="serif" style="font-size:24px;line-height:1.2;margin-top:14px">we&rsquo;ll hand you <u>one</u> thing for it.</p>
    <p class="muted" style="font-size:14px;line-height:1.55;margin-top:12px;max-width:320px">tired, wired, blah or glowing — wetoes reads your mood and picks what to eat, watch, listen to, do, wear, or even writes the text you&rsquo;ve been putting off. in english or hinglish. no scrolling through 50 options.</p>
  </div>
  <div class="howto mt-l">
    <div class="step"><span class="n">01</span><div><b>say how you feel</b><span>tap a mood, or type it in your own words.</span></div></div>
    <div class="step"><span class="n">02</span><div><b>get one pick</b><span>just one. picked for your mood, diet and budget.</span></div></div>
    <div class="step"><span class="n">03</span><div><b>keep it or <span class="red">veto</span> it</b><span>veto = show me another. every no teaches us your taste.</span></div></div>
  </div>
  <div class="sep"></div>
  <button class="cta mt-l" data-a="start-welcome" style="position:relative;z-index:2"><span>check my mood</span><span class="arrow">↗</span></button>
  <p class="hint" style="text-align:center">been here before? use the same email &mdash; your history is saved on this device.</p>
  <div class="footmeta">no ads &middot; no endless scrolling &middot; your taste is never sold &middot; <button class="linkbtn" data-a="nav-privacy">privacy</button></div>
</div>`;

SCREENS.auth = () => `
<div class="screen active">
  <div class="topbar">${back('nav-welcome')}${wordmark}<span class="topmeta">LET&rsquo;S GO</span></div>
  <h1 class="hero" style="margin-top:36px;font-size:56px">first, who&rsquo;s<br><span class="red">asking?</span></h1>
  <p class="muted" style="font-size:14px;margin-top:14px;line-height:1.55;max-width:310px">just your email &mdash; no password, no app to install. we use it to send the odd update and to bring your picks back when you return.</p>
  <form data-submit="submit-auth" class="mt-l" novalidate>
    <label class="eyebrow" for="em" style="display:block;margin-bottom:8px">§ EMAIL</label>
    <input id="em" class="field" type="email" name="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="you@gmail.com" data-autofocus required>
    <label class="eyebrow" for="nm" style="display:block;margin:18px 0 8px">§ WHAT SHOULD WE CALL YOU? <span class="muted">(OPTIONAL)</span></label>
    <input id="nm" class="field" type="text" name="name" autocomplete="given-name" maxlength="40" placeholder="first name">
    <div class="err"></div>
    <button class="cta mt-s" type="submit"><span>let&rsquo;s go</span><span class="arrow">↗</span></button>
  </form>
  <div class="sep"></div>
  <div class="footmeta">no spam &middot; never sold &middot; <button class="linkbtn" data-a="nav-privacy">privacy</button></div>
</div>`;

SCREENS.diet = () => {
  const opt = (v, letter, color, name, sub) => {
    const on = S.me && S.me.diet === v;
    return `<button data-a="set-diet" data-v="${v}" style="display:flex;justify-content:space-between;align-items:center;padding:20px 22px;border-radius:18px;${on ? 'background:#1A1613;color:#F5EDDF' : 'background:#FFFCF5;border:1px solid rgba(26,22,19,0.1);color:#1A1613'}">
      <div style="display:flex;align-items:center;gap:18px"><span class="serif" style="font-size:48px;color:${color};line-height:0.85">${letter}</span>
      <div><div class="serif" style="font-size:26px">${name}</div><div style="font-size:12px;opacity:0.7;margin-top:4px">${sub}</div></div></div>
      <div style="width:26px;height:26px;border-radius:50%;border:1.5px solid currentColor;opacity:0.3"></div></button>`;
  };
  return `
<div class="screen active">
  <div class="topbar">${wordmark}<span class="topmeta">·  SETUP  ·</span></div>
  <h1 class="hero" style="margin-top:36px;font-size:72px">what do<br>you&nbsp;<span class="red">eat?</span></h1>
  <p class="muted" style="font-size:14px;margin-top:20px;line-height:1.55;max-width:300px">so i never hand you a pick you&rsquo;d have to throw back.</p>
  <div style="margin-top:34px;display:flex;flex-direction:column;gap:10px">
    ${opt('veg', 'V', '#B8BE94', 'veg', 'no meat, no fish, no egg')}
    ${opt('vegan', 'V', '#7E8C5F', 'vegan', 'plants only')}
    ${opt('everything', 'E', '#E8B4A5', 'everything', 'veg, chicken, fish, mutton — all')}
  </div>
  <div class="sep"></div>
  <div class="serif" style="text-align:center;font-size:14px;padding-top:14px">change it anytime. we won&rsquo;t make it hard.</div>
</div>`;
};

SCREENS.mood = () => `
<div class="screen active">
  <div class="topbar">${wordmark}<span class="topmeta">STEP 1 OF 3 &middot; MOOD</span></div>
  <div style="margin-top:28px;display:flex;align-items:baseline;gap:10px">
    <span class="mono red" style="font-size:11px;letter-spacing:0.3em;font-weight:700">§ TONIGHT</span>
    <span class="serif muted" style="font-size:16px">hey ${esc((S.me && S.me.name) || 'friend')} —</span>
  </div>
  <h1 class="hero mt-m" style="font-size:76px">how are<br>you, <span class="red">really</span>?</h1>
  <p class="hint">tap the one closest to right now &mdash; or type it in your own words below.</p>
  <div class="moodgrid mt-m">
    ${['tired', 'wired', 'blah', 'okay', 'good', 'glowing'].map((m, i) => `<button class="moodchip m${i + 1}" data-a="pick-mood" data-v="${m}"><span class="num">0${i + 1}</span><span>${m}</span></button>`).join('')}
  </div>
  <form class="moodtext" data-submit="mood-text">
    <input class="field" name="t" maxlength="300" placeholder="or type it… “long day, need something easy”" autocomplete="off">
    <button type="submit" aria-label="go">↗</button>
  </form>
  <div class="sep"></div>
  <div class="footmeta" style="margin-top:20px;padding-top:14px;border-top:1px solid rgba(26,22,19,0.1);display:flex;justify-content:space-between">
    <button data-a="nav-hub" style="font-size:9px;letter-spacing:0.18em;font-weight:700">⊞ skip mood, just pick</button>
    <button data-a="nav-trust" style="font-size:9px;letter-spacing:0.18em;font-weight:700">⎙ my history</button>
    <button data-a="nav-settings" style="font-size:9px;letter-spacing:0.18em;font-weight:700">⚙ settings</button>
  </div>
</div>`;

SCREENS.context = () => {
  const diet = S.me && S.me.diet;
  const moodClass = ({ tired: 'taupe', wired: 'butter', good: 'moss', glowing: 'blush' })[S.ctx.mood] || 'paper';
  const cats = [['eat', 'eat'], ['watch', 'watch'], ['listen', 'listen to'], ['do', 'do'], ['wear', 'wear'], ['say', 'say']];
  return `
<div class="screen active">
  <div class="topbar">${back()}${wordmark}<span class="topmeta">STEP 2 OF 3 &middot; NEED</span></div>
  <div class="mt-m chips">
    <span class="eyebrow" style="margin-right:4px">YOU:</span>
    ${S.ctx.mood ? `<div class="chip ${moodClass}"><span class="dot"></span>${esc(S.ctx.mood)}</div>` : ''}
    <div class="chip ${diet === 'veg' || diet === 'vegan' ? 'moss' : 'paper'}"><span class="dot"></span>${esc(diet === 'everything' ? 'all' : diet || 'all')}</div>
  </div>
  <h1 class="hero" style="margin-top:18px;font-size:56px">what do<br>you <span class="red">need?</span></h1>
  <p class="hint">tap one &mdash; we&rsquo;ll pick a single thing for it. budget is optional, set it first if you care.</p>
  <div class="mt-l">
    <div class="eyebrow" style="margin-bottom:12px">§ PICK ME SOMETHING TO&hellip;</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${cats.map(([v, l]) => `<button class="pill" data-a="pick-cat" data-v="${v}">${l}</button>`).join('')}</div>
  </div>
  <div class="mt-m">
    <div class="eyebrow" style="margin-bottom:12px">§ BUDGET (OPTIONAL)</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${['free', 'u100', 'u300', 'splurge'].map((b) => `<button class="pill ${b === 'splurge' ? '' : 'mono'} ${S.ctx.budget === b ? 'active' : ''}" data-a="pick-budget" data-v="${b}">${esc(budgetLabel(b))}</button>`).join('')}
    </div>
    
  </div>
  <div class="sep"></div>
</div>`;
};

SCREENS.music = () => {
  const g = [['kpop', 'k-pop', 'a'], ['hiphop', 'hip hop', 'd'], ['bollywood', 'bollywood', 'b'], ['indiepop', 'indie (desi)', 'c'], ['punjabi', 'punjabi', 'f'], ['sufi', 'sufi', 'e'],
    ['tamil', 'tamil', ''], ['telugu', 'telugu', ''], ['lofi', 'lofi', 'c'], ['indie', 'indie', ''], ['rnb', 'r&amp;b', ''], ['jazz', 'jazz', 'e'], ['classical', 'classical', ''],
    ['rock', 'rock', ''], ['electronic', 'electronic', ''], ['afrobeats', 'afrobeats', 'a']];
  return `
<div class="screen active">
  <div class="topbar">${back('back-context')}${wordmark}<span class="topmeta">TO LISTEN</span></div>
  <h1 class="hero mt-m" style="font-size:66px">what&rsquo;s<br>the <span class="red">vibe?</span></h1>
  <div class="tagcloud mt-l">${g.map(([v, l, c]) => `<button class="genre ${c}" data-a="pick-genre" data-v="${v}">${l}</button>`).join('')}</div>
  <div class="sep"></div>
  <button data-a="surprise-genre" style="display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-radius:18px;border:1.5px dashed rgba(26,22,19,0.3);margin-top:16px">
    <div><div class="serif" style="font-size:22px;line-height:1">idk, surprise me.</div>
    <div class="mono muted" style="font-size:10px;margin-top:4px;letter-spacing:0.14em;text-transform:uppercase;font-weight:600">reads the room · picks one</div></div>
    <span class="serif" style="font-size:24px">↝</span>
  </button>
</div>`;
};

SCREENS.saycompose = () => {
  const chipRow = (act, list, cur) => list.map((x) => `<button class="pill ${cur === x ? 'active' : ''}" data-a="${act}" data-v="${x}">${x}</button>`).join('');
  return `
<div class="screen active">
  <div class="topbar">${back('back-context')}${wordmark}<span class="topmeta">TO SAY</span></div>
  <h1 class="hero mt-m" style="font-size:56px">who&rsquo;s it<br><span class="red">for?</span></h1>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:18px">${chipRow('say-to', ['ma', 'papa', 'friend', 'partner', 'boss', 'colleague', 'ex', 'landlord', 'sibling', 'recruiter', 'other'], S.say.to)}</div>
  <div class="eyebrow mt-m" style="margin-bottom:10px">§ WHAT&rsquo;S IT ABOUT</div>
  <textarea id="say-about" class="field" maxlength="500" placeholder="can’t come home for diwali this year, work won’t give leave">${esc(S.say.about)}</textarea>
  <div class="eyebrow mt-m" style="margin-bottom:10px">§ TONE</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">${chipRow('say-tone', TONES, S.say.tone)}</div>
  <div class="eyebrow mt-m" style="margin-bottom:10px">§ LANGUAGE</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">${chipRow('say-lang', ['english', 'hinglish'], S.say.lang)}</div>
  <div class="err" id="say-err"></div>
  <div class="sep"></div>
  <button class="cta mt-m" data-a="say-write"><span>write it for me</span><span class="arrow">↗</span></button>
  <div class="footmeta">written by a free open-source AI &middot; don&rsquo;t type passwords or anything secret</div>
</div>`;
};

SCREENS.pick = () => {
  const r = S.cur;
  if (!r) return SCREENS.mood();
  const cat = S.ctx.category;
  const night = isNight();
  const seal = night ? '#F2D97F' : '#E8402C';
  let title; let why = ''; let meta = ''; let links = '';

  if (cat === 'say') {
    title = r.text;
    meta = `<div class="row"><span class="k">TO</span><span class="v">${esc(r.to)}</span></div>
      <div class="row"><span class="k">TONE</span><span class="v">${esc(r.tone)}</span></div>
      <div class="row"><span class="k">LANG</span><span class="v">${esc(r.lang)}</span></div>`;
    if (r.source === 'template') why = 'the AI is offline, so here’s one of our hand-written ones.';
    else if (r.source === 'busy') why = 'the free AI is busy, so here’s a hand-written one. veto in a minute for a fresh AI draft.';
    else if (r.model) why = 'drafted by ' + r.model.replace(/-Instruct.*$/, '').replace(/_/g, '.').toLowerCase() + ' · open-source';
  } else {
    const it = r.item; const d = it.data || {};
    title = it.title; why = it.why;
    if (cat === 'eat') {
      meta = `<div class="row"><span class="k">WHERE</span><span class="v">${esc(d.where)}</span></div>
        <div class="row"><span class="k">COST</span><span class="v mono">${esc(d.cost)}</span></div>
        <div class="row"><span class="k">TIME</span><span class="v">${esc(d.time)} min</span></div>`;
      if (!/your (kitchen|pantry)/.test(d.where || '')) links = `<button class="pill mono" data-a="open" data-v="${esc('https://www.swiggy.com/search?query=' + encodeURIComponent(it.title))}">on swiggy →</button>`;
      else links = `<button class="pill mono" data-a="open" data-v="${esc('https://www.youtube.com/results?search_query=' + encodeURIComponent(it.title + ' recipe'))}">recipe →</button>`;
    } else if (cat === 'listen') {
      why = 'by ' + d.artist + ' · ' + it.genre;
      meta = `<div class="row"><span class="k">ARTIST</span><span class="v">${esc(d.artist)}</span></div>`;
      links = `<button class="pill mono" data-a="open" data-v="${esc('https://open.spotify.com/search/' + encodeURIComponent(d.q))}">spotify →</button>
        <button class="pill mono" data-a="open" data-v="${esc('https://music.youtube.com/search?q=' + encodeURIComponent(d.q))}">yt music →</button>`;
    } else if (cat === 'do') {
      meta = `<div class="row"><span class="k">COST</span><span class="v mono">${esc(d.cost)}</span></div><div class="row"><span class="k">TIME</span><span class="v mono">${esc(d.time)} min</span></div>`;
    } else if (cat === 'watch') {
      meta = `<div class="row"><span class="k">LENGTH</span><span class="v mono">${esc(d.time)} min</span></div>${d.lang ? `<div class="row"><span class="k">LANG</span><span class="v">${esc(d.lang)}</span></div>` : ''}`;
      links = `<button class="pill mono" data-a="open" data-v="${esc('https://www.justwatch.com/in/search?q=' + encodeURIComponent(it.title))}">where to stream →</button>`;
    }
  }
  const isSay = cat === 'say';
  return `
<div class="screen active">
  <div class="topbar">${wordmark}<span class="topmeta">STEP 3 OF 3 &middot; ${isSay ? 'DRAFT' : 'PICK'}</span></div>
  <div class="blob" style="top:110px;right:-90px;width:260px;height:260px;background:${night ? '#F2D97F' : '#E8B4A5'};opacity:${night ? '0.14' : '0.45'}"></div>
  <div class="chips" style="margin-top:14px">
    ${S.ctx.mood ? `<span class="chip paper">${esc(S.ctx.mood)}</span>` : ''}
    <span class="chip paper">to ${esc(cat)}</span>
    ${S.ctx.budget && cat === 'eat' ? `<span class="chip paper mono">${esc(budgetLabel(S.ctx.budget))}</span>` : ''}
  </div>
  ${S.lastVetoed ? `<div class="notice red"><span class="label">VETOED</span><span class="text">${esc(S.lastVetoed.length > 50 ? S.lastVetoed.slice(0, 50) + '…' : S.lastVetoed)}</span></div>` : ''}
  <div class="card mt-m">
    <div class="seal" style="border-color:${seal};color:${seal}"><div>${isSay ? 'DRAFT' : 'PICK'}</div><div class="num">№ ${String(r.n || 0).padStart(3, '0')}</div><div>${clockStr().toUpperCase()}</div></div>
    <div class="eyebrow" style="color:${seal}">${isSay ? '§ ONE DRAFT · NOT TEN' : '§ ONE PICK · NOT TEN'}</div>
    <h1 class="hero" style="margin-top:14px;padding-right:56px;font-size:${isSay ? 32 : cat === 'listen' ? 56 : 60}px;line-height:${isSay ? 1.15 : 0.9}">${isSay ? '&ldquo;' + esc(title) + '&rdquo;' : esc(title) + '<span class="red">.</span>'}</h1>
    <p id="why" style="margin-top:16px;font-size:14px;line-height:1.55;min-height:1em">${esc(why)}</p>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="row-actions">${links}<button class="pill mono" data-a="share">share</button>${isSay ? '<button class="pill mono" data-a="copy-draft">copy</button>' : ''}</div>
    ${isSay ? `<div style="margin-top:14px;text-align:center"><button data-a="cycle-tone" class="mono linkbtn" style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-weight:700;color:${seal}">try it ${esc(nextTone())} →</button></div>` : ''}
  </div>
  <div class="sep"></div>
  <div class="actions">
    <button class="btn-veto" data-a="veto">veto ✕</button>
    <button class="btn-yes" data-a="yes">${isSay ? 'use this' : 'yes, i&rsquo;m in'}<span class="a">↗</span></button>
  </div>
  <p class="hint" style="text-align:center;margin-top:12px"><b class="red">veto</b> = ${isSay ? 'rewrite it' : 'show me something else'} &nbsp;·&nbsp; <b>yes</b> = ${isSay ? 'copy it, i&rsquo;ll send it' : 'i&rsquo;ll go with this'}</p>
  <div class="footmeta" style="margin-top:6px">${r.week_vetoes ? r.week_vetoes + ' vetoes this week &middot; every no teaches us' : 'every no teaches us your taste'}</div>
</div>`;
};

AFTER.pick = () => {
  const r = S.cur;
  if (!r || S.ctx.category === 'say') return;
  const id = r.event_id;
  api('GET', '/api/events/' + id + '/why').then((w) => {
    if (!w || !w.personal || !S.cur || S.cur.event_id !== id) return;
    const el = document.getElementById('why');
    if (el) { el.textContent = w.why; el.classList.add('why-personal'); }
  }).catch(() => { /* keep the curated line */ });
};

SCREENS.yes = () => {
  const r = S.cur; const cat = S.ctx.category; const title = curTitle();
  const sub = cat === 'say' ? 'copied. go send it.' : cat === 'eat' ? 'go eat.' : cat === 'listen' ? 'press play.' : cat === 'do' ? 'go do it.' : cat === 'watch' ? 'enjoy the watch.' : 'go get ready.';
  const rateBtn = (v, l) => `<button class="pill ${S.fb.rating === v ? 'active' : ''}" data-a="fb-rate" data-v="${v}">${l}</button>`;
  return `
<div class="screen active yes-screen">
  <div class="sun"></div>
  <div class="topbar" style="position:relative;z-index:2">
    <span class="wordmark" style="color:#1A1613">wetoes<span style="color:#E8402C">.</span></span>
    <div class="locked"><div>LOCKED</div><div class="word">in<span style="color:#E8402C">.</span></div><div>${clockStr().toUpperCase()}</div></div>
  </div>
  <div style="text-align:center;position:relative;z-index:2;margin-top:18px">
    <h1 class="hero-yes" style="font-size:96px">done<span style="color:#E8402C">.</span></h1>
  </div>
  <div style="background:#FFFCF5;border-radius:20px;padding:18px 20px;margin-top:18px;position:relative;z-index:2;color:#1A1613">
    <div class="mono" style="font-size:9px;letter-spacing:0.28em;color:#E8402C;font-weight:700;text-transform:uppercase;margin-bottom:8px">§ ${esc(sub)}</div>
    <div class="serif" style="font-size:22px;line-height:1.15">${cat === 'say' ? '&ldquo;' + esc(title) + '&rdquo;' : esc(title)}</div>
    ${cat === 'say' && r ? `<div class="row-actions"><button class="pill mono" data-a="open" data-v="${esc('https://wa.me/?text=' + encodeURIComponent(r.text))}">whatsapp →</button><button class="pill mono" data-a="copy-draft">copy again</button></div>` : ''}
  </div>
  <div id="fb-widget" style="background:rgba(255,252,245,0.7);border-radius:20px;padding:16px 20px;margin-top:12px;position:relative;z-index:2;color:#1A1613">
    <div class="mono" style="font-size:9px;letter-spacing:0.28em;font-weight:700;margin-bottom:10px">§ HOW DID WE DO WITH THIS PICK?</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${rateBtn('good', 'nailed it')}${rateBtn('okay', 'it&rsquo;s okay')}${rateBtn('bad', 'missed')}</div>
    <div id="fb-more" ${S.fb.rating ? '' : 'hidden'} style="margin-top:10px">
      <textarea id="fb-text" class="field" maxlength="1000" style="min-height:70px;font-size:16px" placeholder="anything we should know? (optional)"></textarea>
      <button class="pill mono mt-s" data-a="fb-send" style="background:#1A1613;color:#F5EDDF;border-color:#1A1613">send feedback</button>
    </div>
  </div>
  <div class="sep"></div>
  <button class="cta mt-m" data-a="start-over" style="position:relative;z-index:2"><span>start over</span><span class="arrow">↺</span></button>
  <button data-a="another-one" style="position:relative;z-index:2;width:100%;text-align:center;padding:14px;font-size:14px;color:#1A1613">not this &mdash; <span class="linkbtn">${cat === 'say' ? 'write me a different one' : 'show me another'}</span></button>
</div>`;
};



function lastFor(cat) {
  const l = S.mem && S.mem.last && S.mem.last[cat];
  if (!l) return 'never tried · pick one';
  const name = l.name.length > 28 ? l.name.slice(0, 28) + '…' : l.name;
  return esc(name) + ' · ' + (l.action === 'kept' ? 'kept' : 'vetoed');
}

SCREENS.hub = () => {
  const card = (v, n, bg, extra) => `<button class="cat" data-a="pick-cat" data-v="${v}" style="background:${bg};${extra || 'flex-direction:column;align-items:flex-start;min-height:110px'}">
    <div class="label" style="margin-top:auto"><span class="num" style="opacity:0.6">0${n}</span><span class="name">${v}</span><span class="last" style="opacity:0.75">${lastFor(v)}</span></div></button>`;
  return `
<div class="screen active">
  <div class="topbar">${back()}${wordmark}<span class="topmeta">·  ALL CATEGORIES  ·</span></div>
  <h1 class="hero mt-m" style="font-size:48px">pick me<br>something<br>to&hellip;</h1>
  <p class="hint">no mood needed &mdash; tap a category and we&rsquo;ll pick one thing. the line under each is what you did last time.</p>
  <div class="catlist mt-l">
    ${card('eat', 1, '#1A1613;color:#F5EDDF', 'color:#F5EDDF')}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">${card('watch', 2, '#E8B4A5')}${card('listen', 3, '#F2D97F')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">${card('do', 4, '#B8BE94')}${card('wear', 5, '#D4CBB8')}</div>
    ${card('say', 6, '#FFFCF5;border:1px solid rgba(26,22,19,0.1)', 'color:#1A1613')}
  </div>
</div>`;
};

SCREENS.trust = () => {
  const m = S.mem || { kept: 0, vetoed: 0, recent: [] };
  const total = m.kept + m.vetoed;
  const dots = m.recent.slice(0, 24).reverse().map((l) => `<span class="d ${l.action === 'kept' ? 'k' : 'v'}"></span>`).join('');
  const rows = m.recent.slice(0, 10).map((l) => `
    <div class="logrow"><div><div class="name">${esc(l.name.length > 60 ? l.name.slice(0, 60) + '…' : l.name)}</div><div class="when">${timeAgo(l.ts)} &middot; ${esc(l.category)}</div></div>
    <span class="tag ${l.action}">${esc(l.action)}</span></div>`).join('');
  return `
<div class="screen active">
  <div class="topbar">${back()}${wordmark}<span class="topmeta">·  MY HISTORY  ·</span></div>
  <div class="card mt-m">
    <div style="display:flex;justify-content:space-between;align-items:baseline"><div class="eyebrow">§ THE HONEST COUNT</div><div class="mono muted" style="font-size:10px;font-weight:700">${total} TOTAL</div></div>
    <div class="stat-hero mt-s"><span class="big">${m.kept}</span><div><div class="lbl" style="color:#7E8C5F">kept</div><div class="mono muted" style="font-size:9px">${total ? Math.round((m.kept / total) * 100) : 0}% hit rate</div></div></div>
    <div class="stat-hero" style="margin-top:4px"><span class="big red">${m.vetoed}</span><span class="lbl red" style="font-size:20px">vetoed</span></div>
    ${total ? `<div class="dots">${dots}</div>` : ''}
    <p class="serif" style="margin-top:14px;font-size:16px">saying no is how i learn your <span style="color:#7E8C5F;font-weight:600">yes</span>.</p>
  </div>
  ${rows ? `<div class="mt-m"><div class="eyebrow red">§ RECENT</div><div style="margin-top:8px">${rows}</div></div>` : '<p class="muted serif" style="margin-top:28px;text-align:center;font-size:18px">no picks yet. go answer the question.</p>'}
  <div class="sep"></div>
  <div class="footmeta">no history is sold &middot; ever</div>
</div>`;
};

SCREENS.bye = () => {
  const out = S.byeMode === 'signout';
  const rateBtn = (v, l) => `<button class="pill ${S.fb.rating === v ? 'active' : ''}" data-a="fb-rate" data-v="${v}">${l}</button>`;
  return `
<div class="screen active">
  <div class="topbar">${back(out ? 'nav-settings' : 'nav-mood')}${wordmark}<span class="topmeta">FEEDBACK</span></div>
  <h1 class="hero mt-m" style="font-size:54px">${out ? 'before you<br><span class="red">go&hellip;</span>' : 'tell us<br><span class="red">straight.</span>'}</h1>
  <p class="hint" style="font-size:15px">how was wetoes ${out ? 'today' : 'so far'}? one tap is enough. a line helps even more.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:22px">${rateBtn('good', 'loved it')}${rateBtn('okay', 'it&rsquo;s okay')}${rateBtn('bad', 'not for me')}</div>
  <div id="fb-more" style="margin-top:14px">
    <textarea id="fb-text" class="field" maxlength="1000" placeholder="what should we fix, add, or never change?"></textarea>
  </div>
  <div class="sep"></div>
  <button class="cta mt-l" data-a="bye-send"><span>${out ? 'send &amp; sign out' : 'send feedback'}</span><span class="arrow">↗</span></button>
  ${out ? '<button data-a="bye-skip" style="width:100%;text-align:center;padding:14px;font-size:14px">skip &mdash; <span class="linkbtn">just sign me out</span></button>' : ''}
</div>`;
};

SCREENS.settings = () => {
  const me = S.me || {};
  return `
<div class="screen active">
  <div class="topbar">${back()}${wordmark}<span class="topmeta">·  SETTINGS  ·</span></div>
  <h1 class="hero mt-m" style="font-size:60px">you<span class="red">.</span></h1>
  <div class="muted mono" style="font-size:11px;margin-top:8px">${esc(me.email)} &middot; saved on this device</div>
  <div class="mt-l">
    <div class="eyebrow" style="margin-bottom:10px">§ YOUR NAME (OPTIONAL)</div>
    <input id="name-input" class="field" type="text" maxlength="40" value="${esc(me.name || '')}" placeholder="what should we call you?">
    <button class="pill mono mt-s" data-a="save-name" style="background:#1A1613;color:#F5EDDF;border-color:#1A1613">save name</button>
  </div>
  <div class="mt-l">
    <div class="eyebrow" style="margin-bottom:10px">§ WHAT YOU EAT</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${['veg', 'vegan', 'everything'].map((d) => `<button class="pill ${me.diet === d ? 'active' : ''}" data-a="set-diet" data-v="${d}">${d}</button>`).join('')}</div>
  </div>
  <div class="mt-l">
    <div class="eyebrow" style="margin-bottom:10px">§ YOUR CITY</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${[['mumbai', 'mumbai'], ['other', 'somewhere else']].map(([c, l]) => `<button class="pill ${me.city === c ? 'active' : ''}" data-a="set-city" data-v="${c}">${l}</button>`).join('')}</div>
    <div class="hint">outside mumbai you get home-cooked picks while we add your city.</div>
  </div>
  <div class="mt-l">
    <button class="cta" data-a="nav-feedback"><span>give us feedback</span><span class="arrow">↗</span></button>
  </div>
  <div class="sep"></div>
  <div class="mt-l" style="padding-top:14px;border-top:1px solid rgba(26,22,19,0.1);display:flex;flex-wrap:wrap;gap:8px">
    <button class="pill mono" data-a="logout">sign out</button>
    <button class="pill mono" data-a="export">download my data</button>
    <button class="pill mono" data-a="delete-account" style="color:#E8402C;border-color:#E8402C">delete my data</button>
  </div>
  <div class="footmeta mt-m">v0.4 &middot; your picks stay in this browser &middot; <button class="linkbtn" data-a="nav-privacy">privacy</button></div>
</div>`;
};

SCREENS.privacy = () => `
<div class="screen active">
  <div class="topbar">${back('privacy-back')}${wordmark}<span class="topmeta">PRIVACY</span></div>
  <div class="eyebrow red mt-m">§ IN PLAIN WORDS</div>
  <h1 class="hero" style="margin-top:10px;font-size:44px;line-height:0.95">what we keep,<br>and <span class="red">why.</span></h1>
  <div class="howto mt-l">
    <div class="step"><span class="n">01</span><div><b>what stays on your device</b><span>your picks, vetoes, history, diet and drafts are saved only in this browser. we never see them. clear your browser data or tap &ldquo;delete my data&rdquo; and they&rsquo;re gone.</span></div></div>
    <div class="step"><span class="n">02</span><div><b>what we receive</b><span>your email and name when you start, and any feedback you choose to send. that&rsquo;s it. we use your email only to reach you about wetoes &mdash; never sold, never shared.</span></div></div>
    <div class="step"><span class="n">03</span><div><b>the AI</b><span>drafts, typed moods and &ldquo;why this&rdquo; lines are written by free open-source models (gpt-oss, llama, mistral) hosted by OVHcloud in the EU. what you type there is sent to them to get an answer &mdash; so don&rsquo;t type anything secret.</span></div></div>
    <div class="step"><span class="n">04</span><div><b>your control</b><span>in settings: download everything, or delete it. to remove your email from our list, write to us.</span></div></div>
  </div>
  ${(window.WETOES_CONFIG || {}).contact ? `<p class="muted mt-l" style="font-size:14px;line-height:1.5">questions or a data request? write to <a class="linkbtn" href="mailto:${esc(window.WETOES_CONFIG.contact)}">${esc(window.WETOES_CONFIG.contact)}</a>.</p>` : ''}
  <button class="cta mt-l" data-a="privacy-back"><span>got it</span><span class="arrow">↗</span></button>
</div>`;

/* ========== BOOT ========== */
(async function boot() {
  checkNight();
  setInterval(checkNight, 60000);
  if (location.search) history.replaceState(null, '', location.pathname);
  window.WetoesEngine.items().catch(() => {});
  try {
    S.me = await api('GET', '/api/me');
  } catch (_) {
    S.me = null;
  }
  if (!S.me) return goto('welcome');
  if (!S.me.diet) return goto('diet');
  goto('mood');
})();
