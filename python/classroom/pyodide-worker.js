/* pyodide-worker.js
 * Runs Pyodide inside a dedicated module Worker file.
 * Receives an absolute URL for pyodide.mjs via the 'init' message.
 */

let pyodide = null;

/* ── helpers ──────────────────────────────────────────────── */
function capture(fn) {
  let stdout = '', stderr = '';
  pyodide.setStdout({ batched: s => { stdout += s + '\n'; } });
  pyodide.setStderr({ batched: s => { stderr += s + '\n'; } });
  let result = null, error = null;
  try { result = fn(); }
  catch (e) { error = e.message || String(e); }
  return {
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
    result,
    error
  };
}

/* ── message handler ──────────────────────────────────────── */
self.onmessage = async function (e) {
  const msg = e.data;

  /* ── init ── */
  if (msg.type === 'init') {
    try {
      const { loadPyodide } = await import(msg.pyodideUrl);
      pyodide = await loadPyodide();
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', error: String(err) });
    }
    return;
  }

  if (!pyodide) {
    postMessage({ type: 'error', error: 'Pyodide not ready yet' });
    return;
  }

  /* ── run (exec) ── */
  if (msg.type === 'run') {
    const res = capture(() => { pyodide.runPython(msg.code); });
    postMessage({ type: 'result', ...res });
    return;
  }

  /* ── console (REPL: eval-then-exec) ── */
  if (msg.type === 'console') {
    let res = capture(() => {
      // Try as expression first — compile(..., 'eval') throws SyntaxError for statements
      let val;
      try {
        val = pyodide.runPython(
          `eval(compile(${JSON.stringify(msg.code)}, '<stdin>', 'eval'))`
        );
      } catch (_) {
        // Not an expression: run as statement (exec mode)
        pyodide.runPython(msg.code);
        return null;  // no repr for statements
      }
      // Store in _ like a real REPL
      pyodide.globals.set('_', val);
      const none = pyodide.globals.get('None');
      if (val !== none && val !== undefined && val !== null) {
        return String(pyodide.runPython('repr(_)'));
      }
      return null;
    });
    postMessage({ type: 'console-result', ...res });
    return;
  }
};
