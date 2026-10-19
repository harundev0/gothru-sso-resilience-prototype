/* Resilient SSO Login — prototype logic (vanilla JS, simulation only).
   Mirrors the flow in keycloak-downtime-risk-mitigation.md §3 + task files.
   No network calls: probe / magic-link / session refresh are simulated. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const BRAND = document.body.dataset.brand || 'Panorra'; // photo-studio.html reuses this flow
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const state = {
    scenario: 'extended',   // healthy | recover | extended
    speed: 5,
    linkMode: 'valid',      // valid | expired
    netError: false,
    a2a: 'live',            // live | stale | empty | unavailable
    outageStart: 0,
    polling: false, checkCount: 0, pollTimer: 0,
    email: '', sends: {}, linkUsed: false,
    resendLeft: 0, resendTimer: 0,
    sess: null, sessTick: 0,
  };

  /* ---------- timers (all cancellable on jump/reset) ---------- */
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const stop = t => { clearTimeout(t); clearInterval(t); timers.delete(t); };
  const wait = ms => new Promise(r => later(r, ms));
  const scaled = ms => ms / state.speed;
  const clearAll = () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers.clear(); state.polling = false; };

  /* ---------- helpers ---------- */
  function show(id) {
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.id === id));
    window.scrollTo(0, 0);
    $('#proto-current').textContent = $('#' + id).dataset.label || id;
  }
  function setBtnLoading(btn, text) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${text}</span>`;
  }
  function resetBtn(btn) {
    if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; delete btn.dataset.html; }
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
  function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  /* ---------- Keycloak simulation ---------- */
  function keycloakUp() {
    if (state.scenario === 'healthy') return true;
    if (state.scenario === 'recover') return !!state.outageStart && Date.now() - state.outageStart >= scaled(15000);
    return false;
  }
  // Pre-flight probe: HEAD /realms/gothru/.well-known/openid-configuration with AbortController timeout
  async function probeKeycloakHealth(timeoutMs) {
    const up = keycloakUp();
    await wait(up ? 280 : timeoutMs);
    return up;
  }

  /* =========================================================
     Gate (original "Log in to continue")
     ========================================================= */
  const overlay = $('#overlay');
  // Focus moves into the dialog heading on open and returns to the opener on close
  let opener = null;
  function focusTitle(root) { const h = root.querySelector('[tabindex="-1"]'); if (h) requestAnimationFrame(() => h.focus({ preventScroll: true })); }
  function openOverlay(view) {
    if (!overlay.classList.contains('is-open')) opener = document.activeElement;
    overlay.dataset.view = view;
    overlay.classList.add('is-open');
    focusTitle(overlay.querySelector(view === 'gate' ? '.modal-gate' : '.modal-maint .mview[data-v="' + (modal.dataset.mview || 'main') + '"]'));
  }
  function closeOverlay() {
    if (!overlay.classList.contains('is-open')) return;
    overlay.classList.remove('is-open');
    if (opener && document.contains(opener) && opener.offsetParent) opener.focus({ preventScroll: true });
    opener = null;
  }

  function openGate() {
    show('scr-app');
    resetBtn($('#login-button'));
    $('#probe-hint').textContent = '';
    if (overlay.querySelector('.modal-gate')) openOverlay('gate');
    else { closeOverlay(); focusTitle($('#scr-app')); } // photo-studio.html: the gate is an inline card, not a modal
  }

  async function handleLoginClick() {
    if (state.scenario !== 'healthy' && !state.outageStart) state.outageStart = Date.now();
    closeOverlay();
    const ok = await runPreflight();
    // Pre-flight failed: offer Google and Magic Link at once; polling keeps running in the background
    if (ok) goRedirect(); else { show('scr-app'); showMaintenance({ fallback: true }); }
  }

  // Pre-flight screen: steps 1-3 advance on timers, step 4 spins until the real probe resolves
  const PF_STEP_MS = 650;
  const PF_COPY = {
    run: ['Preparing your sign-in', `We're checking the best way to sign you in to ${BRAND}. This will only take a moment.`],
    ok: ["You're all set", 'GoThru SSO is available. Taking you to secure sign-in...'],
  };
  function setPreflight(result) {
    const scr = $('#scr-preflight');
    scr.dataset.result = result;
    [$('#pf-title').textContent, $('#pf-desc').textContent] = PF_COPY[result];
  }
  // Final state shown without animation timing (prototype jumps)
  function showPreflightOk() {
    show('scr-preflight');
    $$('#pf-steps li').forEach(li => { li.className = 'done'; });
    setPreflight('ok');
  }
  async function runPreflight() {
    show('scr-preflight');
    setPreflight('run');
    focusTitle($('#scr-preflight'));
    const items = $$('#pf-steps li');
    items.forEach(li => { li.className = ''; });
    const probe = probeKeycloakHealth(1500); // real probe starts at once; steps are only visual pacing
    for (let i = 0; i < 3; i++) {
      items[i].className = 'active';
      await wait(PF_STEP_MS);
      items[i].className = 'done';
    }
    items[3].className = 'active';
    const [ok] = await Promise.all([probe, wait(700)]);
    if (!ok) return false; // failure is not shown: the caller opens Google / Magic Link straight away
    items[3].className = 'done';
    setPreflight('ok');
    await wait(1000); // hold the success state long enough to read
    return true;
  }

  /* =========================================================
     Maintenance modal: polling every 10s, fallback after 3 fails
     ========================================================= */
  const modal = $('#sso-maintenance-modal');
  const statusBox = $('#status-box');
  const setMView = v => { modal.dataset.mview = v; focusTitle(modal.querySelector(`.mview[data-v="${v}"]`)); };

  function setStatus(tone, html) {
    statusBox.dataset.tone = tone;
    $('#sso-modal-status').innerHTML = html;
  }
  function setMeta(text) { $('#status-meta').textContent = text; }
  function setNote(tone, text) { const n = $('#mm-note'); n.hidden = !text; n.dataset.tone = tone; n.textContent = text; }
  function resetAttempts() {
    $$('.att', modal).forEach(a => { a.className = 'att'; a.querySelector('i').style.transitionDuration = '0ms'; });
  }
  function fillAttempt(n, ms) {
    const a = $(`.att[data-n="${n}"]`, modal);
    if (!a) return;
    a.querySelector('i').style.transitionDuration = ms + 'ms';
    void a.offsetWidth;
    a.classList.add('filling');
  }
  function markAttempt(n, cls) { const a = $(`.att[data-n="${n}"]`, modal); if (a) a.classList.add(cls); }
  function markAll(cls) { [1, 2, 3].forEach(n => markAttempt(n, cls)); }
  function toggleFallback(on) { $('#sso-emergency-fallback').classList.toggle('is-open', on); }

  function showMaintenance({ fallback = false } = {}) {
    openOverlay('maint');
    setMView('main');
    resetAttempts();
    setMeta('');
    setNote('', '');
    clearMagicMsg();
    if (fallback) {
      markAll('fail');
      setStatus('warn', '<strong>SSO service is taking longer than expected.</strong>');
      setMeta("We'll keep checking every 10s in the background.");
    } else {
      setStatus('wait', 'Waiting for service to reconnect (checking every 10s)...');
    }
    toggleFallback(fallback);
    startPolling(fallback ? 3 : 0);
  }

  function startPolling(startCount) {
    stopPolling();
    state.polling = true;
    state.checkCount = startCount;
    nextPoll();
  }
  function stopPolling() { state.polling = false; stop(state.pollTimer); }

  function nextPoll() {
    const n = state.checkCount + 1;
    if (n <= 3) fillAttempt(n, scaled(10000));
    state.pollTimer = later(async () => {
      if (!state.polling) return;
      state.checkCount = n;
      const secs = n * 10;
      if (n <= 3) setStatus('wait', `Re-checking authentication service (${secs}s elapsed)...`);
      else setMeta(`Still re-checking every 10s · ${secs}s elapsed`);
      const ok = await probeKeycloakHealth(scaled(2000));
      if (!state.polling) return;
      if (ok) return recovered();
      if (n <= 3) markAttempt(n, 'fail');
      if (n === 3) {
        setStatus('warn', '<strong>SSO service is taking longer than expected.</strong>');
        setMeta("We'll keep checking every 10s in the background.");
        toggleFallback(true);
      }
      nextPoll();
    }, scaled(10000));
  }

  function recovered({ redirect = true } = {}) {
    stopPolling();
    $$('.att', modal).forEach(a => a.classList.remove('fail', 'filling'));
    markAll('ok');
    setStatus('ok', 'SSO Service recovered! Redirecting to login...');
    setMeta('');
    setNote('ok', 'SSO Service recovered! Redirecting to login...');
    if (redirect) later(goRedirect, 800);
  }

  async function retryNow() {
    const btn = $('#btn-retry');
    setBtnLoading(btn, 'Connecting...');
    const ok = await probeKeycloakHealth(1500);
    resetBtn(btn);
    if (ok) return recovered();
    const msg = state.checkCount >= 3
      ? "Still unavailable. Use Google or Magic Link below, or we'll keep checking every 10s."
      : "Still unavailable. We'll keep checking automatically.";
    setMeta(msg);
    setNote('warn', msg);
    restartAnim($('#mm-note'), 'shake');
  }

  function dismissMaintenance() { stopPolling(); closeOverlay(); }

  /* ---------- Fallback 1: Google ---------- */
  function handleLocalGoogleLogin() {
    stopPolling();
    closeOverlay();
    runStatusFlow('google');   // → /auth/google/fallback → /auth/google/callback
  }

  /* ---------- Fallback 2: Magic link ---------- */
  function clearMagicMsg() {
    const m = $('#magic-link-status');
    m.className = 'form-msg'; m.textContent = '';
    $('#magic-link-email').removeAttribute('aria-invalid');
  }
  function setMagicMsg(tone, text) {
    const m = $('#magic-link-status');
    m.className = 'form-msg is-' + tone; m.textContent = text;
  }

  // POST /api/auth/magic-link/request — max 3 per 15 min per email, generic 200
  async function requestMagicLink(email) {
    await wait(900);
    if (state.netError) return 'network';
    const k = email.toLowerCase();
    const n = state.sends[k] || 0;
    if (n >= 3) return 429;
    state.sends[k] = n + 1;
    state.linkUsed = false;
    return 'ok';
  }

  async function handleSendMagicLink(e) {
    e.preventDefault();
    const input = $('#magic-link-email');
    const email = input.value.trim();
    clearMagicMsg();
    if (!EMAIL_RE.test(email)) {
      input.setAttribute('aria-invalid', 'true');
      setMagicMsg('err', 'Please enter a valid email address.');
      input.focus();
      return;
    }
    const btn = $('#btn-magic-link');
    setBtnLoading(btn, 'Sending...');
    const res = await requestMagicLink(email);
    resetBtn(btn);
    if (res === 'ok') { state.email = email; showSent(false); }
    else if (res === 429) setMagicMsg('warn', 'Too many requests. Please wait a few minutes before trying again.');
    else setMagicMsg('err', 'Network error. Please try again or use Google login.');
  }

  function showSent(resent) {
    stopPolling();
    openOverlay('maint');
    setMView('sent');
    $('#sent-title').textContent = resent ? 'A new link has been sent' : 'Check your email';
    $('#sent-lead').textContent = resent ? "We've sent another sign-in link to" : "We've sent a sign-in link to";
    $('#sent-email').textContent = state.email || 'you@example.com';
    $('#sent-sub').textContent = resent
      ? "If you don't see the email, please check your spam folder."
      : `Click the link in your email to continue to ${BRAND}. The link will expire in 15 minutes.`;
    $('#resend-msg').hidden = true;
    const ill = $('.mail-ill', modal);
    ill.replaceWith(ill.cloneNode(true)); // replay entrance animation
    startResendCountdown(60);
  }

  function renderResend() {
    const btn = $('#btn-resend');
    btn.disabled = state.resendLeft > 0;
    btn.textContent = state.resendLeft > 0 ? `Resend Link (${state.resendLeft}s)` : 'Resend Link';
  }
  function startResendCountdown(s) {
    stop(state.resendTimer);
    state.resendLeft = s;
    renderResend();
    state.resendTimer = every(() => {
      state.resendLeft--;
      renderResend();
      if (state.resendLeft <= 0) stop(state.resendTimer);
    }, scaled(1000));
  }
  async function resend() {
    const btn = $('#btn-resend');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" aria-hidden="true"></span><span>Sending...</span>';
    const res = await requestMagicLink(state.email);
    if (res === 'ok') return showSent(true);
    const msg = $('#resend-msg');
    msg.hidden = false;
    if (res === 429) {
      msg.innerHTML = '<svg class="i"><use href="#i-alert"/></svg><span>Too many requests. Please wait a few minutes before trying again.</span>';
      startResendCountdown(60);
    } else {
      msg.innerHTML = '<svg class="i"><use href="#i-alert"/></svg><span>Network error. Please try again or use Google login.</span>';
      renderResend();
    }
  }

  function useDifferentEmail(prefill = '') {
    show('scr-app');
    showMaintenance({ fallback: true });
    const input = $('#magic-link-email');
    input.value = prefill;
    later(() => input.focus(), 350);
  }

  /* =========================================================
     Email + verify (/auth/magic-link/verify)
     ========================================================= */
  function goEmail() {
    $('#mail-to').textContent = state.email || 'you@example.com';
    show('scr-email');
  }

  const vfCard = $('#vf-card');
  const setVView = v => { vfCard.dataset.state = v; };
  function resetSteps() { $$('#vf-steps li').forEach(li => { li.className = ''; }); }
  function step(i, cls) { const li = $$('#vf-steps li')[i]; li.className = cls; }

  async function goVerify() {
    show('scr-verify');
    setVView('verifying');
    resetSteps();
    step(0, 'active');
    await wait(900);
    const reason = state.linkMode === 'expired' ? 'expired' : state.linkUsed ? 'used' : null;
    if (reason) {
      step(0, 'fail');
      await wait(500);
      return showVerifyError(reason);
    }
    state.linkUsed = true; // nonce burned (single-use)
    step(0, 'done'); step(1, 'active');
    await wait(900);
    step(1, 'done'); step(2, 'active');
    await wait(900);
    step(2, 'done');
    await wait(450);
    setVView('success');
  }
  function showVerifyError(reason) {
    $('#vf-err-detail').textContent = reason === 'expired'
      ? 'Magic link has expired.'
      : 'This magic link has already been used.';
    setVView('error');
  }

  /* =========================================================
     Redirect → GoThru login → original status cards
     ========================================================= */
  function goRedirect() {
    stopPolling();
    closeOverlay();
    show('scr-redirect');
    restartAnim($('#rd-progress'), 'run');
    later(() => show('scr-gothru-login'), 1700);
  }

  const FLOWS = {
    sso: [
      ['spin', 'Completing GoThru sign in', `Verifying your account and preparing your ${BRAND} session.`, 1800],
      ['check', 'Sign in complete', `Your GoThru account is verified. Loading your ${BRAND} profile.`, 1500],
      ['check', 'Welcome back, Eko Syaepulloh Qa', `Everything is ready. Taking you to ${BRAND} now.`, 2300,
        ['GoThru account verified', `${BRAND} session created`, 'Profile loaded']],
    ],
    google: [
      ['spin', 'Redirecting to Google…', 'Opening Google sign-in to verify your email ownership.', 1300],
      ['spin', 'Completing Google sign in', `Verifying your Google account and preparing your ${BRAND} session.`, 1700],
      ['check', 'Sign in complete', `Your Google account is verified. Loading your ${BRAND} profile.`, 1500],
      ['check', 'Welcome back, Eko Syaepulloh Qa', `Everything is ready. Taking you to ${BRAND} now.`, 2300,
        ['Google account verified', `${BRAND} session created`, 'Profile loaded']],
    ],
  };

  function renderStatus([kind, title, desc, , list]) {
    $('#st-visual').innerHTML = kind === 'spin'
      ? '<span class="ring-spin" role="progressbar" aria-label="Loading"></span>'
      : '<span class="ok-badge" aria-hidden="true">✓</span>';
    $('#st-title').textContent = title;
    $('#st-desc').textContent = desc;
    const ul = $('#st-list');
    ul.innerHTML = '';
    (list || []).forEach((t, i) => {
      const li = document.createElement('li');
      li.textContent = t;
      li.style.animationDelay = (150 + i * 140) + 'ms';
      ul.appendChild(li);
    });
    restartAnim($('#st-card'), 'swap');
  }

  async function runStatusFlow(kind) {
    show('scr-status');
    for (const s of FLOWS[kind]) { renderStatus(s); await wait(s[3]); }
    goDashboard(kind === 'google' ? 'google' : null);
  }

  /* =========================================================
     Dashboard: tours (app-to-app), session banner, import dialog
     ========================================================= */
  const TOURS = [
    { t: 'Batur Caldera Rim Trail', m: 'Bali, Indonesia', d: '8.4 km', v: '2.4k', h: 205 },
    { t: 'Rinjani Summit Route', m: 'Lombok, Indonesia', d: '41.2 km', v: '1.9k', h: 160 },
    { t: 'Komodo Island Explorer', m: 'NTT, Indonesia', d: '18.6 km', v: '3.1k', h: 185 },
    { t: 'Taman Nasional Baluran', m: 'East Java, Indonesia', d: '12.4 km', v: '860', h: 95 },
    { t: 'Ijen Crater Trail', m: 'East Java, Indonesia', d: '14.1 km', v: '4.7k', h: 215 },
    { t: 'Borobudur Sunrise Walk', m: 'Central Java, Indonesia', d: '3.2 km', v: '5.2k', h: 30 },
  ];
  const thumb = (h, extra = '') =>
    `<div class="thumb" style="--h:${h}"><svg><use href="#ill-mountains"/></svg>${extra}</div>`;

  function renderTours() {
    const grid = $('#tour-grid');
    const pill = $('#sync-pill');
    const s = state.a2a;
    $('#stale-banner').hidden = s !== 'stale';
    const pills = {
      live: ['live', '● Live sync'],
      stale: ['stale', '● Cached'],
      empty: ['off', '● Setting up'],
      unavailable: ['off', '● Paused'],
    };
    pill.dataset.tone = pills[s][0];
    pill.textContent = pills[s][1];

    if (s === 'live' || s === 'stale') {
      grid.className = 'tour-grid';
      grid.innerHTML = TOURS.map((x, i) => `
        <article class="tour" style="animation-delay:${i * 50}ms">
          ${thumb(x.h, '<span class="b360">360°</span>' + (s === 'stale' ? '<span class="cache-tag">Cached</span>' : ''))}
          <div class="tour-body"><h3>${x.t}</h3><p><span>${x.d} · ${x.m}</span><span>${x.v} views</span></p></div>
        </article>`).join('');
    } else if (s === 'empty') {
      grid.className = '';
      grid.innerHTML = `
        <div class="empty">
          <div class="imp-ill" aria-hidden="true"><svg class="i big"><use href="#i-compass"/></svg></div>
          <h3>You don't have any tours yet</h3>
          <p>Looks like you haven't created any tours on GoThru yet. Your account is still being set up. Tours will appear once sync completes.</p>
          <div class="acts"><button class="btn btn-primary btn-sm" type="button"><svg class="i"><use href="#i-external"/></svg> Create on GoThru</button><button class="btn btn-secondary btn-sm" type="button"><svg class="i"><use href="#i-link"/></svg> Add link instead</button></div>
        </div>`;
    } else {
      grid.className = '';
      grid.innerHTML = `
        <div class="empty">
          <div class="imp-ill warn" aria-hidden="true"><svg class="i big"><use href="#i-map"/></svg><span class="imp-badge bang">!</span></div>
          <h3>Your content isn't available right now</h3>
          <p>You can try again or add a GoThru tour link instead.</p>
          <div class="acts"><button class="btn btn-primary btn-sm" type="button" data-retry-tours><svg class="i"><use href="#i-refresh"/></svg> Try again</button><button class="btn btn-secondary btn-sm" type="button"><svg class="i"><use href="#i-link"/></svg> Add link instead</button></div>
        </div>`;
    }
  }

  function goDashboard(via) {
    closeOverlay();
    show('scr-dashboard');
    renderTours();
    const chip = $('#db-session-chip');
    chip.hidden = !via;
    if (via === 'magic') {
      chip.textContent = 'Emergency session · Magic Link';
      toast('Logged in via emergency email link. Work normally.');
    } else if (via === 'google') {
      chip.textContent = 'Emergency session · Google';
      toast('Signed in with Google while GoThru SSO is under maintenance. Work normally.');
    }
    setSsoHealth(keycloakUp() && !via);
  }

  function setSsoHealth(up) {
    $('#sso-health').textContent = up ? 'Connected' : 'Maintenance';
    $('#health-dot').classList.toggle('down', !up);
  }

  /* Toast */
  let toastTimer = 0;
  function toast(msg) {
    $('#toast-msg').textContent = msg;
    $('#toast').classList.add('is-on');
    stop(toastTimer);
    toastTimer = later(hideToast, 6500);
  }
  function hideToast() { $('#toast').classList.remove('is-on'); }

  /* Active session: background refresh fails → keep session, banner, backoff 5s/15s/30s */
  const banner = $('#session-banner');
  function simulateSessionOutage() {
    if (!$('#scr-dashboard').classList.contains('is-active')) goDashboard(null);
    state.sess = { attempt: 0, until: Date.now() + scaled(45000) };
    banner.dataset.tone = 'warn';
    $('#sb-title').textContent = 'Authentication service is temporarily unavailable. Your active session remains functional.';
    $('#sb-sub').textContent = 'You can continue reading your data, but new changes or re-authentications may be delayed.';
    banner.classList.add('is-on');
    setSsoHealth(false);
    sessionTry();
  }
  async function sessionTry() {
    if (!state.sess) return;
    stop(state.sessTick);
    $('#sb-meta').textContent = 'Refreshing session…';
    await wait(600);
    if (!state.sess) return;
    if (Date.now() >= state.sess.until) {
      banner.dataset.tone = 'ok';
      $('#sb-title').textContent = 'Authentication service restored.';
      $('#sb-sub').textContent = 'Your session was refreshed silently. Nothing was lost.';
      setSsoHealth(true);
      state.sess = null;
      later(() => banner.classList.remove('is-on'), 5000);
      return;
    }
    const delays = [5, 15, 30];
    let left = delays[Math.min(state.sess.attempt, 2)];
    state.sess.attempt++;
    const label = () => `Attempt ${state.sess.attempt} failed · retrying in ${left}s`;
    $('#sb-meta').textContent = label();
    state.sessTick = every(() => {
      left--;
      if (left <= 0) { stop(state.sessTick); sessionTry(); }
      else $('#sb-meta').textContent = label();
    }, scaled(1000));
  }

  /* Import dialog (App-to-App data exchange) */
  const impOverlay = $('#import-overlay');
  const impModal = $('#modal-import');
  function openImport() {
    impOverlay.classList.add('is-open');
    focusTitle(impModal);
    loadImport();
  }
  function closeImport() { impOverlay.classList.remove('is-open'); }
  async function loadImport() {
    impModal.dataset.state = 'loading';
    impModal.dataset.a2a = state.a2a;
    await wait(1400);
    const map = { live: 'list', stale: 'list', empty: 'empty', unavailable: 'unavailable' };
    impModal.dataset.state = map[state.a2a];
    if (map[state.a2a] === 'list') renderImportList();
  }
  function renderImportList() {
    $('#imp-list').innerHTML = TOURS.map((x, i) => `
      <label class="imp-item">
        ${thumb(x.h)}
        <span><b>${x.t}</b><small>${x.d} · ${x.m}</small></span>
        <input type="radio" name="imp-pick" value="${i}">
      </label>`).join('');
    const sel = $('#imp-select');
    sel.disabled = true;
    sel.textContent = 'Select';
  }

  /* =========================================================
     Prototype controls + jumps
     ========================================================= */
  function resetAll() {
    clearAll();
    closeOverlay();
    closeImport();
    hideToast();
    banner.classList.remove('is-on');
    state.sess = null;
    resetBtn($('#login-button'));
    resetBtn($('#btn-retry'));
    resetBtn($('#btn-magic-link'));
    resetBtn($('#gt-submit'));
    $('#gt-submit').disabled = !$('#gt-agree').checked;
    $('#probe-hint').textContent = '';
    clearMagicMsg();
  }
  const demoEmail = () => { state.email = state.email || 'eko@gothru.co'; $('#magic-link-email').value = state.email; };

  const JUMPS = {
    gate: openGate,
    preflight: () => { runPreflight().then(ok => { if (!ok) { show('scr-app'); showMaintenance({ fallback: true }); } else goRedirect(); }); },
    'pf-ok': showPreflightOk,
    redirect: goRedirect,
    'gt-login': () => show('scr-gothru-login'),
    'st-completing': () => { show('scr-status'); renderStatus(FLOWS.sso[0]); },
    'st-complete': () => { show('scr-status'); renderStatus(FLOWS.sso[1]); },
    'st-welcome': () => { show('scr-status'); renderStatus(FLOWS.sso[2]); },
    'maint-poll': () => { show('scr-app'); showMaintenance(); },
    'maint-recovered': () => { show('scr-app'); showMaintenance(); fillAttempt(1, 0); recovered({ redirect: false }); },
    'maint-fallback': () => { show('scr-app'); showMaintenance({ fallback: true }); },
    google: () => runStatusFlow('google'),
    'ml-sent': () => { demoEmail(); show('scr-app'); showSent(false); },
    'ml-resent': () => { demoEmail(); show('scr-app'); showSent(true); },
    'ml-429': () => { demoEmail(); show('scr-app'); showMaintenance({ fallback: true }); demoEmail(); setMagicMsg('warn', 'Too many requests. Please wait a few minutes before trying again.'); },
    email: () => { demoEmail(); goEmail(); },
    'vf-verifying': () => { show('scr-verify'); setVView('verifying'); resetSteps(); step(0, 'done'); step(1, 'active'); },
    'vf-success': () => { show('scr-verify'); setVView('success'); },
    'vf-used': () => { show('scr-verify'); showVerifyError('used'); },
    'vf-expired': () => { show('scr-verify'); showVerifyError('expired'); },
    'db-magic': () => goDashboard('magic'),
    'db-session': () => { goDashboard(null); simulateSessionOutage(); },
    import: () => { goDashboard(null); openImport(); },
  };
  function jump(key) {
    resetAll();
    if (key === 'gate') state.outageStart = 0;
    JUMPS[key]();
    if (window.matchMedia('(max-width: 560px)').matches) togglePanel(false);
  }

  const panel = $('#proto-panel');
  const fab = $('#proto-fab');
  function togglePanel(force) {
    const open = force ?? !panel.classList.contains('is-open');
    panel.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', String(open));
  }

  /* =========================================================
     Wire up
     ========================================================= */
  $$('[data-open-gate]').forEach(b => b.addEventListener('click', openGate));
  $$('[data-close-overlay]').forEach(b => b.addEventListener('click', closeOverlay));
  $('#login-button').addEventListener('click', handleLoginClick);
  $('#btn-retry').addEventListener('click', retryNow);
  $('#btn-dismiss').addEventListener('click', dismissMaintenance);
  $('#btn-google-fallback').addEventListener('click', handleLocalGoogleLogin);
  $('#magic-link-form').addEventListener('submit', handleSendMagicLink);
  $('#magic-link-email').addEventListener('input', clearMagicMsg);
  $('#btn-open-mail').addEventListener('click', goEmail);
  $('#btn-resend').addEventListener('click', resend);
  $('#btn-diff-email').addEventListener('click', () => useDifferentEmail(''));
  $('#ml-back').addEventListener('click', () => useDifferentEmail(state.email));

  $('#mail-back').addEventListener('click', () => { show('scr-app'); openOverlay('maint'); });
  $('#mail-signin').addEventListener('click', goVerify);
  $('#vf-continue').addEventListener('click', () => goDashboard('magic'));
  $('#vf-new').addEventListener('click', () => useDifferentEmail(state.email));
  $('#vf-diff').addEventListener('click', () => useDifferentEmail(''));

  // GoThru login (original)
  const agree = $('#gt-agree');
  agree.addEventListener('change', () => { $('#gt-submit').disabled = !agree.checked; });
  $('#gt-eye').addEventListener('click', e => {
    const p = $('#gt-pass');
    const showPw = p.type === 'password';
    p.type = showPw ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-label', showPw ? 'Hide password' : 'Show password');
  });
  $('#gt-pass').addEventListener('input', () => { $('#gt-err').hidden = true; $('#gt-pass').removeAttribute('aria-invalid'); });
  $('#gt-form').addEventListener('submit', e => {
    e.preventDefault();
    const p = $('#gt-pass');
    if (!p.value) { $('#gt-err').hidden = false; p.setAttribute('aria-invalid', 'true'); p.focus(); return; }
    const btn = $('#gt-submit');
    setBtnLoading(btn, 'Signing in...');
    later(() => { resetBtn(btn); runStatusFlow('sso'); }, 700);
  });
  $('#gt-google').addEventListener('click', () => runStatusFlow('sso'));

  // Dashboard
  $('#sb-retry').addEventListener('click', sessionTry);
  $('#toast-x').addEventListener('click', hideToast);
  $('#btn-import').addEventListener('click', openImport);
  $$('[data-close-import]').forEach(b => b.addEventListener('click', closeImport));
  $('#imp-retry').addEventListener('click', loadImport);
  $('#imp-list').addEventListener('change', () => {
    const sel = $('#imp-select');
    sel.disabled = false;
    sel.textContent = 'Select (1)';
  });
  $('#imp-select').addEventListener('click', () => {
    const picked = $('input[name="imp-pick"]:checked');
    closeImport();
    if (picked) toast(`“${TOURS[picked.value].t}” added to your post.`);
  });
  $('#tour-grid').addEventListener('click', e => {
    if (!e.target.closest('[data-retry-tours]')) return;
    $('#tour-grid').innerHTML = '<div class="empty"><span class="spin" style="color:var(--blue);width:22px;height:22px"></span><p style="margin:12px auto 0">Reconnecting to GoThru Dashboard…</p></div>';
    later(renderTours, 1200);
  });

  // Prototype panel
  fab.addEventListener('click', () => togglePanel());
  $('#proto-close').addEventListener('click', () => togglePanel(false));
  $$('input[name="scenario"]').forEach(r => r.addEventListener('change', () => { state.scenario = r.value; state.outageStart = 0; }));
  $$('input[name="speed"]').forEach(r => r.addEventListener('change', () => { state.speed = Number(r.value); }));
  $$('input[name="link"]').forEach(r => r.addEventListener('change', () => { state.linkMode = r.value; }));
  $('#pp-neterr').addEventListener('change', e => { state.netError = e.target.checked; });
  $('#pp-a2a').addEventListener('change', e => {
    state.a2a = e.target.value;
    if ($('#scr-dashboard').classList.contains('is-active')) renderTours();
  });
  $('#pp-restart-kc').addEventListener('click', () => { if (window.matchMedia('(max-width: 560px)').matches) togglePanel(false); simulateSessionOutage(); });
  $$('[data-jump]').forEach(b => b.addEventListener('click', () => jump(b.dataset.jump)));
  $('#pp-reset').addEventListener('click', () => { state.sends = {}; state.email = ''; state.linkUsed = false; $('#magic-link-email').value = ''; jump('gate'); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (panel.classList.contains('is-open')) return togglePanel(false);
    if (impOverlay.classList.contains('is-open')) return closeImport();
    if (overlay.classList.contains('is-open')) {
      if (overlay.dataset.view === 'maint') dismissMaintenance(); else closeOverlay();
    }
  });
  // Click on backdrop closes the original gate only (maintenance needs explicit Dismiss)
  overlay.addEventListener('click', e => { if (e.target === overlay && overlay.dataset.view === 'gate') closeOverlay(); });
  impOverlay.addEventListener('click', e => { if (e.target === impOverlay) closeImport(); });

  // Start: Panorra page with original "Log in to continue" modal, or a deep link (e.g. index.html#maint-fallback)
  const hash = location.hash.slice(1);
  if (JUMPS[hash]) jump(hash); else openGate();
})();
