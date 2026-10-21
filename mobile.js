/* Panorra mobile app prototype — vanilla JS, simulation only (no network calls).
   Flow: Start -> Pre-flight -> (SSO up) Redirect -> Home
                             -> (SSO down) Local login -> Google | Email code -> Enter code -> Signed in */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const BRAND = document.body.dataset.brand || 'Panorra'; // street-editor.html reuses this flow
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const state = { sso: 'down', link: 'valid', speed: 10, email: '', sends: {}, code: '', tries: 0, linkUsed: false, resendLeft: 0, history: [], session: '' };

  /* ---------- cancellable timers ---------- */
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const stop = t => { clearTimeout(t); clearInterval(t); timers.delete(t); };
  const wait = ms => new Promise(r => later(r, ms));
  const clearAll = () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers.clear(); };

  /* ---------- navigation (iOS-like push / pop) ---------- */
  let current = 'start';
  function go(id, { back = false, push = true } = {}) {
    const prev = $('#v-' + current);
    const next = $('#v-' + id);
    if (prev && prev !== next) prev.classList.remove('is-on');
    if (push && !back && current !== id) state.history.push(current);
    next.dataset.anim = back ? 'back' : 'fwd';
    next.classList.remove('is-on'); void next.offsetWidth; // replay entrance + illustration animations
    next.classList.add('is-on');
    next.scrollTop = 0;
    current = id;
    const h = next.querySelector('[tabindex="-1"]');
    if (h) requestAnimationFrame(() => h.focus({ preventScroll: true }));
  }
  function goBack() {
    const prev = state.history.pop();
    if (prev) go(prev, { back: true, push: false });
  }

  function toast(msg) {
    $('#m-toast-msg').textContent = msg;
    const t = $('#m-toast');
    t.classList.add('is-on');
    later(() => t.classList.remove('is-on'), 3200);
  }

  /* ---------- Pre-flight ---------- */
  // Pre-flight probe: HEAD /realms/gothru/.well-known/openid-configuration, 1.5 s timeout
  async function probe() { const up = state.sso === 'up'; await wait(up ? 280 : 1500); return up; }

  const PF_COPY = {
    run: ['Preparing your sign-in', `We're checking the best way to sign you in to ${BRAND}. This will only take a moment.`],
    ok: ["You're all set", 'GoThru SSO is available. Taking you to secure sign-in...'],
  };
  function setPreflight(result) {
    const v = $('#v-preflight');
    v.dataset.result = result;
    [$('#mpf-title').textContent, $('#mpf-desc').textContent] = PF_COPY[result];
  }
  function showPreflightOk() {
    go('preflight');
    $$('#mpf-steps li').forEach(li => { li.className = 'done'; });
    setPreflight('ok');
  }
  async function runPreflight() {
    setPreflight('run');
    const items = $$('#mpf-steps li');
    items.forEach(li => { li.className = ''; });
    go('preflight');
    const result = probe(); // real probe starts at once; steps are visual pacing only
    for (let i = 0; i < 3; i++) {
      items[i].className = 'active';
      await wait(650);
      items[i].className = 'done';
    }
    items[3].className = 'active';
    const [ok] = await Promise.all([result, wait(700)]);
    if (!ok) return go('fallback'); // failure is not shown: straight to Google / email code
    items[3].className = 'done';
    setPreflight('ok');
    await wait(1000);
    runRedirect();
  }

  async function runRedirect() {
    go('redirect');
    const bar = $('#m-progress');
    bar.classList.remove('run'); void bar.offsetWidth; bar.classList.add('run');
    await wait(1700);
    if ($('#v-completing')) runSignedIn();
    else openHome('', 'Signed in with GoThru.');
  }

  /* ---------- Login success (street-editor.html): steps tick to done, then welcome back ---------- */
  const STATUS_STEPS = ['GoThru account verified', `${BRAND} session created`, 'Profile loaded'];
  const statusSteps = done => STATUS_STEPS.map((t, i) =>
    `<li class="${i < done ? 'done' : i === done ? 'active' : ''}"><span class="s-ic"><svg class="i ic-ok"><use href="#i-check"/></svg></span>${t}</li>`).join('');
  function showWelcome() {
    // own ids: url(#...) refs into the hidden Signed-in view don't paint
    $('#v-welcome .mw-ill').innerHTML = $('#v-success .success-ill').outerHTML.replace(/sx-(clip|sky|ring|range)/g, 'sw-$1');
    $('#mw-steps').innerHTML = statusSteps(STATUS_STEPS.length);
    go('welcome');
  }
  async function runSignedIn() {
    $('#mc-steps').innerHTML = statusSteps(0);
    go('completing');
    const lis = $$('#mc-steps li');
    for (let i = 0; i < lis.length; i++) {
      await wait(800);
      lis[i].className = 'done';
      if (lis[i + 1]) lis[i + 1].className = 'active';
    }
    await wait(500);
    showWelcome();
    await wait(2400);
    openHome('', 'Signed in with GoThru.');
  }

  /* ---------- Google fallback ---------- */
  async function runGoogle() {
    go('google');
    await wait(1600);
    openHome('Emergency session · Google', 'Signed in with Google. Work normally.');
  }

  /* ---------- Apple sign-in (street-editor.html start screen) ---------- */
  async function runApple() {
    go('apple');
    await wait(1600);
    openHome('', 'Signed in with Apple.');
  }

  /* ---------- Email code ---------- */
  function openEmail(prefill = state.email) {
    $('#m-email').value = prefill || '';
    setEmailMsg('', '');
    syncSend();
    go('email');
  }
  function setEmailMsg(tone, text) {
    const m = $('#m-email-msg');
    m.className = 'form-msg' + (tone ? ' is-' + tone : '');
    m.textContent = text;
    $('#m-email').setAttribute('aria-invalid', tone === 'err' ? 'true' : 'false');
  }
  function syncSend() { $('#m-send').disabled = !EMAIL_RE.test($('#m-email').value.trim()); }

  // POST /api/auth/email-code/request: 200 always (anti-enumeration), 429 after 3 requests / 15 min per email
  const newCode = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  async function requestLink(email) {
    await wait(900);
    state.sends[email] = (state.sends[email] || 0) + 1;
    if (state.sends[email] > 3) return 429;
    state.code = newCode(); state.tries = 0; // a new code replaces the old one
    return 200;
  }
  function setBtnLoading(btn, text) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${text}</span>`;
  }
  function resetBtn(btn) { if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; delete btn.dataset.html; } btn.disabled = false; }

  async function sendLink(e) {
    e.preventDefault();
    const email = $('#m-email').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setEmailMsg('err', 'Please enter a valid email address.');
    const btn = $('#m-send');
    setBtnLoading(btn, 'Sending...');
    const status = await requestLink(email);
    resetBtn(btn); syncSend();
    if (status === 429) return setEmailMsg('warn', 'Too many requests. Please wait a few minutes before trying again.');
    state.email = email;
    state.linkUsed = false;
    showSent(false);
  }

  function showSent(resent) {
    $('#ms-title').textContent = resent ? 'A new code has been sent' : 'Check your email';
    $('#ms-lead').textContent = resent ? "We've sent a new 6-digit code to" : 'Enter the 6-digit code we sent to';
    $('#ms-email').textContent = state.email || 'you@example.com';
    $('#m-resend-msg').hidden = true;
    otp.set('');
    setCodeMsg('');
    if (current === 'sent') { const ill = $('#v-sent .mail-ill'); ill.replaceWith(ill.cloneNode(true)); }
    else go('sent');
    countdown(60);
  }
  function renderResend() {
    const b = $('#m-resend');
    b.disabled = state.resendLeft > 0;
    b.textContent = state.resendLeft > 0 ? `Resend Code (${state.resendLeft}s)` : 'Resend Code';
  }
  let cdTimer = 0;
  function countdown(s) {
    stop(cdTimer);
    state.resendLeft = s; renderResend();
    cdTimer = every(() => { state.resendLeft--; renderResend(); if (state.resendLeft <= 0) stop(cdTimer); }, 1000 / state.speed);
  }
  async function resend() {
    const b = $('#m-resend');
    setBtnLoading(b, 'Sending...');
    const status = await requestLink(state.email || 'you@example.com');
    resetBtn(b);
    if (status === 429) {
      const m = $('#m-resend-msg');
      m.innerHTML = '<svg class="i"><use href="#i-alert"/></svg><span>Too many requests. Please wait a few minutes before trying again.</span>';
      m.hidden = false;
      return countdown(60);
    }
    state.linkUsed = false;
    showSent(true);
  }

  /* ---------- Code boxes: type, backspace, arrows, paste or one-time-code autofill ---------- */
  function codeBoxes(root, onChange) {
    const boxes = $$('input', root);
    const get = () => boxes.map(b => b.value).join('');
    const fill = (from, digits) => {
      [...digits].slice(0, boxes.length - from).forEach((d, i) => { boxes[from + i].value = d; });
      boxes[Math.min(from + digits.length, boxes.length - 1)].focus();
    };
    const changed = () => { root.removeAttribute('aria-invalid'); onChange(get()); };
    boxes.forEach((b, i) => {
      b.addEventListener('focus', () => b.select());
      b.addEventListener('input', () => { const d = b.value.replace(/\D/g, ''); b.value = ''; if (d) fill(i, d); changed(); });
      b.addEventListener('paste', e => { e.preventDefault(); fill(i, e.clipboardData.getData('text').replace(/\D/g, '')); changed(); });
      b.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !b.value && i) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].focus(); changed(); }
        else if (e.key === 'ArrowLeft' && i) boxes[i - 1].focus();
        else if (e.key === 'ArrowRight' && boxes[i + 1]) boxes[i + 1].focus();
      });
    });
    return { get, set(code) { boxes.forEach((b, i) => { b.value = code[i] || ''; }); onChange(get()); }, focus: () => boxes[0].focus() };
  }
  const otp = codeBoxes($('#m-otp'), code => {
    $('#m-verify').disabled = code.length < 6 || !!$('#m-verify').dataset.html;
    if (code.length === 6 && current === 'sent') $('#m-otp-form').requestSubmit();
  });
  function setCodeMsg(text) {
    const m = $('#m-otp-msg');
    m.className = 'form-msg' + (text ? ' is-err' : '');
    m.textContent = text;
  }
  // Wrong / expired / burned code: clear the boxes and let the user try again; a dead code unlocks Resend at once
  function codeError(text, dead) {
    setCodeMsg(text);
    const root = $('#m-otp');
    root.setAttribute('aria-invalid', 'true');
    root.classList.remove('shake'); void root.offsetWidth; root.classList.add('shake');
    otp.set('');
    otp.focus();
    if (dead) { stop(cdTimer); state.resendLeft = 0; renderResend(); }
  }

  /* ---------- Verify (POST /api/auth/email-code/verify): single-use, 15 min, 5 tries ---------- */
  async function verifyCode(e) {
    e.preventDefault();
    const btn = $('#m-verify');
    const code = otp.get();
    if (code.length < 6 || btn.dataset.html) return;
    setBtnLoading(btn, 'Verifying...');
    await wait(800);
    resetBtn(btn);
    if (state.link === 'expired') return codeError('This code has expired. Request a new code.', true);
    if (state.linkUsed || state.tries >= 5) return codeError('This code is no longer valid. Request a new code.', true);
    if (code !== state.code) {
      state.tries++;
      return state.tries >= 5
        ? codeError('Too many incorrect attempts. Request a new code.', true)
        : codeError(`Incorrect code. ${5 - state.tries} ${5 - state.tries === 1 ? 'attempt' : 'attempts'} left.`);
    }
    state.linkUsed = true; // code burned: single use
    go('success');
  }

  function openMail() {
    $('#mm-to').textContent = state.email || 'you@example.com';
    $('#mm-code').textContent = state.code;
    go('mail');
  }
  // Copy only: the user goes back to the app and enters the code themselves
  function copyCode(e) {
    const btn = e.currentTarget;
    navigator.clipboard?.writeText(state.code).catch(() => {});
    btn.textContent = 'Copied!';
    later(() => { btn.textContent = 'Copy Code'; }, 2000);
  }

  /* ---------- Home ---------- */
  const TOURS = [
    { t: 'Batur Caldera Rim Trail', m: 'Bali, Indonesia', d: '8.4 km', v: '2.4k', h: 205 },
    { t: 'Rinjani Summit Route', m: 'Lombok, Indonesia', d: '41.2 km', v: '1.9k', h: 160 },
    { t: 'Komodo Island Explorer', m: 'NTT, Indonesia', d: '18.6 km', v: '3.1k', h: 185 },
    { t: 'Borobudur Sunrise Walk', m: 'Central Java, Indonesia', d: '3.2 km', v: '5.2k', h: 30 },
  ];
  function openHome(session, msg) {
    state.session = session;
    const chip = $('#m-session');
    chip.hidden = !session;
    chip.textContent = session;
    $('#m-tours').innerHTML = TOURS.map((x, i) => `
      <article class="tour" style="animation-delay:${i * 60}ms">
        <div class="thumb" style="--h:${x.h}"><svg><use href="#ill-mountains"/></svg><span class="b360">360°</span></div>
        <div class="tour-body"><h3>${x.t}</h3><p><span>${x.d} · ${x.m}</span><span>${x.v} views</span></p></div>
      </article>`).join('');
    state.history = [];
    go('home');
    if (msg) later(() => toast(msg), 350);
  }

  /* ---------- Prototype jumps ---------- */
  const demoEmail = () => { if (!state.email) state.email = 'eko@gothru.co'; if (!state.code) state.code = newCode(); };
  const wrongCode = () => state.code.replace(/\d/g, d => (+d + 1) % 10);
  const JUMPS = {
    start: () => go('start'),
    preflight: () => runPreflight(),
    'pf-ok': showPreflightOk,
    redirect: () => runRedirect(),
    fallback: () => go('fallback'),
    email: () => openEmail(),
    sent: () => { demoEmail(); go('fallback'); showSent(false); },
    resent: () => { demoEmail(); go('fallback'); showSent(true); },
    wrong: () => { demoEmail(); state.linkUsed = false; go('fallback'); showSent(false); otp.set(wrongCode()); },
    expired: () => { demoEmail(); go('fallback'); showSent(false); codeError('This code has expired. Request a new code.', true); },
    mail: () => { demoEmail(); openMail(); },
    success: () => go('success'),
    home: () => openHome('Emergency session · Email code', ''),
  };
  // Back-stack each jumped-to screen would have had in the real flow
  const HISTORY = { email: ['start', 'fallback'], sent: ['start', 'fallback', 'email'], resent: ['start', 'fallback', 'email'], wrong: ['start', 'fallback', 'email'], expired: ['start', 'fallback', 'email'], mail: ['start', 'fallback', 'email', 'sent'] };
  function jump(key) {
    clearAll();
    $('#m-toast').classList.remove('is-on');
    resetBtn($('#m-verify'));
    JUMPS[key]();
    state.history = HISTORY[key] || [];
    togglePanel(false);
  }

  /* ---------- Controls panel (bottom sheet on phones) ---------- */
  const side = $('#m-side');
  const fab = $('#m-fab');
  function togglePanel(force) {
    if (!window.matchMedia('(max-width: 520px)').matches) return;
    const open = force ?? !side.classList.contains('is-open');
    side.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', String(open));
  }

  /* ---------- Wire up ---------- */
  $('#m-sso-btn').addEventListener('click', runPreflight);
  $('#m-google').addEventListener('click', runGoogle);
  if ($('#v-completing')) Object.assign(JUMPS, { completing: runSignedIn, welcome: showWelcome });
  if ($('#m-apple')) { $('#m-apple').addEventListener('click', runApple); JUMPS.apple = runApple; }
  $('#m-magic').addEventListener('click', () => openEmail());
  $('#m-email').addEventListener('input', () => { setEmailMsg('', ''); syncSend(); });
  $('#m-form').addEventListener('submit', sendLink);
  $('#m-otp-form').addEventListener('submit', verifyCode);
  $('#m-open-mail').addEventListener('click', openMail);
  $('#m-resend').addEventListener('click', resend);
  $('#m-diff').addEventListener('click', () => openEmail(''));
  $('#m-mail-copy').addEventListener('click', copyCode);
  $('#m-continue').addEventListener('click', () => openHome('Emergency session · Email code', 'Signed in with an emergency email code. Work normally.'));
  $$('[data-back]').forEach(b => b.addEventListener('click', goBack));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => jump(b.dataset.go)));
  $$('input[name="m-sso"]').forEach(r => r.addEventListener('change', () => { state.sso = r.value; }));
  $$('input[name="m-link"]').forEach(r => r.addEventListener('change', () => { state.link = r.value; }));
  $$('input[name="m-speed"]').forEach(r => r.addEventListener('change', () => { state.speed = +r.value; }));
  fab.addEventListener('click', () => togglePanel());
  $('#m-side-x').addEventListener('click', () => togglePanel(false));
  $$('.m-tabs a').forEach(a => a.addEventListener('click', e => e.preventDefault()));

  // Deep link: mobile.html#sent, #fallback, ...
  const hash = location.hash.slice(1);
  if (JUMPS[hash]) jump(hash); else go('start', { push: false });
})();
