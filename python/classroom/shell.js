/* shell.js — the standalone IPyodide console.
 *
 * Same engine as the classroom console: pyodide.console.Console in the worker
 * (real codeop block detection, rlcompleter completion, real tracebacks) and
 * the shared indent/colour helpers from pyutil.js. What is different here is
 * only the shell: full screen, no exercise machinery, and built for a phone.
 */
(function () {
  'use strict';

  const {
    esc, highlightPy, renderPyLine,
    INDENT, INDENT_N, stripLiterals, bracketDepth, indentAfter,
    smartNewline, smartBackspace
  } = window.PyUtil;

  const PYODIDE_URL = new URL('vendor/pyodide/314.0.6/pyodide/pyodide.mjs', location.href).href;
  const WORKER_URL  = new URL('pyodide-worker.js', location.href).href;

  const HISTORY_KEY = 'ipyodide_history';
  const HISTORY_MAX = 300;

  const $terminal = document.getElementById('terminal');
  const $screen   = document.getElementById('output');
  const $input    = document.getElementById('input');
  const $prompt   = document.getElementById('prompt');
  const $keyrow   = document.getElementById('keyrow');

  let workerMgr = null;
  let busy = false;
  let history = [];
  let historyIdx = 0;
  let draft = '';

  // ---------------------------------------------------------------- output
  function append(text, cls, kind) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    if (kind === 'code') {
      const m = text.match(/^(>>> |\.\.\. )?([\s\S]*)$/);
      span.innerHTML = '<span class="tb-prompt">' + esc(m[1] || '') + '</span>' + highlightPy(m[2]);
    } else if (kind === 'error') {
      span.innerHTML = text.split('\n').map(renderPyLine).join('\n');
    } else {
      span.textContent = text;
    }
    $screen.appendChild(span);
    scrollToBottom();
    return span;
  }

  // The prompt lives at the end of the same scrolling box as the output, so
  // "scroll to the bottom" is a property of the terminal, not of the output.
  function scrollToBottom() {
    $terminal.scrollTop = $terminal.scrollHeight;
  }

  function setPrompt(cont) { $prompt.textContent = cont ? '...' : '>>>'; }

  function autoGrow() {
    $input.style.height = 'auto';
    $input.style.height = $input.scrollHeight + 'px';
    scrollToBottom();
  }
  function setInput(value) {
    $input.value = value;
    setPrompt(value.includes('\n'));
    autoGrow();
  }

  // ---------------------------------------------------------------- history
  function loadHistory() {
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { history = []; }
    historyIdx = history.length;
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX))); }
    catch { /* private mode or quota: history simply will not persist */ }
  }
  function historyPrev() {
    if (historyIdx === history.length) draft = $input.value;
    if (historyIdx <= 0) return;
    historyIdx--;
    setInput(history[historyIdx]);
    $input.selectionStart = $input.selectionEnd = $input.value.length;
  }
  function historyNext() {
    if (historyIdx >= history.length) return;
    historyIdx++;
    setInput(historyIdx === history.length ? draft : history[historyIdx]);
    $input.selectionStart = $input.selectionEnd = $input.value.length;
  }

  // ---------------------------------------------------------------- help
  const HELP_TEXT = [
    'IPyodide — Python in your browser. One pane, one prompt, no server.',
    '',
    'Keys',
    '  Enter              run the block (a line ending in ":" opens a new line instead)',
    '  Shift+Enter        always open a new line, indented for you',
    '  Ctrl+Enter         force run, even an unfinished block',
    '  Tab                complete names and attributes, or indent',
    '  Up / Down          move inside the block; at the edges, browse history',
    '  Ctrl+Up / Down     browse history directly',
    '  Backspace          delete a whole indent level inside leading whitespace',
    '  Ctrl+U             clear the input     Ctrl+L  clear the screen',
    '  Ctrl+C             stop and restart Python (the only escape from a hang)',
    '',
    'Magics',
    '  !help  %help  ?    this message',
    '  %clear  !clear     clear the screen',
    '  %who               list the names you have defined',
    '  %time <expr>       time one evaluation',
    '  %timeit <expr>     time it repeatedly, report the best run',
    '  %reset             forget every name and start fresh',
    '  %stop  %restart    restart the Python runtime',
    '  %exercises         go to the guided Python exercises',
    '  <obj>?             show help(<obj>)',
    '',
    'On a phone the extra key row above the keyboard types the characters Python',
    'needs most, and doubles as history arrows.',
    '',
    'Everything runs locally in this tab. Nothing is uploaded. Top-level await',
    'works, and `_` holds the last result.'
  ].join('\n');

  // Returns Python source to run, '' when handled here, or null to pass through
  function applyMagic(src) {
    const line = src.trim();
    if (line === '?' || line === '!help' || line === '%help') { append(HELP_TEXT, 'help'); return ''; }
    if (line === '%clear' || line === '!clear') { $screen.innerHTML = ''; return ''; }
    if (line === '%stop' || line === '%restart') { restart(); return ''; }
    if (line === '%exercises' || line === '!exercises') {
      // Navigate the whole tab, or just this frame when embedded in the site
      window.location.href = '/class/python-exercices/';
      return '';
    }
    if (line === '%reset') {
      busy = true;
      workerMgr.resetNamespace()
        .then(res => append(res && res.status === 'ok'
          ? 'Namespace cleared.'
          : 'Reset failed: ' + ((res && res.error) || 'unknown'),
          res && res.status === 'ok' ? 'help' : 'error'))
        .catch(err => append('Reset failed: ' + err.message, 'error'))
        .finally(() => { busy = false; });
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
           + 'print(f"best of 5: {min(_ti.repeat(lambda: (' + m[1]
           + '), number=100, repeat=5)) / 100 * 1e6:.1f} us per loop")';
    }
    if ((m = line.match(/^([A-Za-z_][\w.]*)\?\??$/))) return 'help(' + m[1] + ')';
    return null;
  }

  // ---------------------------------------------------------------- submit
  async function submit(force) {
    if (busy) {
      append('Python is still busy running your last command. '
           + 'Press Ctrl+C (or type %stop) to restart it.', 'error');
      return;
    }
    const src = $input.value;
    if (!src.trim()) { setInput(''); return; }

    const echoNodes = src.split('\n').map((l, i) =>
      append((i === 0 ? '>>> ' : '... ') + l, null, 'code'));

    if (history[history.length - 1] !== src) history.push(src);
    historyIdx = history.length;
    draft = '';
    saveHistory();
    setInput('');

    const magic = applyMagic(src);
    if (magic === '') return;

    let res;
    busy = true;
    try {
      res = await workerMgr.runConsole(magic === null ? src : magic, force);
    } catch (err) {
      append((err && err.message) || String(err), 'error');
      return;
    } finally {
      busy = false;
    }

    if (res.status === 'incomplete' && !force) {
      // Python says the block is unfinished: hand it back with a fresh line
      const back = src.replace(/\n+$/, '');
      echoNodes.forEach(node => { if (node && node.parentNode) node.remove(); });
      history.pop();
      historyIdx = history.length;
      setInput(back + '\n' + indentAfter(back));
      $input.selectionStart = $input.selectionEnd = $input.value.length;
      $input.focus();
      return;
    }

    if (res.stdout) append(res.stdout.replace(/\n$/, ''));
    if (res.stderr) append(res.stderr.replace(/\n$/, ''), 'error', 'error');
    if (res.error)  append(res.error.replace(/\n$/, ''), 'error', 'error');
    if (res.repr)   append(res.repr, 'repr');
  }

  // ---------------------------------------------------------------- complete
  function commonPrefix(list) {
    if (!list.length) return '';
    let pre = list[0];
    for (const item of list) { while (pre && !item.startsWith(pre)) pre = pre.slice(0, -1); }
    return pre;
  }

  async function complete() {
    const at = $input.selectionStart;
    const before = $input.value.slice(0, at);
    const word = (before.match(/[\w.]*$/) || [''])[0];
    if (!word) {
      $input.value = before + INDENT + $input.value.slice(at);
      $input.selectionStart = $input.selectionEnd = at + INDENT_N;
      autoGrow();
      return;
    }
    let matches, start;
    try { ({ matches, start } = await workerMgr.complete(before)); }
    catch { return; }
    if (!matches || !matches.length) return;
    // `start` is a Python code-point offset, not a UTF-16 one
    const head = Array.from(before).slice(0, start).join('');
    const insert = matches.length === 1 ? matches[0] : commonPrefix(matches);
    if (insert && head + insert !== before) {
      $input.value = head + insert + $input.value.slice(at);
      $input.selectionStart = $input.selectionEnd = (head + insert).length;
      autoGrow();
    }
    if (matches.length > 1) append(matches.join('    '), 'completions');
  }

  // ---------------------------------------------------------------- keys
  function caretLine() {
    return $input.value.slice(0, $input.selectionStart).split('\n').length - 1;
  }
  function lineCount() { return $input.value.split('\n').length; }

  function newline() {
    smartNewline($input, () => { setPrompt(true); autoGrow(); });
  }

  $input.addEventListener('input', () => {
    setPrompt($input.value.includes('\n'));
    autoGrow();
  });

  $input.addEventListener('keydown', async (e) => {
    const val = $input.value;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { await submit(true); return; }
      if (e.shiftKey) { newline(); return; }
      // Plainly unfinished code keeps editing; otherwise run it, and if Python
      // disagrees submit() hands the buffer back with a new line.
      const upToCaret = stripLiterals(val.slice(0, $input.selectionStart)).split('\n').pop();
      if (bracketDepth(val) > 0 || /:[ \t]*$/.test(upToCaret) || /\\$/.test(val.trimEnd())) {
        newline();
        return;
      }
      await submit(false);
      return;
    }

    if (e.key === 'Tab') { e.preventDefault(); await complete(); return; }
    if (e.key === 'Backspace' && smartBackspace($input, e, autoGrow)) return;

    if (e.key === 'ArrowUp') {
      if (e.ctrlKey || caretLine() === 0) { e.preventDefault(); historyPrev(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (e.ctrlKey || caretLine() === lineCount() - 1) { e.preventDefault(); historyNext(); }
      return;
    }
    if (e.ctrlKey && e.key === 'c' && !window.getSelection().toString()) {
      // Only when nothing is selected, so Ctrl+C still copies
      e.preventDefault();
      restart();
      return;
    }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $screen.innerHTML = ''; return; }
    if (e.ctrlKey && e.key === 'u') { e.preventDefault(); setInput(''); return; }
  });


  // The extra key row: insert a character, or act as history arrows
  $keyrow.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'up') { historyPrev(); $input.focus(); return; }
    if (act === 'down') { historyNext(); $input.focus(); return; }
    if (act === 'newline') { newline(); $input.focus(); return; }
    const text = btn.dataset.ins;
    if (text == null) return;
    const at = $input.selectionStart;
    $input.value = $input.value.slice(0, at) + text + $input.value.slice($input.selectionEnd);
    $input.selectionStart = $input.selectionEnd = at + text.length;
    autoGrow();
    $input.focus();
  });

  // One pane, one focus: clicking anywhere in the terminal types into it,
  // the way a real console behaves. Except while selecting text to copy.
  $terminal.addEventListener('click', () => {
    const selection = window.getSelection();
    if (selection && String(selection).length) return;
    $input.focus();
  });
  // A keystroke anywhere on the page belongs to the prompt
  document.addEventListener('keydown', e => {
    if (e.target === $input) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace' && e.key !== 'Enter') return;
    $input.focus();
  });

  // ---------------------------------------------------------------- swipe
  // The shell has no sidebar of its own, so every horizontal swipe belongs to
  // the site around it: it is how the left bars are revealed when this page
  // fills the frame. A cross-origin parent cannot read these events itself.
  const SWIPE_MIN = 60, SWIPE_SLOP = 40;
  let touchStart = null;

  document.addEventListener('touchstart', e => {
    touchStart = e.touches.length === 1
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : null;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touchStart || window.parent === window) { touchStart = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dy) > SWIPE_SLOP || Math.abs(dx) < SWIPE_MIN) return;
    try {
      window.parent.postMessage(
        { type: 'tinmarino-swipe', dir: dx > 0 ? 'right' : 'left' }, '*');
    } catch { /* nothing we can do */ }
  }, { passive: true });

  // ---------------------------------------------------------------- runtime
  function boot() {
    workerMgr = new PyodideWorkerManager(PYODIDE_URL, WORKER_URL);
    workerMgr.init();
    const loading = append('Downloading Python…', 'notice');
    workerMgr.readyPromise.then(() => {
      loading.remove();
      append((workerMgr.banner || 'Python ready') + '\nType !help for the keys and magics.', 'help');
      $input.focus();
    }).catch(err => {
      loading.remove();
      append('Python failed to load: ' + err.message + '\nReload the page to try again.', 'error');
    });
  }

  function restart() {
    workerMgr.terminate();
    busy = false;
    append('^C  runtime stopped, restarting…', 'notice');
    workerMgr.init();
    workerMgr.readyPromise
      .then(() => append('Python ready. Your names were cleared.', 'help'))
      .catch(err => append('Restart failed: ' + err.message, 'error'));
    $input.focus();
  }

  loadHistory();
  autoGrow();
  boot();
})();
