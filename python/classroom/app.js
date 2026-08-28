/* app.js – Python Classroom main application logic */
/* global PyodideWorkerManager */

(function () {
  'use strict';

  // === Configuration ===
  // Vendored Pyodide lives next to this file (same origin, no CORS)
  // NOTE: the 3.14 build dropped classic-worker support -> use the ESM entry point
  const PYODIDE_URL = new URL('vendor/pyodide/314.0.6/pyodide/pyodide.mjs', location.href).href;
  // Worker file — must be a real URL (not a Blob) so relative imports resolve
  const WORKER_URL  = new URL('pyodide-worker.js', location.href).href;
  // Exercise content lives in the Page repo (custom class content), not here.
  // Override with ?ex=<base-url> (e.g. ?ex=http://localhost:8002/class/python-exercices)
  // Same origin as this app (www.tinmarino.com serves both / and /app/)
  const EXERCISES_DEFAULT = '/class/python-exercices';
  const EXERCISES_BASE = (new URLSearchParams(location.search).get('ex') || EXERCISES_DEFAULT)
    .replace(/\/$/, '');
  const MANIFEST_URL = EXERCISES_BASE + '/manifest.json';
  // S3 bucket (lowercase required)
  const S3_BUCKET = 'python-exercices';
  const S3_REGION = 'us-east-1';
  const COOKIE_KEY = 'py_classroom_creds';
  // localStorage keys: current editor buffer, and the last code that passed the tests
  const CODE_PREFIX   = 'py_ex_';
  const SOLVED_PREFIX = 'py_solved_';

  // === State ===
  let exercises = [];
  let currentExercise = null;
  let workerMgr = null;
  // consoleHistory kept in consoleCmdHistory below

  // === DOM refs ===
  const $list = document.getElementById('exercise-list');
  const $title = document.getElementById('exercise-title');
  const $editor = document.getElementById('editor');
  const $highlightPre = document.getElementById('editor-highlight');
  const $highlight = $highlightPre.querySelector('code');
  const $output = document.getElementById('output');
  const $testsOutput = document.getElementById('tests-output');
  const $consoleHistory = document.getElementById('console-history');
  const $consoleInput = document.getElementById('console-input');
  const $consolePrompt = document.getElementById('console-prompt');
  const $btnRun = document.getElementById('btn-run');
  const $btnCheck = document.getElementById('btn-check');
  const $btnReset = document.getElementById('btn-reset');
  const $btnConsole = document.getElementById('btn-console');
  const $btnLogin = document.getElementById('btn-login');
  const $btnPush = document.getElementById('btn-push');
  const $btnDownload = document.getElementById('btn-download');
  const $syncStatus = document.getElementById('sync-status');
  const $loginModal = document.getElementById('login-modal');
  const $loginUser = document.getElementById('login-user');
  const $loginPass = document.getElementById('login-pass');
  const $loginOk = document.getElementById('login-ok');
  const $loginCancel = document.getElementById('login-cancel');
  const $loginError = document.getElementById('login-error');

  // === Syntax highlighting ===============================================
  // Repaint the <pre> underneath the transparent textarea. A trailing newline
  // is padded so the last line keeps its height and the layers stay aligned.
  function repaint() {
    const code = $editor.value;
    if (window.Prism && Prism.languages.python) {
      $highlight.innerHTML = Prism.highlight(code + '\n', Prism.languages.python, 'python');
    } else {
      $highlight.textContent = code + '\n';   // graceful fallback: plain text
    }
    syncScroll();
  }
  function syncScroll() {
    $highlightPre.scrollTop  = $editor.scrollTop;
    $highlightPre.scrollLeft = $editor.scrollLeft;
  }
  $editor.addEventListener('scroll', syncScroll);
  if (!window.Prism) {
    // Prism failed to load: show the text instead of an invisible textarea
    $editor.style.color = 'var(--gb-light0)';
  }

  // === Draggable splitters ===============================================
  // Generic pointer-drag resizer. `apply(px)` writes the new size, and the
  // result is clamped so neither pane can be dragged out of existence.
  function makeSplitter(handle, opts) {
    const { key, vertical, getSize, setSize, min, maxFn, dflt } = opts;

    const saved = parseFloat(localStorage.getItem(key));
    if (!isNaN(saved)) setSize(clamp(saved));

    function clamp(px) { return Math.max(min, Math.min(px, maxFn())); }

    handle.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const start    = vertical ? ev.clientX : ev.clientY;
      const startPx  = getSize();
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      const onMove = e => {
        const delta = (vertical ? e.clientX : e.clientY) - start;
        setSize(clamp(startPx + delta * opts.sign));
      };
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        localStorage.setItem(key, String(getSize()));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });

    // Double-click resets, arrows nudge when focused (keyboard accessible)
    handle.addEventListener('dblclick', () => {
      setSize(dflt);
      localStorage.setItem(key, String(dflt));
    });
    handle.addEventListener('keydown', e => {
      const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
      const inc = vertical ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== dec && e.key !== inc) return;
      e.preventDefault();
      const step = (e.key === inc ? 1 : -1) * (e.shiftKey ? 40 : 10) * opts.sign;
      setSize(clamp(getSize() + step));
      localStorage.setItem(key, String(getSize()));
    });
  }

  const $sidebar = document.getElementById('sidebar');
  const $outputArea = document.getElementById('output-area');

  makeSplitter(document.getElementById('splitter-x'), {
    key: 'py_w_sidebar', vertical: true, sign: 1, dflt: 260, min: 140,
    getSize: () => $sidebar.getBoundingClientRect().width,
    setSize: px => { $sidebar.style.width = px + 'px'; },
    maxFn:   () => Math.max(140, window.innerWidth - 320)
  });

  makeSplitter(document.getElementById('splitter-y'), {
    // Dragging down must shrink the output pane, hence sign -1
    key: 'py_h_output', vertical: false, sign: -1, dflt: 240, min: 80,
    getSize: () => $outputArea.getBoundingClientRect().height,
    setSize: px => { $outputArea.style.height = px + 'px'; syncScroll(); },
    maxFn:   () => Math.max(80, window.innerHeight - 220)
  });

  // === Tabs ===
  document.querySelectorAll('#output-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#output-tabs .tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab + '-pane').classList.add('active');
    });
  });

  // === Init Pyodide Worker ===
  function initWorker() {
    workerMgr = new PyodideWorkerManager(PYODIDE_URL, WORKER_URL);
    workerMgr.init();
    workerMgr.readyPromise.then(() => {
      $output.textContent = 'Python ready. Click an exercise to start.\n';
    }).catch(err => {
      $output.textContent = 'Python failed to load: ' + err + '\n';
    });
  }

  // === Load exercises manifest ===
  async function loadManifest() {
    try {
      const resp = await fetch(MANIFEST_URL);
      exercises = await resp.json();
    } catch (e) {
      exercises = [];
      console.error('Cannot load exercise manifest:', e);
      $syncStatus.textContent = 'Could not load the exercise list from ' + EXERCISES_BASE;
    }
    renderExerciseList();
  }

  function renderExerciseList() {
    $list.innerHTML = '';
    const done = getDoneList();
    exercises.forEach((ex, idx) => {
      const li = document.createElement('li');
      li.textContent = ex.title;
      if (done.includes(ex.id)) li.classList.add('done');
      li.addEventListener('click', () => selectExercise(idx));
      $list.appendChild(li);
    });
  }

  async function selectExercise(idx) {
    currentExercise = exercises[idx];
    // Highlight active
    $list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === idx));
    $title.textContent = currentExercise.title;

    // Load exercise markdown/content
    try {
      const resp = await fetch(EXERCISES_BASE + '/' + currentExercise.file);
      const text = await resp.text();
      const parsed = parseExercise(text);
      currentExercise._parsed = parsed;

      // Load saved code or template
      const saved = localStorage.getItem(CODE_PREFIX + currentExercise.id);
      $editor.value = saved || parsed.template;
      repaint();
    } catch (e) {
      $editor.value = '# Error loading exercise\n';
      repaint();
      console.error(e);
    }

    $output.textContent = '';
    $testsOutput.textContent = '';
  }

  // === Parse exercise markdown ===
  function parseExercise(md) {
    const res = { description: '', template: '', tests: '', hints: '' };
    // Extract fenced code blocks by label
    const templateMatch = md.match(/```python\s*#\s*template\s*\n([\s\S]*?)```/);
    if (templateMatch) res.template = templateMatch[1].trimEnd() + '\n';
    const testsMatch = md.match(/```python\s*#\s*tests?\s*\n([\s\S]*?)```/);
    if (testsMatch) res.tests = testsMatch[1].trimEnd() + '\n';
    // Description is everything before the first code block
    const firstFence = md.indexOf('```');
    if (firstFence > 0) res.description = md.slice(0, firstFence).trim();
    else res.description = md.trim();
    return res;
  }

  // === Run ===
  async function runCode() {
    const code = $editor.value;
    localStorage.setItem(CODE_PREFIX + (currentExercise ? currentExercise.id : '_scratch'), code);
    $output.textContent = 'Running...\n';
    switchTab('output');

    const result = await workerMgr.run(code);
    let out = '';
    if (result.stdout) out += result.stdout + '\n';
    if (result.stderr) out += result.stderr + '\n';
    if (result.error) out += '--- Error ---\n' + result.error + '\n';
    $output.textContent = out || '(no output)\n';
  }

  // === Check (run tests) ===
  async function checkCode() {
    if (!currentExercise || !currentExercise._parsed || !currentExercise._parsed.tests) {
      $testsOutput.textContent = 'No tests defined for this exercise.\n';
      switchTab('tests');
      return;
    }
    const code = $editor.value + '\n' + currentExercise._parsed.tests;
    $testsOutput.textContent = 'Checking...\n';
    switchTab('tests');

    const result = await workerMgr.run(code);
    let out = '';
    if (result.stdout) out += result.stdout + '\n';
    if (result.stderr) out += result.stderr + '\n';
    if (result.error) {
      out += '--- FAIL ---\n' + result.error + '\n';
    } else {
      out += '--- ALL TESTS PASSED ---\n';
      // Remember the code that actually passed, so Download/Submit report real work
      localStorage.setItem(SOLVED_PREFIX + currentExercise.id, $editor.value);
      markDone(currentExercise.id);
    }
    $testsOutput.textContent = out;
  }

  // === Reset ===
  function resetCode() {
    if (!currentExercise) return;
    if (!confirm('Reset to the original template?')) return;
    $editor.value = currentExercise._parsed.template;
    repaint();
    localStorage.removeItem(CODE_PREFIX + currentExercise.id);
    // The passing solution and the green check are kept on purpose
  }

  // === Interactive Console (REPL) ===
  let consoleCmdHistory = [];
  let consoleHistoryIdx = -1;

  function switchTab(name) {
    document.querySelectorAll('#output-tabs .tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-content').forEach(p => {
      p.classList.toggle('active', p.id === name + '-pane');
    });
  }

  function appendConsole(text, cls) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\n';
    $consoleHistory.appendChild(span);
    $consoleHistory.scrollTop = $consoleHistory.scrollHeight;
  }

  // A block is unfinished while brackets are open or the last meaningful line
  // opens an indented suite (ends with ':'), mirroring the real REPL.
  function isIncomplete(src) {
    let depth = 0, quote = null;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    }
    if (depth > 0 || quote) return true;

    const lines = src.split('\n');
    const last = lines[lines.length - 1];
    // Inside a suite: a blank line closes it, anything indented continues it
    if (last.trim() === '') return false;
    if (/:\s*(#.*)?$/.test(last)) return true;
    if (/\\$/.test(last)) return true;
    return lines.length > 1 && /^\s+/.test(last);
  }

  // Indentation the next line should start with
  function nextIndent(src) {
    const last = src.split('\n').pop();
    const base = (last.match(/^\s*/) || [''])[0];
    return /:\s*(#.*)?$/.test(last) ? base + '    ' : base;
  }

  function autoGrow() {
    $consoleInput.style.height = 'auto';
    $consoleInput.style.height = $consoleInput.scrollHeight + 'px';
  }

  async function handleConsoleInput(line) {
    if (!line.trim()) return;
    consoleCmdHistory.push(line);
    consoleHistoryIdx = consoleCmdHistory.length;
    // Echo like a REPL: '>>>' on the first line, '...' on continuations
    line.split('\n').forEach((l, i) => {
      appendConsole((i === 0 ? '>>> ' : '... ') + l, i === 0 ? null : 'continuation');
    });

    const result = await workerMgr.runConsole(line);
    if (result.stdout) appendConsole(result.stdout);
    if (result.result && result.result !== 'None') appendConsole(result.result);
    if (result.stderr) appendConsole(result.stderr, 'error');
    if (result.error) appendConsole(result.error, 'error');
  }

  function submitConsole() {
    const code = $consoleInput.value;
    $consoleInput.value = '';
    $consolePrompt.innerHTML = '&gt;&gt;&gt;&nbsp;';
    autoGrow();
    return handleConsoleInput(code);
  }

  function insertNewline() {
    const v = $consoleInput.value;
    const at = $consoleInput.selectionStart;
    const ins = '\n' + nextIndent(v.slice(0, at));
    $consoleInput.value = v.slice(0, at) + ins + v.slice($consoleInput.selectionEnd);
    $consoleInput.selectionStart = $consoleInput.selectionEnd = at + ins.length;
    $consolePrompt.innerHTML = '...&nbsp;';
    autoGrow();
  }

  $consoleInput.addEventListener('input', autoGrow);

  $consoleInput.addEventListener('keydown', async (e) => {
    const val = $consoleInput.value;
    const multiline = val.includes('\n');

    if (e.key === 'Enter') {
      e.preventDefault();
      // Ctrl/Cmd+Enter always runs, even an unfinished block
      if (e.ctrlKey || e.metaKey) { await submitConsole(); return; }
      // Shift+Enter always adds a line
      if (e.shiftKey) { insertNewline(); return; }
      // Otherwise follow the REPL rule: keep editing while the block is open
      if (isIncomplete(val)) { insertNewline(); return; }
      await submitConsole();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const at = $consoleInput.selectionStart;
      $consoleInput.value = val.slice(0, at) + '    ' + val.slice($consoleInput.selectionEnd);
      $consoleInput.selectionStart = $consoleInput.selectionEnd = at + 4;
      autoGrow();
      return;
    }

    // History recall only when it cannot fight with cursor movement
    if (e.key === 'ArrowUp' && !multiline) {
      e.preventDefault();
      if (consoleHistoryIdx > 0) {
        consoleHistoryIdx--;
        $consoleInput.value = consoleCmdHistory[consoleHistoryIdx];
        autoGrow();
      }
    } else if (e.key === 'ArrowDown' && !multiline) {
      e.preventDefault();
      if (consoleHistoryIdx < consoleCmdHistory.length - 1) {
        consoleHistoryIdx++;
        $consoleInput.value = consoleCmdHistory[consoleHistoryIdx];
      } else {
        consoleHistoryIdx = consoleCmdHistory.length;
        $consoleInput.value = '';
      }
      autoGrow();
    }
  });

  // === Done list (localStorage) ===
  function getDoneList() {
    try { return JSON.parse(localStorage.getItem('py_done') || '[]'); }
    catch { return []; }
  }
  function markDone(id) {
    const done = getDoneList();
    if (!done.includes(id)) {
      done.push(id);
      localStorage.setItem('py_done', JSON.stringify(done));
      renderExerciseList();
    }
    refreshStatus();
  }

  function getSolved(id) { return localStorage.getItem(SOLVED_PREFIX + id); }

  // Exercises that were completed AND whose passing code we still have
  function getCompleted() {
    return exercises.filter(ex => getDoneList().includes(ex.id) && getSolved(ex.id));
  }

  // Reflect local (no-login) state in the UI
  function refreshStatus() {
    const n = getCompleted().length;
    $btnDownload.disabled = n === 0;
    const creds = getCreds();
    const who = creds ? ' Logged in as ' + (creds.username || 'anonymous') + '.' : '';
    $syncStatus.textContent = n
      ? n + ' of ' + exercises.length + ' completed, saved in this browser.' + who
      : 'Progress is saved in this browser.' + who;
  }

  // ===============================
  // === Download as Markdown ===
  // ===============================

  function buildMarkdown() {
    const completed = getCompleted();
    const creds = getCreds();
    const lines = [
      '# Python Exercises',
      '',
      (creds && creds.username ? 'Student: ' + creds.username : 'Student: (not logged in)'),
      'Date: ' + new Date().toISOString().slice(0, 10),
      'Completed: ' + completed.length + ' of ' + exercises.length,
      ''
    ];
    completed.forEach(ex => {
      lines.push('### ' + ex.title, '', '```python', getSolved(ex.id).trimEnd(), '```', '');
    });
    return lines.join('\n');
  }

  function downloadMarkdown() {
    if (!getCompleted().length) return;
    const creds = getCreds();
    const who = (creds && creds.username ? creds.username : 'student').replace(/[^\w.-]+/g, '_');
    const name = 'python-exercices-' + who + '-' + new Date().toISOString().slice(0, 10) + '.md';
    const blob = new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ===============================
  // === AWS S3 Push / Login ===
  // ===============================
  // Everything above works with no credentials at all. The AWS part below is
  // strictly additive: it only submits what is already stored locally.

  function getCreds() {
    try {
      const raw = getCookie(COOKIE_KEY);
      if (!raw) return null;
      return JSON.parse(atob(raw));
    } catch { return null; }
  }
  function setCreds(creds) {
    // Store base64-encoded JSON in a cookie (30 days)
    const val = btoa(JSON.stringify(creds));
    document.cookie = COOKIE_KEY + '=' + val + '; path=/; max-age=' + (30*86400) + '; SameSite=Strict';
    $btnPush.disabled = false;
    refreshStatus();
  }
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Derive AES key from password (PBKDF2)
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Decrypt the AWS credentials blob stored locally
  async function decryptCreds(password, _username) { // _username reserved for future per-user salt
    // The encrypted blob is fetched from a known path (generated offline)
    const resp = await fetch('aws-config.enc.json');
    if (!resp.ok) throw new Error('aws-config.enc.json not found. Generate it with gen-aws-config.js');
    const blob = await resp.json(); // { iv, salt, ciphertext } all base64
    const key = await deriveKey(password, blob.salt);
    const iv = Uint8Array.from(atob(blob.iv), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(blob.ciphertext), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // S3 PutObject with SigV4 (minimal implementation)
  async function s3Put(creds, key, body) {
    const host = S3_BUCKET + '.s3.' + S3_REGION + '.amazonaws.com';
    const url = 'https://' + host + '/' + key;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+/, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = await sha256hex(body);

    const headers = {
      'Host': host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Content-Type': 'application/json',
    };

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');

    const canonicalHeadersStr = signedHeaderKeys.map(k => {
      // Find the original header
      for (const orig of Object.keys(headers)) {
        if (orig.toLowerCase() === k) return k + ':' + headers[orig].trim();
      }
      return '';
    }).join('\n') + '\n';

    // C3 fix: URI-encode path segments for valid canonical request
    const canonicalUri = '/' + key.split('/').map(encodeURIComponent).join('/');
    const canonicalRequest = [
      'PUT', canonicalUri, '',
      canonicalHeadersStr,
      signedHeaders,
      payloadHash
    ].join('\n');

    const credentialScope = dateStamp + '/' + S3_REGION + '/s3/aws4_request';
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256hex(canonicalRequest)
    ].join('\n');

    const signingKey = await getSignatureKey(creds.secretAccessKey, dateStamp, S3_REGION, 's3');
    const signature = await hmacHex(signingKey, stringToSign);

    const authHeader = 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + credentialScope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const fetchHeaders = { ...headers, 'Authorization': authHeader };

    const resp = await fetch(url, { method: 'PUT', headers: fetchHeaders, body });
    if (!resp.ok) throw new Error('S3 PUT failed: ' + resp.status + ' ' + await resp.text());
    return true;
  }

  async function sha256hex(msg) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(msg));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hmac(key, msg) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg)));
  }

  async function hmacHex(key, msg) {
    const sig = await hmac(key, msg);
    return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getSignatureKey(secretKey, dateStamp, region, service) {
    const enc = new TextEncoder();
    let k = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
    k = await hmac(k, region);
    k = await hmac(k, service);
    k = await hmac(k, 'aws4_request');
    return k;
  }

  // === Push progress ===
  async function pushProgress() {
    const creds = getCreds();
    if (!creds) { showLogin(); return; }

    const progress = {
      done: getDoneList(),
      exercises: {},   // current editor buffer
      solved: {}       // code that actually passed the tests
    };
    exercises.forEach(ex => {
      const saved = localStorage.getItem(CODE_PREFIX + ex.id);
      if (saved) progress.exercises[ex.id] = saved;
      const solved = getSolved(ex.id);
      if (solved) progress.solved[ex.id] = solved;
    });
    progress.markdown = buildMarkdown();

    const username = creds.username || 'anonymous';
    const key = 'progress/' + username + '.json';
    const body = JSON.stringify(progress, null, 2);

    try {
      await s3Put(creds, key, body);
      alert('Progress pushed successfully!');
    } catch (e) {
      alert('Push failed: ' + e.message);
      console.error(e);
    }
  }

  // === Login ===
  function showLogin() {
    $loginModal.classList.remove('hidden');
    $loginError.textContent = '';
    $loginUser.focus();
  }
  function hideLogin() { $loginModal.classList.add('hidden'); }

  async function handleLogin() {
    const user = $loginUser.value.trim();
    const pass = $loginPass.value;
    if (!user || !pass) { $loginError.textContent = 'Both fields required'; return; }

    try {
      const awsCreds = await decryptCreds(pass, user);
      setCreds({ ...awsCreds, username: user });
      hideLogin();
    } catch (e) {
      // Distinguish "submitting is not set up here" from "wrong password"
      $loginError.textContent = /not found/i.test(e.message)
        ? 'Submitting is not enabled on this server. Use Download instead.'
        : 'Wrong password.';
      console.error(e);
    }
  }

  // === Event bindings ===
  $btnRun.addEventListener('click', runCode);
  $btnCheck.addEventListener('click', checkCode);
  $btnReset.addEventListener('click', resetCode);
  $btnConsole.addEventListener('click', () => switchTab('console'));
  $btnDownload.addEventListener('click', downloadMarkdown);
  $btnLogin.addEventListener('click', showLogin);
  $btnPush.addEventListener('click', pushProgress);
  $loginOk.addEventListener('click', handleLogin);
  $loginCancel.addEventListener('click', hideLogin);
  $loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });

  // Ctrl+Enter to run
  $editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
    // Tab inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = $editor.selectionStart;
      $editor.value = $editor.value.slice(0, start) + '    ' + $editor.value.slice($editor.selectionEnd);
      $editor.selectionStart = $editor.selectionEnd = start + 4;
      repaint();
    }
  });

  // Auto-save on change
  $editor.addEventListener('input', () => {
    repaint();
    if (currentExercise) {
      localStorage.setItem(CODE_PREFIX + currentExercise.id, $editor.value);
    }
  });

  // Credentials are optional: without them everything still runs, checks,
  // marks exercises green and downloads. Only Submit needs a login.
  if (getCreds()) $btnPush.disabled = false;

  // === Boot ===
  repaint();
  initWorker();
  loadManifest().then(refreshStatus);

})();
