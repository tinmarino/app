/* app.js – Python Classroom main application logic */
/* global PyodideWorkerManager */

(function () {
  'use strict';

  // Tell an embedding parent page (index.html) that this frame handles its own
  // swipes and forwards the rest by postMessage, so it must not also inject its
  // own touch listeners here -- otherwise every swipe would fire twice.
  window.__tinSwipeSelfManaged = true;

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
  const $loginNew = document.getElementById('login-new');
  const $loginNewRow = document.getElementById('login-new-row');
  const $loginKey = document.getElementById('login-key');
  const $loginKeyRow = document.getElementById('login-key-row');
  const $loginSwitchRegister = document.getElementById('login-switch-register');
  const $loginSwitchLogin = document.getElementById('login-switch-login');
  const $btnHistory = document.getElementById('btn-history');
  const $btnRestore = document.getElementById('btn-restore');

  // === Shared helpers (pyutil.js) =========================================
  // Indentation and traceback colouring live in pyutil.js so the standalone
  // shell behaves exactly the same way.
  const {
    esc, highlightPy, renderPyLine, renderOutput, simplifyTracebacks,
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

    // A size saved on a wide window must not squeeze the layout on a narrow one.
    // `skip` guards the collapsed phone drawer: its height is pinned to 0 by
    // CSS, so re-clamping would write a bogus inline height it keeps forever.
    window.addEventListener('resize', () => {
      if (opts.skip && opts.skip()) return;
      setSize(clamp(getSize()));
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
  const $splitterY = document.getElementById('splitter-y');

  makeSplitter(document.getElementById('splitter-x'), {
    key: 'py_w_sidebar', vertical: true, sign: 1, dflt: 260, min: 140,
    getSize: () => $sidebar.getBoundingClientRect().width,
    setSize: px => { $sidebar.style.width = px + 'px'; },
    maxFn:   () => Math.max(140, window.innerWidth - 320)
  });

  makeSplitter($splitterY, {
    // Dragging down must shrink the output pane, hence sign -1
    key: 'py_h_output', vertical: false, sign: -1, dflt: 240, min: 80,
    getSize: () => $outputArea.getBoundingClientRect().height,
    setSize: px => { $outputArea.style.height = px + 'px'; syncScroll(); },
    maxFn:   () => Math.max(80, window.innerHeight - 220),
    skip:    () => document.body.classList.contains('output-collapsed')
  });

  // === Mobile gestures ====================================================
  // On a narrow screen the sidebar is an overlay and the output area is a
  // drawer, so the editor keeps the screen. A swipe to open the sidebar may
  // start anywhere in the left half (so it clears Android's own back-gesture at
  // the very edge); the output drawer keeps a mid-bottom pull zone. Left swipes
  // ask the parent page to hide its own docks first, and only then hide ours.
  //
  // The same gestures work in the wide (docked) layout and the narrow (phone)
  // layout; only the CSS that "hidden" means differs -- see the two body
  // classes below.
  //
  //   swipe right  -> show the exercise sidebar; if already shown, ask the parent
  //   swipe left   -> hide the exercise sidebar; if already hidden, ask the parent
  //   swipe up     -> show the output dock   (from the lower half of the screen)
  //   swipe down   -> hide the output dock   (from the lower half of the screen)
  //
  const SWIPE_MIN = 60;        // px of travel needed to count as a swipe
  const SWIPE_SLOP = 40;       // max drift on the other axis before we let go
  const LEFT_FRACTION = 1 / 3; // a swipe to reveal the sidebar must start in the left third
  const LOWER_FRACTION = 0.5;  // a vertical swipe drives the dock from the lower half
  const OUTPUT_KEY = 'py_output_open';
  const PARENT_SWIPE_TIMEOUT = 250;

  function isNarrow() { return window.matchMedia('(max-width: 700px), (max-height: 500px)').matches; }

  // A swipe that reveals the sidebar may start anywhere in the left half of the
  // screen. The old build only listened to a 60px strip at the very edge, which
  // on Android sits under the OS back-gesture and so was effectively unreachable
  // -- that is why swiping "did not work at all".
  function inOpenZone(start) {
    return start.x <= window.innerWidth * LEFT_FRACTION;
  }

  // A vertical swipe drives the output dock when it starts in the lower half of
  // the screen (that is where the dock lives) or on the dock itself.
  function inLowerZone(start) {
    return start.y >= window.innerHeight * LOWER_FRACTION
      || $outputArea.contains(start.target)
      || $splitterY.contains(start.target);
  }

  // --- Sidebar (both layouts) --------------------------------------------
  // Narrow: the sidebar is an overlay, shown by `sidebar-open` (hidden default).
  // Wide:   the sidebar is docked and shown by default; `sidebar-collapsed`
  //         slides it out. Two classes so each layout keeps its natural default.
  function sidebarShown() {
    return isNarrow()
      ? document.body.classList.contains('sidebar-open')
      : !document.body.classList.contains('sidebar-collapsed');
  }

  function setSidebarShown(show) {
    if (isNarrow()) {
      document.body.classList.toggle('sidebar-open', show);
    } else {
      document.body.classList.toggle('sidebar-collapsed', !show);
    }
    $btnMenu.setAttribute('aria-expanded', String(show));
  }

  // --- Output dock (both layouts) ----------------------------------------
  // `output-collapsed` pins the dock to zero height in either layout.
  function outputOpen() { return !document.body.classList.contains('output-collapsed'); }

  function setOutputOpen(open) {
    if (open === outputOpen()) return;
    document.body.classList.toggle('output-collapsed', !open);
    try { localStorage.setItem(OUTPUT_KEY, open ? '1' : '0'); } catch { /* private mode */ }
    syncScroll();
  }

  // A wide screen starts with the dock open; a phone starts with it shut (the
  // editor is the point of the page). A saved choice wins in both, and Run/Check
  // pull the dock back up on their own.
  function applyOutputDefault() {
    const saved = localStorage.getItem(OUTPUT_KEY);
    const open = saved === null ? !isNarrow() : saved === '1';
    document.body.classList.toggle('output-collapsed', !open);
  }
  applyOutputDefault();

  // Tap the handle to toggle; a real drag resizes instead (makeSplitter owns
  // that), so remember whether the pointer actually moved before acting.
  let handleDown = null;
  $splitterY.addEventListener('pointerdown', ev => { handleDown = { y: ev.clientY, moved: false }; });
  $splitterY.addEventListener('pointermove', ev => {
    if (!handleDown) return;
    const dy = ev.clientY - handleDown.y;
    if (Math.abs(dy) > 8) handleDown.moved = true;
    // While collapsed the pane is pinned to 0 by CSS, so dragging it cannot
    // resize anything. Pulling up is then plainly a request to open it.
    if (!outputOpen() && dy < -20) setOutputOpen(true);
  });
  $splitterY.addEventListener('click', () => {
    if (handleDown && handleDown.moved) { handleDown = null; return; }
    handleDown = null;
    setOutputOpen(!outputOpen());
  });

  // --- Swipes -------------------------------------------------------------
  let touchStart = null;
  let parentSwipeSeq = 0;

  // Same-origin parents can attach touch listeners directly inside this frame,
  // and cross-origin ones cannot. Ask the parent explicitly instead, wait for a
  // yes/no answer, and fall back to our own bar only when the parent says it had
  // nothing left to hide.
  function requestParentSwipe(dir) {
    if (window.parent === window) return Promise.resolve(false);
    const requestId = 'classroom-' + (++parentSwipeSeq);
    return new Promise(resolve => {
      let done = false;
      const finish = handled => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(handled);
      };
      const onMessage = event => {
        // Only trust messages from our own origin (the parent page)
        if (event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.type !== 'tinmarino-swipe-result' || data.requestId !== requestId) {
          return;
        }
        finish(!!data.handled);
      };
      const timer = setTimeout(() => finish(false), PARENT_SWIPE_TIMEOUT);
      window.addEventListener('message', onMessage);
      try {
        window.parent.postMessage({ type: 'tinmarino-swipe-request', dir: dir, requestId: requestId }, location.origin);
      } catch {
        finish(false);
      }
    });
  }

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { touchStart = null; return; }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, target: e.target };
  }, { passive: true });

  document.addEventListener('touchend', async e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const start = touchStart;
    touchStart = null;

    // Vertical output-dock swipe (up/down) is intentionally DISABLED: on a phone
    // a downward swipe collides with the browser's pull-to-refresh. Toggle the
    // dock with the splitter grip / output tabs instead. Kept commented so it
    // can be restored.
    /*
    if (Math.abs(dy) > SWIPE_MIN && Math.abs(dx) < SWIPE_SLOP) {
      if (!inLowerZone(start)) return;      // upper half: leave scrolling alone
      const inDock = $outputArea.contains(start.target) || $splitterY.contains(start.target);
      const onHandle = $splitterY.contains(start.target)
        || (start.target.closest && start.target.closest('#output-tabs'));

      if (dy > 0) {                         // swipe down -> hide
        if (!outputOpen()) return;
        if (inDock && !onHandle) {
          const pane = document.querySelector('.tab-content.active');
          if (pane && pane.scrollTop > 0) return;
        }
        e.stopImmediatePropagation();
        setOutputOpen(false);
      } else {                              // swipe up -> show
        if (outputOpen()) return;
        e.stopImmediatePropagation();
        setOutputOpen(true);
      }
      return;
    }
    */

    if (Math.abs(dy) > SWIPE_SLOP || Math.abs(dx) < SWIPE_MIN) return;

    // Horizontal: drive the exercise sidebar. Right shows, left hides. Revealing
    // needs a deliberate start in the left half (so we don't steal a stray drag
    // in the editor); hiding works from anywhere once the sidebar is shown.
    const shown = sidebarShown();
    const fromLeft = inOpenZone(start) || $sidebar.contains(start.target);

    if (dx > 0) {                           // swipe right -> show
      if (shown) { await requestParentSwipe('right'); return; }
      if (!fromLeft) return;
      e.stopImmediatePropagation();
      setSidebarShown(true);
    } else {                                // swipe left -> hide
      if (shown) {
        e.stopImmediatePropagation();
        setSidebarShown(false);
      } else {
        await requestParentSwipe('left');
      }
    }
  }, { passive: true });

  // Same thing for people who are not swiping
  $btnMenu.addEventListener('click', () => { setSidebarShown(!sidebarShown()); });
  const $backdrop = document.getElementById('sidebar-backdrop');
  $backdrop.addEventListener('click', () => setSidebarShown(false));

  // Picking an exercise on a phone should get out of the way, and hand the
  // screen back to the code.
  $list.addEventListener('click', () => { if (isNarrow()) setSidebarShown(false); });
  // Leaving the narrow layout must not strand the overlay-open class on the body
  // (it would collapse the docked sidebar's width); re-apply the dock defaults.
  window.addEventListener('resize', () => {
    if (!isNarrow()) { document.body.classList.remove('sidebar-open'); }
    applyOutputDefault();
  });

  // === Zoom = per-pane text size ==========================================
  // The page never scales (viewport locked). Pinch, Ctrl+wheel and Ctrl+/-
  // resize the TEXT of the pane under the gesture, and only that pane: the code
  // editor, the exercise list, or the output dock. Each keeps its own size.
  const FONT_MIN = 9;
  const FONT_MAX = 100;
  const $zoomBadge = document.getElementById('zoom-badge');
  let badgeTimer = null;

  const ZOOM = {
    code: { varName: '--code-font', key: 'py_code_font', dflt: 14, value: 14 },
    list: { varName: '--list-font', key: 'py_list_font', dflt: 15, value: 15 },
    dock: { varName: '--dock-font', key: 'py_dock_font', dflt: 13, value: 13 },
  };
  const NAME = { code: 'code', list: 'list', dock: 'output' };

  function setFont(scope, px, announce) {
    const z = ZOOM[scope];
    z.value = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    document.documentElement.style.setProperty(z.varName, z.value.toFixed(1) + 'px');
    try { localStorage.setItem(z.key, String(z.value)); } catch { /* private mode */ }
    if (scope === 'code') { syncScroll(); autoGrowRun(); }  // keep highlight aligned + grow Run-with
    if (!announce) return;
    $zoomBadge.textContent = NAME[scope] + ' ' + Math.round(z.value) + ' px';
    $zoomBadge.classList.remove('hidden');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => $zoomBadge.classList.add('hidden'), 700);
  }

  // Restore each pane's saved size (or its default).
  for (const scope of Object.keys(ZOOM)) {
    const saved = parseFloat(localStorage.getItem(ZOOM[scope].key));
    setFont(scope, isNaN(saved) ? ZOOM[scope].dflt : saved, false);
  }

  // Which pane a gesture belongs to, from the element it landed on.
  function zoomScope(target) {
    if (target && target.closest) {
      if (target.closest('#sidebar')) return 'list';
      if (target.closest('#output-area') || target.closest('#splitter-y')) return 'dock';
    }
    return 'code';
  }

  function pinchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  let pinch = null;
  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) { pinch = null; return; }
    touchStart = null;                     // a two-finger gesture is never a swipe
    // Pick the pane from the midpoint between the fingers.
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const scope = zoomScope(document.elementFromPoint(mx, my) || e.target);
    pinch = { dist: pinchDistance(e.touches), scope, font: ZOOM[scope].value };
  }, { passive: true });

  // Not passive: a two-finger drag is ours, and on browsers that still offer
  // page zoom despite the viewport meta this is what stops it.
  document.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const dist = pinchDistance(e.touches);
    if (pinch.dist < 1) return;
    setFont(pinch.scope, pinch.font * (dist / pinch.dist), true);
  }, { passive: false });

  document.addEventListener('touchend', () => { if (pinch) pinch = null; }, { passive: true });

  document.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const scope = zoomScope(e.target);
    setFont(scope, ZOOM[scope].value + (e.deltaY < 0 ? 1 : -1), true);
  }, { passive: false });

  // Ctrl+/Ctrl-/Ctrl+0 on the pane that holds the keyboard focus.
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    const scope = zoomScope(document.activeElement);
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setFont(scope, ZOOM[scope].value + 1, true); }
    else if (e.key === '-') { e.preventDefault(); setFont(scope, ZOOM[scope].value - 1, true); }
    else if (e.key === '0') { e.preventDefault(); setFont(scope, ZOOM[scope].dflt, true); }
  });

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
  // All tab activation (click and the arrow-key nav above) goes through
  // switchTab, so aria-selected, the console focus and the phone drawer stay in
  // step instead of only the .active classes being toggled.
  document.querySelectorAll('#output-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      exercises = await resp.json();
    } catch (e) {
      exercises = [];
      console.error('Cannot load exercise manifest:', e);
      $syncStatus.textContent = 'Could not load the exercise list from ' + EXERCISES_BASE;
    }
    renderExerciseList();
    selectExerciseFromUrl();
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

  // The ?exercice= URL param: the exercise title slugified, e.g.
  // "A4 - Fibonacci" -> "a4-fibonacci".
  function exerciseSlug(ex) {
    return String(ex.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Select the exercise named in ?exercice=<slug> (also accepts ?exercise=).
  function selectExerciseFromUrl() {
    const params = new URLSearchParams(location.search);
    const want = (params.get('exercice') || params.get('exercise') || '').toLowerCase();
    if (!want) return;
    const idx = exercises.findIndex(ex => exerciseSlug(ex) === want);
    if (idx >= 0) selectExercise(idx);
  }

  let selectToken = 0;

  async function selectExercise(idx) {
    const token = ++selectToken;
    const exercise = exercises[idx];
    currentExercise = exercise;
    // Reflect the choice in the URL so it can be shared and reloaded.
    try {
      const url = new URL(location.href);
      url.searchParams.set('exercice', exerciseSlug(exercise));
      history.replaceState(null, '', url);
    } catch { /* history unavailable */ }
    // Highlight active
    $list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === idx));
    $title.textContent = currentExercise.title;

    // Load exercise markdown/content
    try {
      const resp = await fetch(EXERCISES_BASE + '/' + exercise.file);
      // Without this a 404 hands back the server's HTML error page, which has no
      // fences, so the editor would go blank with no explanation.
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + exercise.file);
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
    // (?![\s\S]) is end-of-input: JS has no \Z, and a literal \Z would stop the
    // capture at the first capital "Z" in the Description text.
    const detailMatch = md.match(/^##\s+Description\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
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
    // The runtime answered, so it is no longer wedged: stop nagging with Stop.
    $btnStop.classList.remove('urgent');
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
    // The tests are handed the student's own source as well as their function,
    // so an exercise can refuse a construct it bans -- `max(`, `[::-1]`,
    // `.split(` -- which no assertion on a return value could ever catch.
    // Appended *after* their code, never before, so a traceback still points at
    // the line they wrote. JSON.stringify emits a valid Python string literal.
    const source = $editor.value;
    const code = source
      + '\n__student_code__ = ' + JSON.stringify(source)
      + '\n' + currentExercise._parsed.tests;
    $testsOutput.textContent = 'Checking...\n';
    switchTab('tests');

    let result;
    try {
      result = await workerMgr.run(code, true);   // fresh namespace: grade only this code
    } catch (err) {
      reportRuntimeError($testsOutput, err);
      return;
    }
    $btnStop.classList.remove('urgent');
    let out = '';
    if (result.stdout) out += result.stdout + '\n';
    if (result.stderr) out += result.stderr + '\n';
    if (result.error) {
      out += '--- FAIL ---\n' + result.error + '\n';
    } else {
      out += '--- ALL TESTS PASSED ---\n';
      // Remember the code that actually passed, so Download reports real work.
      // Guarded: a quota or private-mode throw here must not abort before the
      // pass is shown on screen.
      const prevSolved = getSolved(currentExercise.id);
      try {
        localStorage.setItem(SOLVED_PREFIX + currentExercise.id, $editor.value);
        markDone(currentExercise.id);
      } catch (err) { console.warn('Could not save progress:', err); }
      // A passing Check auto-submits the accepted answer -- there is no separate
      // Submit button. Only when logged in, and only when the passing code is
      // new or changed, so re-checking the same solution does not spam the trail.
      if (isLoggedIn() && $editor.value !== prevSolved) { pushProgress(); }
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
    // A pane nobody can see is useless: asking for one opens the phone drawer.
    setOutputOpen(true);
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
      span.innerHTML = simplifyTracebacks(text).split('\n').map(renderPyLine).join('\n') + '\n';
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
    if (consoleBusy) {
      appendConsole('Python is still running your last command. '
        + 'Press Stop if it is stuck in a loop.', 'error');
      return;
    }
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
      res = await workerMgr.runConsole(magic === null ? src : magic, force);
    } catch (err) {
      // Without the finally below, one rejection would wedge the console shut
      appendConsole(((err && err.message) || String(err)), 'error');
      if (err && err.busy) $btnStop.classList.add('urgent');
      return;
    } finally {
      consoleBusy = false;
    }

    // The runtime answered, so it is free again.
    $btnStop.classList.remove('urgent');

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

  // Wipe every trace of local progress for this exercise set: the done list
  // and all saved editor buffers, passing code, and run-args. Used before a
  // force restore so one user's work never lingers under another user's login.
  function clearLocalProgress() {
    localStorage.removeItem(DONE_KEY);
    Object.keys(localStorage)
      .filter(key => key.startsWith(CODE_PREFIX)
                  || key.startsWith(SOLVED_PREFIX)
                  || key.startsWith(RUN_PREFIX))
      .forEach(key => localStorage.removeItem(key));
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
    const who = isLoggedIn() ? ' Logged in as ' + currentUser() + '.' : '';
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
    const lines = [
      '# Python Exercises',
      '',
      (isLoggedIn() ? 'Student: ' + currentUser() : 'Student: (not logged in)'),
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
    const who = (currentUser() || 'student').replace(/[^\w.-]+/g, '_');
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

  // ========================================================================
  // === Login and submission sync (Cognito, see classroom-sync.js) =========
  // ========================================================================
  // Everything above works with no login at all. This part is strictly
  // additive: it submits what is already stored locally, and brings it back.
  // No AWS credential lives in this page; classroom-sync.js exchanges a
  // student password for short-lived STS credentials scoped to that student.

  // The classroom must work with no AWS infrastructure at all: exercises, the
  // editor, Run, Check, the green checks, the console and Download are pure
  // client side. Only Submit / History / Login reach the cloud, so a missing or
  // broken classroom-sync.js degrades to "syncing unavailable" instead of
  // taking the whole page down at boot.
  const SYNC_MISSING = 'Submitting is not set up on this server. Everything ' +
                       'else works, and Download saves your work.';

  const Sync = window.ClassroomSync || {
    unavailable: true,
    isLoggedIn: () => false,
    username: () => null,
    identity: () => null,
    restore: () => null,
    logout: () => {},
    login: () => Promise.reject(new Error(SYNC_MISSING)),
    setNewPassword: () => Promise.reject(new Error(SYNC_MISSING)),
    submit: () => Promise.reject(new Error(SYNC_MISSING)),
    loadLatest: () => Promise.reject(new Error(SYNC_MISSING)),
    listSubmissions: () => Promise.reject(new Error(SYNC_MISSING)),
    loadSubmission: () => Promise.reject(new Error(SYNC_MISSING))
  };

  function syncAvailable() { return !Sync.unavailable; }
  function isLoggedIn() { return Sync.isLoggedIn(); }
  function currentUser() { return Sync.username(); }

  // === Pull progress =====================================================
  // Logging in is meant to bring your work back: localStorage is per origin
  // and per browser, so without this the green checks and the saved scripts
  // only ever exist on the machine where they were written.
  //
  // Merge policy: the done list is a union (a pass is a pass, wherever it
  // happened) and remote code only fills gaps. Local edits are never
  // clobbered, because the student may be halfway through an exercise.
  //
  // `force` is the escape hatch behind the Restore button, and what an explicit
  // login uses: it is a clean switch to the remote user. Local state is wiped
  // first, then the last submitted version is laid down whole -- done list, code
  // and editor -- so one user's work never lingers, or gets re-submitted, under
  // another user's login. (A gap-fill sync, by contrast, keeps the union and
  // never clobbers unsubmitted edits: same student, second device.)
  async function pullProgress(announce, force) {
    const remote = await withAutoLogin(() => Sync.loadLatest());
    if (!remote) {
      if (announce) setSyncNote('Nothing submitted yet for ' + currentUser() + '.');
      return { restored: 0, marked: 0, found: false };
    }

    // A force restore is a clean switch to the remote user: wipe local state
    // first, so the previous login's done list and code are not carried over
    // (and cannot be re-submitted under the new account). A gap-fill sync keeps
    // the union, because there it is the same student on a second device.
    if (force) clearLocalProgress();

    let restored = 0;
    const localDone = getDoneList();
    const merged = force
      ? (remote.done || [])
      : [...new Set([...localDone, ...(remote.done || [])])];
    const marked = merged.length - localDone.length;
    localStorage.setItem(DONE_KEY, JSON.stringify(merged));

    Object.entries(remote.solved || {}).forEach(([id, code]) => {
      if (force || !localStorage.getItem(SOLVED_PREFIX + id)) {
        localStorage.setItem(SOLVED_PREFIX + id, code);
        restored++;
      }
    });
    Object.entries(remote.exercises || {}).forEach(([id, code]) => {
      if (force || !localStorage.getItem(CODE_PREFIX + id)) {
        localStorage.setItem(CODE_PREFIX + id, code);
      }
    });

    renderExerciseList();
    refreshStatus();
    // If the open exercise just gained code, show it instead of the template
    if (currentExercise && currentExercise._parsed) {
      const saved = localStorage.getItem(CODE_PREFIX + currentExercise.id);
      if (saved && (force || $editor.value === currentExercise._parsed.template)) {
        $editor.value = saved;
        repaint();
      } else if (force && !saved) {
        // Clean switch and the new user has nothing here: drop the stale buffer
        // back to the template rather than leave the old user's code on screen.
        $editor.value = currentExercise._parsed.template;
        repaint();
      }
    }
    if (announce) {
      const when = remote.savedAt
        ? remote.savedAt.slice(0, 16).replace('T', ' ')
        : 'an earlier session';
      setSyncNote('Restored from ' + when + ': ' + merged.length +
                  ' completed, ' + restored + ' script(s).');
    }
    return { restored, marked, found: true };
  }

  let syncNote = '';
  function setSyncNote(text) {
    syncNote = text;
    refreshStatus();
  }

  // === Submission history ================================================
  // Each submission is its own object, so the trail is kept rather than
  // overwritten. This lists the student's own, newest first.
  async function showHistory() {
    if (!isLoggedIn()) { showLogin(); return; }
    switchTab('console');
    appendConsole('Loading your submission history...', 'help');
    try {
      const items = await withAutoLogin(() => Sync.listSubmissions());
      if (!items.length) { appendConsole('No submissions yet.', 'help'); return; }
      appendConsole(items.length + ' submission(s), newest first:', 'help');
      items.slice(0, 40).forEach(item => {
        const name = item.key.split('/').pop().replace(/\.(json|py)$/, '');
        appendConsole('  ' + item.modified.slice(0, 16).replace('T', ' ') +
                      '  ' + name + '  (' + item.size + ' bytes)');
      });
      if (items.length > 40) appendConsole('  ... and ' + (items.length - 40) + ' more');
    } catch (err) {
      appendConsole('Could not list your submissions: ' + err.message, 'error');
    }
  }

  // === Push progress =====================================================
  // `snapshotOnly` uploads the full state (done list, every saved script) but
  // no per-exercise .py file: it is what a login or a registration uses to
  // put this browser's work in the bucket without pretending the open
  // exercise was just submitted.
  async function pushProgress(snapshotOnly) {
    if (!isLoggedIn()) { showLogin(); return; }

    const curId = currentExercise && !snapshotOnly ? currentExercise.id : null;
    // "accepted" once the tests have passed (getSolved holds the passing code),
    // otherwise it is just a "submitted" work-in-progress.
    const passed = curId ? !!getSolved(curId) : false;
    const progress = {
      exercise: curId || 'all',
      title: currentExercise ? currentExercise.title : '',
      code: curId ? $editor.value : null,
      status: passed ? 'accepted' : 'submitted',
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

    if ($btnPush) $btnPush.disabled = true;
    try {
      const record = await withAutoLogin(() => Sync.submit(progress));
      setSyncNote((snapshotOnly ? 'Saved to the server at ' : 'Submitted at ')
                  + record.savedAt.slice(0, 16).replace('T', ' ') + '.');
    } catch (err) {
      setSyncNote('Submit failed: ' + err.message);
      console.error(err);
    } finally {
      if ($btnPush) $btnPush.disabled = !isLoggedIn();
    }
  }

  // === Force restore =====================================================
  // pullProgress() only fills gaps, so once an exercise has any local code it
  // never pulls the submitted one again. Restore is the deliberate override:
  // it overwrites this browser's code with the last submitted version. It is
  // destructive to unsubmitted local edits, so it asks first.
  async function forceRestore() {
    if (!isLoggedIn()) { showLogin(); return; }
    const ok = window.confirm(
      'Force restore overwrites the code saved in THIS browser with your last '
      + 'submitted version from the server. Any local edits you have not '
      + 'submitted will be lost.\n\nContinue?');
    if (!ok) return;

    $btnRestore.disabled = true;
    try {
      const res = await pullProgress(true, true);
      if (!res.found) setSyncNote('Nothing to restore for ' + currentUser() + '.');
    } catch (err) {
      setSyncNote('Restore failed: ' + err.message);
      console.error(err);
    } finally {
      $btnRestore.disabled = !isLoggedIn();
    }
  }

  // === Login =============================================================
  // Two shapes: the normal one, and the first login of an account whose
  // password is still the shared class one, where Cognito demands a new
  // password before it hands out any token.
  let pendingChallenge = null;
  let registerMode = false;

  function reflectLoginState() {
    const loggedIn = isLoggedIn();
    if ($btnPush) $btnPush.disabled = !loggedIn;
    $btnHistory.disabled = !loggedIn;
    $btnRestore.disabled = !loggedIn;
    $btnLogin.textContent = loggedIn ? 'Logout' : 'Login';
  }

  function maybeForgetRememberedLogin(err) {
    if (!err || !err.type || !Sync.forgetRememberedLogin) return;
    if (err.type === 'NotAuthorizedException'
        || err.type === 'UserNotFoundException'
        || err.type === 'PasswordResetRequiredException') {
      Sync.forgetRememberedLogin();
    }
  }

  function shouldRetryWithCookie(err) {
    if (!Sync.rememberedLogin || !Sync.rememberedLogin()) return false;
    const message = (err && err.message) || '';
    const type = (err && err.type) || '';
    // Only retry on authentication / session errors, not on transient AWS issues
    return type === 'NotAuthorizedException'
      || type === 'ExpiredTokenException'
      || message === 'Not logged in.'
      || message === 'Session expired. Log in again.';
  }

  async function withAutoLogin(work) {
    try {
      return await work();
    } catch (err) {
      if (!shouldRetryWithCookie(err)) throw err;
      const ok = await tryAutoLogin(true);
      if (!ok) throw err;
      return work();
    }
  }

  async function tryAutoLogin(force) {
    if (!syncAvailable() || !Sync.rememberedLogin) return false;
    const remembered = Sync.rememberedLogin();
    if (!remembered || !remembered.username || !remembered.password) return false;
    if (isLoggedIn()) {
      if (!force) return false;
      if (Sync.dropSession) Sync.dropSession();
      reflectLoginState();
    }
    try {
      const res = await Sync.login(remembered.username, remembered.password);
      if (res.status !== 'ok') {
        if (Sync.forgetRememberedLogin) Sync.forgetRememberedLogin();
        return false;
      }
      reflectLoginState();
      refreshStatus();
      return true;
    } catch (err) {
      maybeForgetRememberedLogin(err);
      return false;
    }
  }

  function showLogin() {
    if (!syncAvailable()) { setSyncNote(SYNC_MISSING); return; }
    $loginModal.classList.remove('hidden');
    $loginError.textContent = '';
    showNewPasswordField(false);
    setRegisterMode(false);
    const remembered = Sync.rememberedLogin ? Sync.rememberedLogin() : null;
    $loginUser.value = currentUser() || (remembered ? remembered.username : '') || '';
    $loginPass.value = remembered ? remembered.password : '';
    if ($loginUser.value) $loginPass.focus();
    else $loginUser.focus();
  }
  function hideLogin() {
    $loginModal.classList.add('hidden');
    pendingChallenge = null;
    showNewPasswordField(false);
  }
  function showNewPasswordField(on) {
    $loginNewRow.classList.toggle('hidden', !on);
    if (on) { $loginNew.value = ''; $loginNew.focus(); }
  }
  // Register mode: same user/password fields, plus the class password that
  // the PreSignUp trigger checks. The account is then the student's own.
  function setRegisterMode(on) {
    registerMode = on;
    $loginKeyRow.classList.toggle('hidden', !on);
    $loginSwitchRegister.classList.toggle('hidden', on);
    $loginSwitchLogin.classList.toggle('hidden', !on);
    $loginOk.textContent = on ? 'Register' : 'Login';
    $loginPass.autocomplete = on ? 'new-password' : 'current-password';
    $loginError.textContent = '';
    if (on) $loginKey.value = '';
  }

  async function handleRegister(user, pass) {
    const key = $loginKey.value;
    if (!user || !pass || !key) { $loginError.textContent = 'All three fields required.'; return; }
    if (pass.length < 8) { $loginError.textContent = 'Your password: at least 8 characters.'; return; }
    $loginError.textContent = 'Creating your account...';
    try {
      await Sync.signUp(user, pass, key);
      hideLogin();
      await afterLogin();
    } catch (err) {
      $loginError.textContent = err.message;
    }
  }

  async function handleLogin() {
    const user = $loginUser.value.trim();
    const pass = $loginPass.value;

    // Second step: the student is choosing their own password
    if (pendingChallenge) {
      const fresh = $loginNew.value;
      if (fresh.length < 8) { $loginError.textContent = 'At least 8 characters.'; return; }
      $loginError.textContent = 'Setting your password...';
      try {
        await Sync.setNewPassword(pendingChallenge.username, pendingChallenge.session, fresh);
        hideLogin();
        await afterLogin();
      } catch (err) {
        $loginError.textContent = err.message;
      }
      return;
    }

    if (registerMode) { await handleRegister(user, pass); return; }
    if (!user || !pass) { $loginError.textContent = 'Both fields required.'; return; }
    $loginError.textContent = 'Signing in...';
    try {
      const res = await Sync.login(user, pass);
      if (res.status === 'new-password-required') {
        pendingChallenge = res;
        $loginError.textContent = 'First login: choose your own password.';
        showNewPasswordField(true);
        return;
      }
      hideLogin();
      await afterLogin();
    } catch (err) {
      $loginError.textContent = err.message;
    }
  }

  // What a login does with the work already in this browser.
  //
  // Same student as last time (or nobody was ever logged in here, which is
  // the late-login case: weeks of local work, account made today): merge.
  // The done list becomes the union, remote scripts only fill local gaps,
  // and whatever this browser has that the server lacks is uploaded --
  // nothing is removed on either side. A B4 solved offline lands in the
  // bucket; a C2 solved on the phone shows up here.
  //
  // A *different* student than the last one logged in on this browser: the
  // clean switch (force restore), so one student's code is never carried
  // over to, or re-submitted under, another's account.
  const LAST_USER_KEY = 'py_classroom_last_user_' + SET_KEY;

  function hasLocalProgress() {
    return getDoneList().length > 0 || exercises.some(ex =>
      localStorage.getItem(CODE_PREFIX + ex.id) || getSolved(ex.id));
  }

  async function afterLogin() {
    reflectLoginState();
    refreshStatus();
    const user = currentUser();
    const lastUser = localStorage.getItem(LAST_USER_KEY);
    const switching = !!lastUser && lastUser !== user;
    localStorage.setItem(LAST_USER_KEY, user);
    try {
      const res = await pullProgress(true, switching);
      if (!switching && hasLocalProgress()) {
        await pushProgress(true);
        setSyncNote(res.found
          ? 'Merged with the server: ' + getDoneList().length
            + ' completed. Your local work was uploaded too.'
          : 'Your work from this browser is now saved on the server: '
            + getDoneList().length + ' completed.');
      }
    } catch (err) {
      setSyncNote('Could not sync your submission: ' + err.message);
      console.error(err);
    }
  }

  function handleLogout() {
    Sync.logout();
    reflectLoginState();
    setSyncNote('Logged out. Your work stays in this browser.');
  }


  // === Event bindings ===
  $btnRun.addEventListener('click', runCode);
  $btnCheck.addEventListener('click', checkCode);
  $btnReset.addEventListener('click', resetCode);
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
  $btnLogin.addEventListener('click', () => {
    if (isLoggedIn()) handleLogout(); else showLogin();
  });
  $btnHistory.addEventListener('click', showHistory);
  $btnRestore.addEventListener('click', forceRestore);
  $loginOk.addEventListener('click', handleLogin);
  $loginCancel.addEventListener('click', hideLogin);
  $loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $loginNew.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $loginKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $loginSwitchRegister.addEventListener('click', (e) => { e.preventDefault(); setRegisterMode(true); $loginKey.focus(); });
  $loginSwitchLogin.addEventListener('click', (e) => { e.preventDefault(); setRegisterMode(false); });

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

  // A login is optional: without one everything still runs, checks, marks
  // exercises green, and downloads. Only Submit and History need it.
  Sync.restore();
  const bootLogin = syncAvailable() && !isLoggedIn()
    ? tryAutoLogin()
    : Promise.resolve(isLoggedIn());
  if (!syncAvailable()) {
    // No cloud on this deployment: say so on the buttons, once
    $btnLogin.disabled = true;
    $btnLogin.title = SYNC_MISSING;
    if ($btnPush) $btnPush.title = SYNC_MISSING;
    $btnHistory.title = SYNC_MISSING;
    $btnRestore.title = SYNC_MISSING;
  } else {
    reflectLoginState();
  }

  // === Boot ===
  repaint();
  loadHistory();
  migrateLegacyKeys();
  initWorker();
  loadManifest().then(async () => {
    await bootLogin;
    refreshStatus();
    // Already logged in from a previous visit, or auto-logged in from the
    // remembered cookie: bring the work back quietly.
    if (!syncAvailable() || !isLoggedIn()) return;
    try { await pullProgress(false); }
    catch (err) {
      // An expired refresh token lands here: ask for a login, do not shout
      setSyncNote('Log in again to sync your work.');
      console.error('Could not restore progress:', err);
    }
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
