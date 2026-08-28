/* app.js – Python Classroom main application logic */
/* global PyodideWorkerManager */

(function () {
  'use strict';

  // === Configuration ===
  // C1 fix: absolute URL so Blob-based worker can importScripts correctly
  const PYODIDE_URL = new URL('vendor/pyodide/314.0.6/pyodide/pyodide.js', location.href).href;
  const EXERCISES_BASE = '/class/python-exercices';
  const MANIFEST_URL = EXERCISES_BASE + '/manifest.json';
  // C2 fix: S3 bucket names must be lowercase
  const S3_BUCKET = 'python-exercices';
  const S3_REGION = 'us-east-1';
  const COOKIE_KEY = 'py_classroom_creds';

  // === State ===
  let exercises = [];
  let currentExercise = null;
  let workerMgr = null;
  // consoleHistory kept in consoleCmdHistory below

  // === DOM refs ===
  const $list = document.getElementById('exercise-list');
  const $title = document.getElementById('exercise-title');
  const $editor = document.getElementById('editor');
  const $output = document.getElementById('output');
  const $testsOutput = document.getElementById('tests-output');
  const $consoleHistory = document.getElementById('console-history');
  const $consoleInput = document.getElementById('console-input');
  const $btnRun = document.getElementById('btn-run');
  const $btnCheck = document.getElementById('btn-check');
  const $btnReset = document.getElementById('btn-reset');
  const $btnConsole = document.getElementById('btn-console');
  const $btnLogin = document.getElementById('btn-login');
  const $btnPush = document.getElementById('btn-push');
  const $loginModal = document.getElementById('login-modal');
  const $loginUser = document.getElementById('login-user');
  const $loginPass = document.getElementById('login-pass');
  const $loginOk = document.getElementById('login-ok');
  const $loginCancel = document.getElementById('login-cancel');
  const $loginError = document.getElementById('login-error');

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
    workerMgr = new PyodideWorkerManager(PYODIDE_URL);
    workerMgr.init();
    workerMgr.readyPromise.then(() => {
      $output.textContent = 'Python ready.\n';
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
      const saved = localStorage.getItem('py_ex_' + currentExercise.id);
      $editor.value = saved || parsed.template;
    } catch (e) {
      $editor.value = '# Error loading exercise\n';
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
    localStorage.setItem('py_ex_' + (currentExercise ? currentExercise.id : '_scratch'), code);
    $output.textContent = 'Running...\n';
    switchTab('output');

    const result = await workerMgr.run(code, 'exec');
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

    const result = await workerMgr.run(code, 'exec');
    let out = '';
    if (result.stdout) out += result.stdout + '\n';
    if (result.stderr) out += result.stderr + '\n';
    if (result.error) {
      out += '--- FAIL ---\n' + result.error + '\n';
    } else {
      out += '--- ALL TESTS PASSED ---\n';
      markDone(currentExercise.id);
    }
    $testsOutput.textContent = out;
  }

  // === Reset ===
  function resetCode() {
    if (!currentExercise) return;
    if (!confirm('Reset to the original template?')) return;
    $editor.value = currentExercise._parsed.template;
    localStorage.removeItem('py_ex_' + currentExercise.id);
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

  async function handleConsoleInput(line) {
    if (!line.trim()) return;
    consoleCmdHistory.push(line);
    consoleHistoryIdx = consoleCmdHistory.length;
    appendConsole('>>> ' + line);

    const result = await workerMgr.runConsole(line);
    if (result.stdout) appendConsole(result.stdout);
    if (result.result && result.result !== 'None') appendConsole(result.result);
    if (result.stderr) appendConsole(result.stderr, 'error');
    if (result.error) appendConsole(result.error, 'error');
  }

  $consoleInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = $consoleInput.value;
      $consoleInput.value = '';
      await handleConsoleInput(line);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (consoleHistoryIdx > 0) {
        consoleHistoryIdx--;
        $consoleInput.value = consoleCmdHistory[consoleHistoryIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (consoleHistoryIdx < consoleCmdHistory.length - 1) {
        consoleHistoryIdx++;
        $consoleInput.value = consoleCmdHistory[consoleHistoryIdx];
      } else {
        consoleHistoryIdx = consoleCmdHistory.length;
        $consoleInput.value = '';
      }
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
  }

  // ===============================
  // === AWS S3 Push / Login ===
  // ===============================

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
      exercises: {}
    };
    exercises.forEach(ex => {
      const saved = localStorage.getItem('py_ex_' + ex.id);
      if (saved) progress.exercises[ex.id] = saved;
    });

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
      $loginError.textContent = 'Decryption failed. Wrong password?';
      console.error(e);
    }
  }

  // === Event bindings ===
  $btnRun.addEventListener('click', runCode);
  $btnCheck.addEventListener('click', checkCode);
  $btnReset.addEventListener('click', resetCode);
  $btnConsole.addEventListener('click', () => switchTab('console'));
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
    }
  });

  // Auto-save on change
  $editor.addEventListener('input', () => {
    if (currentExercise) {
      localStorage.setItem('py_ex_' + currentExercise.id, $editor.value);
    }
  });

  // Check stored creds on load
  if (getCreds()) $btnPush.disabled = false;

  // === Boot ===
  initWorker();
  loadManifest();

})();
