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
  // Keys are namespaced by exercise set: `?ex=` can point at another collection
  // whose ids ("01", "02", ...) would otherwise share this one's saved code and
  // green checkmarks.
  const SET_KEY = EXERCISES_BASE.replace(/^https?:\/\/[^/]+/, '').replace(/\W+/g, '_');
  const CODE_PREFIX   = 'py_ex_'     + SET_KEY + '_';
  const SOLVED_PREFIX = 'py_solved_' + SET_KEY + '_';
  const RUN_PREFIX    = 'py_run_'    + SET_KEY + '_';
  const DONE_KEY      = 'py_done_'   + SET_KEY;

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
  const $runArgs = document.getElementById('run-args');
  const $btnRunReset = document.getElementById('btn-run-reset');
  const $btnStop = document.getElementById('btn-stop');
  const $btnMenu = document.getElementById('btn-menu');
  const $btnDescription = document.getElementById('btn-description');
  const $btnDescriptionClose = document.getElementById('btn-description-close');
  const $descriptionPanel = document.getElementById('description-panel');
  const $descriptionBody = document.getElementById('description-body');
  const $descriptionTitle = document.getElementById('description-title');
  const $syncStatus = document.getElementById('sync-status');
  const $loginModal = document.getElementById('login-modal');
  const $loginUser = document.getElementById('login-user');
  const $loginPass = document.getElementById('login-pass');
  const $loginOk = document.getElementById('login-ok');
  const $loginCancel = document.getElementById('login-cancel');
  const $loginError = document.getElementById('login-error');

  // === Shared helpers (pyutil.js) =========================================
  // Indentation and traceback colouring live in pyutil.js so the standalone
  // shell behaves exactly the same way.
  const {
    esc, highlightPy, renderPyLine, renderOutput,
    INDENT, INDENT_N, stripLiterals, bracketDepth, indentAfter,
    smartNewline, smartBackspace
  } = window.PyUtil;

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

    let dragging = null;

    handle.addEventListener('pointerdown', ev => {
      if (dragging) return;              // one drag at a time
      ev.preventDefault();
      const start   = vertical ? ev.clientX : ev.clientY;
      const startPx = getSize();
      try { handle.setPointerCapture(ev.pointerId); } catch { /* not captured */ }
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      const onMove = e => {
        const delta = (vertical ? e.clientX : e.clientY) - start;
        setSize(clamp(startPx + delta * opts.sign));
      };
      // pointercancel and lostpointercapture must clean up too: a cancelled
      // touch gesture would otherwise leave this listener installed and the
      // next drag would run two of them over stale start values.
      const finish = () => {
        if (!dragging) return;
        dragging = null;
        try { handle.releasePointerCapture(ev.pointerId); } catch { /* gone */ }
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        localStorage.setItem(key, String(getSize()));
      };
      dragging = { finish };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    });

    // A size saved on a wide window must not squeeze the layout on a narrow one
    window.addEventListener('resize', () => setSize(clamp(getSize())));

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

  // === Mobile: swipe the sidebar in and out ===============================
  // On a narrow screen the sidebar is an overlay. Swiping right from the left
  // edge opens it, swiping left closes it. Vertical scrolling must still win,
  // so a gesture is only claimed once it is clearly horizontal.
  const SWIPE_MIN = 60;        // px of horizontal travel needed
  const SWIPE_SLOP = 40;       // max vertical drift before we let scrolling win
  const EDGE_ZONE = 40;        // px from the left edge that can start an open

  function isNarrow() { return window.matchMedia('(max-width: 700px)').matches; }

  function setSidebarOpen(open) {
    document.body.classList.toggle('sidebar-open', open);
    $btnMenu.setAttribute('aria-expanded', String(open));
  }

  let touchStart = null;
  // When this page is embedded in the site, a gesture it has nothing left to do
  // with belongs to the parent, which uses it to reveal its own left bars. A
  // cross-origin parent cannot read this frame's touch events, so forward them.
  function forwardSwipe(dir) {
    if (window.parent === window) return;
    try { window.parent.postMessage({ type: 'tinmarino-swipe', dir: dir }, '*'); }
    catch { /* nothing we can do */ }
  }

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { touchStart = null; return; }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const start = touchStart;
    touchStart = null;
    if (Math.abs(dy) > SWIPE_SLOP || Math.abs(dx) < SWIPE_MIN) return;

    // On a wide screen this page has no overlay sidebar to move, so every
    // horizontal swipe is the parent's business.
    if (!isNarrow()) { forwardSwipe(dx > 0 ? 'right' : 'left'); return; }

    const open = document.body.classList.contains('sidebar-open');
    if (dx > 0) {
      // Own sidebar first; once it is open, the gesture is the parent's
      if (!open && start.x <= EDGE_ZONE) setSidebarOpen(true);
      else forwardSwipe('right');
    } else {
      if (open) setSidebarOpen(false);
      else forwardSwipe('left');
    }
  }, { passive: true });

  // Same thing for people who are not swiping
  $btnMenu.addEventListener('click', () => {
    setSidebarOpen(!document.body.classList.contains('sidebar-open'));
  });
  const $backdrop = document.getElementById('sidebar-backdrop');
  $backdrop.addEventListener('click', () => setSidebarOpen(false));

  // Picking an exercise on a phone should get out of the way
  $list.addEventListener('click', () => { if (isNarrow()) setSidebarOpen(false); });
  window.addEventListener('resize', () => { if (!isNarrow()) setSidebarOpen(false); });

  // === Tabs ===
  const $tabs = [...document.querySelectorAll('#output-tabs .tab')];
  $tabs.forEach((btn, i) => {
    btn.addEventListener('keydown', e => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = $tabs[(i + step + $tabs.length) % $tabs.length];
      next.focus();
      next.click();
    });
  });
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
      appendConsole((workerMgr.banner || 'Python ready') +
        '\nType !help for the keys and magics.', 'help');
    }).catch(err => {
      renderOutput($output, 'Python failed to load: ' + err.message +
        '\nReload the page to try again.\n');
      appendConsole('Python failed to load: ' + err.message, 'error');
    });
  }

  // Student code runs on the worker thread, which cannot be interrupted. An
  // infinite loop therefore blocks every later request, so the only cure is to
  // kill the worker. Report that instead of leaving "Running..." on screen.
  function reportRuntimeError(target, err) {
    if (err && err.busy) {
      renderOutput(target,
        '--- BUSY ---\nPython is still running your previous command.\n' +
        'If it is stuck in an infinite loop, press Stop to restart the runtime.\n');
      $btnStop.classList.add('urgent');
      return;
    }
    renderOutput(target, '--- ERROR ---\n' +
      ((err && err.message) || String(err)) + '\n');
  }

  function stopRuntime() {
    workerMgr.terminate();
    $btnStop.classList.remove('urgent');
    $output.textContent = 'Restarting Python...\n';
    appendConsole('Runtime stopped. Restarting...', 'help');
    consoleBusy = false;
    workerMgr.init();
    workerMgr.readyPromise.then(() => {
      $output.textContent = 'Python ready.\n';
      appendConsole('Python ready. Your names were cleared.', 'help');
    }).catch(err => appendConsole('Restart failed: ' + err.message, 'error'));
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
      // Operable without a mouse: focusable, activated by Enter/Space, and
      // announced as a button rather than a bare list item.
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      if (done.includes(ex.id)) {
        li.classList.add('done');
        li.setAttribute('aria-label', ex.title + ' (completed)');
      }
      li.addEventListener('click', () => selectExercise(idx));
      li.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectExercise(idx); }
      });
      $list.appendChild(li);
    });
  }

  let selectToken = 0;

  async function selectExercise(idx) {
    const token = ++selectToken;
    const exercise = exercises[idx];
    currentExercise = exercise;
    // Highlight active
    $list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === idx));
    $title.textContent = currentExercise.title;

    // Load exercise markdown/content
    try {
      const resp = await fetch(EXERCISES_BASE + '/' + exercise.file);
      const text = await resp.text();
      // A slower earlier request must not overwrite a newer selection
      if (token !== selectToken) return;
      const parsed = parseExercise(text);
      exercise._parsed = parsed;

      // Load saved code or template
      const saved = localStorage.getItem(CODE_PREFIX + exercise.id);
      $editor.value = saved || parsed.template;
      repaint();

      if (!$descriptionPanel.classList.contains('hidden')) renderDescription();

      const savedRun = localStorage.getItem(RUN_PREFIX + exercise.id);
      $runArgs.value = savedRun !== null ? savedRun : parsed.run;
      $runArgs.disabled = false;
      autoGrowRun();
    } catch (e) {
      if (token !== selectToken) return;
      $editor.value = '# Error loading exercise\n';
      repaint();
      $runArgs.value = '';
      $runArgs.disabled = true;
      console.error(e);
    }

    $output.textContent = '';
    $testsOutput.textContent = '';
  }

  // === Parse exercise markdown ===
  function parseExercise(md) {
    const res = { description: '', template: '', tests: '', run: '', detail: '' };
    // Extract fenced code blocks by label
    const templateMatch = md.match(/```python\s*#\s*template\s*\n([\s\S]*?)```/);
    if (templateMatch) res.template = templateMatch[1].trimEnd() + '\n';
    const testsMatch = md.match(/```python\s*#\s*tests?\s*\n([\s\S]*?)```/);
    if (testsMatch) res.tests = testsMatch[1].trimEnd() + '\n';
    // How Run should exercise the student's code
    const runMatch = md.match(/```python\s*#\s*run\s*\n([\s\S]*?)```/);
    if (runMatch) res.run = runMatch[1].trim();
    // The "## Description" section: the long-form task, rendered on demand.
    // Its own headings start at h3, and are lifted to h1 when displayed.
    const detailMatch = md.match(/^##\s+Description\s*$([\s\S]*?)(?=^##\s|\Z)/m);
    if (detailMatch) res.detail = detailMatch[1].trim();

    // Description is everything before the first code block
    const firstFence = md.indexOf('```');
    if (firstFence > 0) res.description = md.slice(0, firstFence).trim();
    else res.description = md.trim();
    return res;
  }

  // === Run ===
  // The student's code defines a function; running it needs a call. That call
  // comes from the exercise's ```python # run``` block and stays editable, so
  // "Run" shows something instead of "(no output)".
  async function runCode() {
    const code = $editor.value;
    if (currentExercise) localStorage.setItem(CODE_PREFIX + currentExercise.id, code);
    const call = $runArgs.value.trim();
    const source = call ? code + '\n' + call + '\n' : code;
    $output.textContent = 'Running...\n';
    switchTab('output');

    let result;
    try {
      result = await workerMgr.run(source);
    } catch (err) {
      reportRuntimeError($output, err);
      return;
    }
    let out = '';
    if (result.stdout) out += result.stdout + '\n';
    if (result.stderr) out += result.stderr + '\n';
    if (result.error) out += '--- Error ---\n' + result.error + '\n';
    renderOutput($output, out || '(no output)\n');
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

    let result;
    try {
      result = await workerMgr.run(code);
    } catch (err) {
      reportRuntimeError($testsOutput, err);
      return;
    }
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
    renderOutput($testsOutput, out);
  }

  // === Reset ===
  function resetCode() {
    if (!currentExercise || !currentExercise._parsed) {
      renderOutput($output, '--- ERROR ---\nThis exercise did not load, nothing to reset.\n');
      switchTab('output');
      return;
    }
    if (!confirm('Reset to the original template?')) return;
    $editor.value = currentExercise._parsed.template;
    repaint();
    localStorage.removeItem(CODE_PREFIX + currentExercise.id);
    $runArgs.value = currentExercise._parsed.run;
    localStorage.removeItem(RUN_PREFIX + currentExercise.id);
    autoGrowRun();
    // The passing solution and the green check are kept on purpose
  }

  // === Interactive Console (IPython-like) =================================
  // The hard part (is this block finished? what completes this name? how does
  // this traceback read?) is delegated to pyodide.console.Console in the
  // worker, the same component the official Pyodide REPL is built on. What
  // lives here is only the terminal UX: key bindings, history, magics.
  let consoleCmdHistory = [];
  let consoleHistoryIdx = -1;
  let consoleDraft = '';          // buffer stashed while browsing history
  let consoleBusy = false;

  const HISTORY_KEY = 'py_console_history';
  const HISTORY_MAX = 200;

  function loadHistory() {
    try { consoleCmdHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { consoleCmdHistory = []; }
    consoleHistoryIdx = consoleCmdHistory.length;
  }
  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY,
        JSON.stringify(consoleCmdHistory.slice(-HISTORY_MAX)));
    } catch { /* quota or private mode: history just won't persist */ }
  }

  function switchTab(name) {
    document.querySelectorAll('#output-tabs .tab').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-content').forEach(p => {
      p.classList.toggle('active', p.id === name + '-pane');
    });
    if (name === 'console') $consoleInput.focus();
  }

  // kind: 'code' (echoed input), 'error' (traceback), 'repr', undefined (plain)
  function appendConsole(text, cls, kind) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    if (kind === 'code') {
      const m = text.match(/^(>>> |\.\.\. )?([\s\S]*)$/);
      span.innerHTML = '<span class="tb-prompt">' + esc(m[1] || '') + '</span>'
        + highlightPy(m[2]) + '\n';
    } else if (kind === 'error') {
      span.innerHTML = text.split('\n').map(renderPyLine).join('\n') + '\n';
    } else {
      span.textContent = text + '\n';
    }
    $consoleHistory.appendChild(span);
    $consoleHistory.scrollTop = $consoleHistory.scrollHeight;
    return span;
  }

  function setPrompt(cont) {
    $consolePrompt.innerHTML = cont ? '...&nbsp;' : '&gt;&gt;&gt;&nbsp;';
  }

  function autoGrow() {
    $consoleInput.style.height = 'auto';
    $consoleInput.style.height = $consoleInput.scrollHeight + 'px';
  }

  function setConsoleInput(v) {
    $consoleInput.value = v;
    setPrompt(v.includes('\n'));
    autoGrow();
  }

  // --- Caret geometry: needed so Up/Down move inside the buffer first ------
  function caretLine() {
    const before = $consoleInput.value.slice(0, $consoleInput.selectionStart);
    return before.split('\n').length - 1;
  }
  function lineCount() { return $consoleInput.value.split('\n').length; }

  // --- Magics ------------------------------------------------------------
  const HELP_TEXT = [
    'Console help',
    '',
    'Keys',
    '  Enter              run the block (or open a new line if it is unfinished)',
    '  Shift+Enter        always open a new line, indented for you',
    '  Ctrl+Enter         force run, even an unfinished block',
    '  Tab                complete names / attributes, or indent one level',
    '  Up / Down          move a line inside the block; at the edges, browse history',
    '  Ctrl+Up / Ctrl+Dn  browse history directly',
    '  Home / End         start / end of the current line',
    '  Backspace          delete a whole indent level inside leading whitespace',
    '  Ctrl+U             clear the current input',
    '  Ctrl+L             clear the screen',
    '',
    'Magics',
    '  !help  %help  ?    this message',
    '  %clear  !clear     clear the screen (also Ctrl+L)',
    '  %who               list the names you have defined',
    '  %time <expr>       time one evaluation of <expr>',
    '  %timeit <expr>     time <expr> repeatedly and report the best run',
    '  %reset             forget every name and start fresh',
    '  <obj>?             show help(<obj>)',
    '',
    'Notes',
    '  The console shares its namespace with the Run and Check buttons, so a',
    '  function you defined in the editor and ran is callable here by name.',
    '  Top-level await works. `_` holds the last result.'
  ].join('\n');

  // Returns Python source to execute, '' when handled locally, or null to pass through
  function applyMagic(src) {
    const line = src.trim();

    // Only the ! and % prefixes are intercepted: plain `clear` or `help()` must
    // keep meaning whatever they mean in Python.
    if (line === '?' || line === '!help' || line === '%help') {
      appendConsole(HELP_TEXT, 'help');
      return '';
    }
    if (line === '%clear' || line === '!clear') {
      $consoleHistory.innerHTML = '';
      return '';
    }
    if (line === '%reset') {
      consoleBusy = true;
      workerMgr.resetNamespace()
        .then(res => {
          appendConsole(res && res.status === 'ok'
            ? 'Namespace cleared.'
            : 'Reset failed: ' + ((res && res.error) || 'unknown'),
            res && res.status === 'ok' ? 'help' : 'error');
        })
        .catch(err => appendConsole('Reset failed: ' + err.message, 'error'))
        .finally(() => { consoleBusy = false; });
      return '';
    }
    if (line === '%who') {
      return 'print(" ".join(sorted(k for k in globals() '
           + 'if not k.startswith("_"))) or "(nothing defined yet)")';
    }
    let m;
    if ((m = line.match(/^%time\s+(.+)$/))) {
      return 'import time as _t\n_s = _t.perf_counter()\n_r = (' + m[1] + ')\n'
           + 'print(f"{(_t.perf_counter() - _s) * 1000:.3f} ms")\n_r';
    }
    if ((m = line.match(/^%timeit\s+(.+)$/))) {
      return 'import timeit as _ti\n'
           + 'print(f"best of 5: {min(_ti.repeat(lambda: (' + m[1] + '), number=100, repeat=5)) / 100 * 1e6:.1f} us per loop")';
    }
    // IPython's trailing-? help, but not on a string or a slice
    if ((m = line.match(/^([A-Za-z_][\w.]*)\?\??$/))) {
      return 'help(' + m[1] + ')';
    }
    return null;
  }

  // --- Submit ------------------------------------------------------------
  async function submitConsole(force) {
    if (consoleBusy) return;
    const src = $consoleInput.value;
    if (!src.trim()) { setConsoleInput(''); return; }

    // Echo exactly what was typed, prompt-per-line like a terminal.
    // Keep the nodes: on "incomplete" they are removed by reference, because
    // anything else (a ready banner, a Ctrl+L) may have been appended since.
    const echoNodes = src.split('\n').map((l, i) =>
      appendConsole((i === 0 ? '>>> ' : '... ') + l, null, 'code'));

    // Remember it, then clear the input
    if (consoleCmdHistory[consoleCmdHistory.length - 1] !== src) consoleCmdHistory.push(src);
    consoleHistoryIdx = consoleCmdHistory.length;
    consoleDraft = '';
    saveHistory();
    setConsoleInput('');

    const magic = applyMagic(src);
    if (magic === '') return;             // handled entirely in the browser

    let res;
    consoleBusy = true;
    try {
      res = await workerMgr.runConsole(magic === null ? src : magic);
    } catch (err) {
      // Without the finally below, one rejection would wedge the console shut
      appendConsole(((err && err.message) || String(err)), 'error');
      if (err && err.busy) $btnStop.classList.add('urgent');
      return;
    } finally {
      consoleBusy = false;
    }

    if (res.status === 'incomplete' && !force) {
      // Python says the block is unfinished: hand it back with a fresh line
      // instead of reporting an error. This is what the real REPL does.
      const back = src.replace(/\n+$/, '');
      setConsoleInput(back + '\n' + indentAfter(back));
      $consoleInput.selectionStart = $consoleInput.selectionEnd = $consoleInput.value.length;
      // Drop the echo we printed; it is re-echoed on the real submit
      echoNodes.forEach(node => { if (node && node.parentNode) node.remove(); });
      consoleCmdHistory.pop();
      consoleHistoryIdx = consoleCmdHistory.length;
      return;
    }

    if (res.stdout) appendConsole(res.stdout.replace(/\n$/, ''));
    if (res.stderr) appendConsole(res.stderr.replace(/\n$/, ''), 'error', 'error');
    if (res.error)  appendConsole(res.error.replace(/\n$/, ''), 'error', 'error');
    if (res.repr)   appendConsole(res.repr, 'repr');
  }

  // --- Tab completion ----------------------------------------------------
  function commonPrefix(list) {
    if (!list.length) return '';
    let pre = list[0];
    for (const s of list) {
      while (pre && !s.startsWith(pre)) pre = pre.slice(0, -1);
    }
    return pre;
  }

  async function doComplete() {
    const at = $consoleInput.selectionStart;
    const before = $consoleInput.value.slice(0, at);
    const word = (before.match(/[\w.]*$/) || [''])[0];

    // Nothing to complete: behave like Tab in an editor
    if (!word) {
      $consoleInput.value = before + INDENT + $consoleInput.value.slice(at);
      $consoleInput.selectionStart = $consoleInput.selectionEnd = at + INDENT_N;
      autoGrow();
      return;
    }

    let matches, start;
    try {
      ({ matches, start } = await workerMgr.complete(before));
    } catch {
      return;   // completion is a convenience: never surface its failures
    }
    if (!matches || !matches.length) return;

    // `start` comes from CPython's rlcompleter and counts code points, while
    // JS slices count UTF-16 units. They differ once an astral char is present.
    const head = Array.from(before).slice(0, start).join('');
    const insert = matches.length === 1 ? matches[0] : commonPrefix(matches);
    if (insert && head + insert !== before) {
      $consoleInput.value = head + insert + $consoleInput.value.slice(at);
      const pos = (head + insert).length;
      $consoleInput.selectionStart = $consoleInput.selectionEnd = pos;
      autoGrow();
    }
    if (matches.length > 1) {
      // Print the candidates the way a shell does
      appendConsole(matches.join('    '), 'completions');
    }
  }

  // --- History -----------------------------------------------------------
  function historyPrev() {
    if (consoleHistoryIdx === consoleCmdHistory.length) consoleDraft = $consoleInput.value;
    if (consoleHistoryIdx <= 0) return;
    consoleHistoryIdx--;
    setConsoleInput(consoleCmdHistory[consoleHistoryIdx]);
    $consoleInput.selectionStart = $consoleInput.selectionEnd = $consoleInput.value.length;
  }
  function historyNext() {
    if (consoleHistoryIdx >= consoleCmdHistory.length) return;
    consoleHistoryIdx++;
    setConsoleInput(consoleHistoryIdx === consoleCmdHistory.length
      ? consoleDraft
      : consoleCmdHistory[consoleHistoryIdx]);
    $consoleInput.selectionStart = $consoleInput.selectionEnd = $consoleInput.value.length;
  }

  // --- Key bindings ------------------------------------------------------
  $consoleInput.addEventListener('input', () => {
    setPrompt($consoleInput.value.includes('\n'));
    autoGrow();
  });

  $consoleInput.addEventListener('keydown', async (e) => {
    const val = $consoleInput.value;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { await submitConsole(true); return; }
      // Shift+Enter is always "new line"
      if (e.shiftKey) { smartNewline($consoleInput, () => { setPrompt(true); autoGrow(); }); return; }
      // Plain Enter: keep editing only when the block is plainly unfinished
      // (open bracket, trailing ':' or '\'). Otherwise run it -- and if Python
      // disagrees, submitConsole() hands the buffer back with a new line.
      const upToCaret = val.slice(0, $consoleInput.selectionStart);
      if (bracketDepth(val) > 0 || /:[ \t]*$/.test(stripLiterals(upToCaret).split('\n').pop())
          || /\\$/.test(val.trimEnd())) {
        smartNewline($consoleInput, () => { setPrompt(true); autoGrow(); });
        return;
      }
      await submitConsole(false);
      return;
    }

    if (e.key === 'Tab') { e.preventDefault(); await doComplete(); return; }

    if (e.key === 'Backspace' && smartBackspace($consoleInput, e, autoGrow)) return;

    // Up/Down: move inside the block first, browse history at the edges.
    // Ctrl held forces history, like a terminal.
    if (e.key === 'ArrowUp') {
      if (e.ctrlKey || caretLine() === 0) { e.preventDefault(); historyPrev(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (e.ctrlKey || caretLine() === lineCount() - 1) { e.preventDefault(); historyNext(); }
      return;
    }

    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $consoleHistory.innerHTML = ''; return; }
    if (e.ctrlKey && e.key === 'u') { e.preventDefault(); setConsoleInput(''); return; }
  });

  // Clicking anywhere in the pane focuses the input, like a terminal
  document.getElementById('console-pane').addEventListener('mousedown', e => {
    if (e.target === $consoleHistory || e.target.id === 'console-pane') {
      setTimeout(() => $consoleInput.focus(), 0);
    }
  });


  // === Done list (localStorage) ===
  function getDoneList() {
    try { return JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); }
    catch { return []; }
  }
  function markDone(id) {
    const done = getDoneList();
    if (!done.includes(id)) {
      done.push(id);
      localStorage.setItem(DONE_KEY, JSON.stringify(done));
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
    const base = n
      ? n + ' of ' + exercises.length + ' completed, saved in this browser.' + who
      : 'Progress is saved in this browser.' + who;
    $syncStatus.textContent = syncNote ? base + ' ' + syncNote : base;
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
      const bytes = Uint8Array.from(atob(raw), ch => ch.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
  }
  function setCreds(creds) {
    // Store base64-encoded JSON in a cookie (30 days)
    // btoa() throws on anything outside Latin-1, which a real name easily is
    const val = btoa(String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify(creds))));
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

  // Signed S3 request with SigV4 (minimal implementation).
  // method: 'PUT' or 'GET'. For GET, body is '' and the payload hash is the
  // hash of the empty string, which is what S3 expects.
  async function s3Request(creds, method, key, body) {
    const host = S3_BUCKET + '.s3.' + S3_REGION + '.amazonaws.com';
    const url = 'https://' + host + '/' + key;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+/, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = await sha256hex(method === 'GET' ? '' : body);

    const headers = {
      'Host': host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';

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
      method, canonicalUri, '',
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
    delete fetchHeaders.Host;   // the browser sets Host itself and forbids it here

    return fetch(url, {
      method,
      headers: fetchHeaders,
      body: method === 'GET' ? undefined : body
    });
  }

  async function s3Put(creds, key, body) {
    const resp = await s3Request(creds, 'PUT', key, body);
    if (!resp.ok) throw new Error('S3 PUT failed: ' + resp.status + ' ' + await resp.text());
    return true;
  }

  // Returns the parsed object, or null when the student has never submitted.
  async function s3GetJson(creds, key) {
    const resp = await s3Request(creds, 'GET', key, '');
    if (resp.status === 404 || resp.status === 403) return null;
    if (!resp.ok) throw new Error('S3 GET failed: ' + resp.status + ' ' + await resp.text());
    return resp.json();
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

  function progressKey(creds) {
    return 'progress/' + (creds.username || 'anonymous') + '.json';
  }

  // === Pull progress =====================================================
  // Logging in is meant to bring your work back: localStorage is per origin and
  // per browser, so without this the green checks and the saved scripts only
  // ever exist on the machine where they were written.
  //
  // Merge policy: the done list is a union (a pass is a pass, wherever it
  // happened) and remote code only fills gaps. Local edits are never clobbered,
  // because the student may be halfway through an exercise right now.
  async function pullProgress(creds, announce) {
    const remote = await s3GetJson(creds, progressKey(creds));
    if (!remote) {
      if (announce) setSyncNote('Nothing submitted yet for ' + (creds.username || 'anonymous') + '.');
      return { restored: 0, marked: 0, found: false };
    }

    let restored = 0;
    const localDone = getDoneList();
    const merged = [...new Set([...localDone, ...(remote.done || [])])];
    const marked = merged.length - localDone.length;
    localStorage.setItem(DONE_KEY, JSON.stringify(merged));

    Object.entries(remote.solved || {}).forEach(([id, code]) => {
      if (!localStorage.getItem(SOLVED_PREFIX + id)) {
        localStorage.setItem(SOLVED_PREFIX + id, code);
        restored++;
      }
    });
    Object.entries(remote.exercises || {}).forEach(([id, code]) => {
      if (!localStorage.getItem(CODE_PREFIX + id)) {
        localStorage.setItem(CODE_PREFIX + id, code);
      }
    });

    renderExerciseList();
    refreshStatus();
    // If the open exercise just gained code, show it instead of the template
    if (currentExercise && currentExercise._parsed) {
      const saved = localStorage.getItem(CODE_PREFIX + currentExercise.id);
      if (saved && $editor.value === currentExercise._parsed.template) {
        $editor.value = saved;
        repaint();
      }
    }
    if (announce) {
      setSyncNote('Restored from your submission of ' +
        (remote.savedAt ? remote.savedAt.slice(0, 16).replace('T', ' ') : 'an earlier session') +
        ': ' + merged.length + ' completed, ' + restored + ' script(s).');
    }
    return { restored, marked, found: true };
  }

  let syncNote = '';
  function setSyncNote(text) {
    syncNote = text;
    refreshStatus();
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

    const key = progressKey(creds);
    progress.savedAt = new Date().toISOString();
    progress.username = creds.username || 'anonymous';
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
      const creds = { ...awsCreds, username: user };
      setCreds(creds);
      hideLogin();
      // The point of logging in is getting your work back
      $loginError.textContent = '';
      try {
        await pullProgress(creds, true);
      } catch (err) {
        setSyncNote('Could not read your submission: ' + err.message);
        console.error(err);
      }
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
  $btnStop.addEventListener('click', stopRuntime);

  // === Description panel =================================================
  function renderDescription() {
    const detail = currentExercise && currentExercise._parsed
      ? currentExercise._parsed.detail : '';
    $descriptionTitle.textContent = currentExercise ? currentExercise.title : 'Description';
    if (!detail) {
      $descriptionBody.innerHTML =
        '<p class="md-empty">This exercise has no extended description.</p>';
      return;
    }
    // headingShift 2: the file writes h3, the panel shows it as h1
    $descriptionBody.innerHTML = renderMarkdown(detail, { headingShift: 2 });
    $descriptionBody.scrollTop = 0;
  }

  function showDescription(on) {
    const open = on === undefined ? $descriptionPanel.classList.contains('hidden') : on;
    if (open) renderDescription();
    $descriptionPanel.classList.toggle('hidden', !open);
    $btnDescription.classList.toggle('active', open);
    if (!open) $editor.focus();
  }

  $btnDescription.addEventListener('click', () => showDescription());
  $btnDescriptionClose.addEventListener('click', () => showDescription(false));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // The modal sits above the panel, so it is dismissed first
    if (!$loginModal.classList.contains('hidden')) { hideLogin(); return; }
    if (!$descriptionPanel.classList.contains('hidden')) showDescription(false);
  });

  function autoGrowRun() {
    $runArgs.style.height = 'auto';
    $runArgs.style.height = $runArgs.scrollHeight + 'px';
  }
  $runArgs.addEventListener('input', () => {
    autoGrowRun();
    if (currentExercise) localStorage.setItem(RUN_PREFIX + currentExercise.id, $runArgs.value);
  });
  $runArgs.addEventListener('keydown', e => {
    // Enter runs; Shift+Enter adds a line for a multi-statement call
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCode(); }
  });
  $btnRunReset.addEventListener('click', () => {
    if (!currentExercise || !currentExercise._parsed) return;
    $runArgs.value = currentExercise._parsed.run;
    localStorage.removeItem(RUN_PREFIX + currentExercise.id);
    autoGrowRun();
  });
  $btnLogin.addEventListener('click', showLogin);
  $btnPush.addEventListener('click', pushProgress);
  $loginOk.addEventListener('click', handleLogin);
  $loginCancel.addEventListener('click', hideLogin);
  $loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });

  $editor.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Enter runs
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); return; }

    // Enter keeps the block's indentation
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      smartNewline($editor, saveAndRepaint);
      return;
    }

    // Tab inserts one level
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = $editor.selectionStart;
      $editor.value = $editor.value.slice(0, start) + INDENT + $editor.value.slice($editor.selectionEnd);
      $editor.selectionStart = $editor.selectionEnd = start + INDENT_N;
      saveAndRepaint();
      return;
    }

    // Backspace inside leading whitespace removes a whole level
    if (e.key === 'Backspace') smartBackspace($editor, e, saveAndRepaint);
  });

  function saveAndRepaint() {
    repaint();
    if (currentExercise) localStorage.setItem(CODE_PREFIX + currentExercise.id, $editor.value);
  }

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
  loadHistory();
  migrateLegacyKeys();
  initWorker();
  loadManifest().then(async () => {
    refreshStatus();
    // Already logged in from a previous visit: bring the work back quietly
    const creds = getCreds();
    if (!creds) return;
    try { await pullProgress(creds, false); }
    catch (err) { console.error('Could not restore progress:', err); }
  });

  // Progress used to be stored under un-namespaced keys (py_ex_ex01, py_done).
  // Move anything left over so nobody loses local work to the rename.
  function migrateLegacyKeys() {
    try {
      if (localStorage.getItem('py_done') && !localStorage.getItem(DONE_KEY)) {
        localStorage.setItem(DONE_KEY, localStorage.getItem('py_done'));
      }
      Object.keys(localStorage).forEach(key => {
        const match = key.match(/^py_(ex|solved|run)_(ex\d+)$/);
        if (!match) return;
        const target = { ex: CODE_PREFIX, solved: SOLVED_PREFIX, run: RUN_PREFIX }[match[1]] + match[2];
        if (!localStorage.getItem(target)) localStorage.setItem(target, localStorage.getItem(key));
      });
    } catch (err) {
      console.warn('Legacy key migration skipped:', err);
    }
  }

})();
