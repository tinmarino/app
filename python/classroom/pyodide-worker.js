/* pyodide-worker.js
 * Runs Pyodide inside a dedicated module Worker file.
 * Receives an absolute URL for pyodide.mjs via the 'init' message.
 *
 * The interactive console is NOT hand-rolled: it delegates to
 * pyodide.console.Console, the stdlib-based incremental interpreter Pyodide
 * ships. That gives us real codeop-based "is this block finished?" detection,
 * rlcompleter tab completion, proper tracebacks and top-level await, all
 * sharing one namespace with the Run/Check buttons.
 */

let pyodide = null;
let replPush = null;      // async (src) -> JSON string
let replComplete = null;  // (src)       -> JSON string
let replReset = null;

/* ── helpers ──────────────────────────────────────────────── */
// A runaway `for i in range(10**6): print(i)` produces megabytes; posting all of
// it and letting the main thread regex + Prism it into innerHTML freezes the tab
// (a phone for many seconds) long after the worker is done. Cap it, as the
// console path already caps its own output.
const OUT_LIMIT = 20000;
function truncOut(text) {
  return text.length <= OUT_LIMIT
    ? text
    : text.slice(0, OUT_LIMIT) + '\n...<output truncated>';
}

function capture(fn) {
  let stdout = '', stderr = '';
  pyodide.setStdout({ batched: s => { stdout += s + '\n'; } });
  pyodide.setStderr({ batched: s => { stderr += s + '\n'; } });
  let result = null, error = null;
  try { result = fn(); }
  catch (e) { error = e.message || String(e); }
  return {
    stdout: truncOut(stdout.trimEnd()),
    stderr: truncOut(stderr.trimEnd()),
    result,
    error
  };
}

/* Python side of the REPL. Returns JSON strings so nothing but plain data
 * crosses the JS boundary (no PyProxy lifetimes to manage). */
const REPL_SETUP = `
import json, sys
import pyodide.console

_repl_state = {"console": None}

def _repl_make():
    # globals() here is the __main__ namespace, the same one runPython uses,
    # so anything defined by Run/Check is visible in the console and vice versa.
    _repl_state["console"] = pyodide.console.Console(globals=globals(), filename="<console>")

_repl_make()

# Names the REPL machinery itself needs. Deleting these (json, sys, pyodide)
# is what a naive "clear everything public" loop does, and it breaks the console
# while reporting success -- so keep them explicitly.
_REPL_KEEP = {"json", "sys", "pyodide", "_REPL_KEEP"}


def _repl_reset_json():
    victims = [k for k in globals()
               if not k.startswith("_") and k not in _REPL_KEEP]
    for k in victims:
        del globals()[k]
    _repl_make()
    return json.dumps({"status": "ok", "stdout": "", "stderr": "",
                       "repr": None, "error": None})

def _repl_trunc(text, limit=8000):
    return text if len(text) <= limit else text[:limit] + "\\n...<truncated>"

async def _repl_push_json(src, force=False):
    console = _repl_state["console"]
    out, err = [], []
    console.stdout_callback = out.append
    console.stderr_callback = err.append

    # The caller always sends the COMPLETE source, but Console.push() appends to
    # its own buffer and only clears it when the result is not INCOMPLETE. Left
    # alone, an unfinished block stays in that buffer and the next, unrelated
    # command is compiled glued to it -- which surfaces as a SyntaxError
    # pointing at code the student already ran. Start from a clean buffer.
    console.buffer.clear()
    fut = console.push(src)
    status = fut.syntax_check

    # Ctrl+Enter means "run it now". codeop still wants the blank line that ends
    # a suite in a real REPL, so supply it rather than silently doing nothing.
    if status == "incomplete" and force:
        fut = console.push("")
        status = fut.syntax_check

    if status == "incomplete":
        return json.dumps({"status": "incomplete", "stdout": "", "stderr": "",
                           "repr": None, "error": None})
    if status == "syntax-error":
        return json.dumps({"status": "error", "stdout": "", "stderr": "",
                           "repr": None, "error": fut.formatted_error or ""})
    try:
        res = await fut
    except BaseException:
        return json.dumps({"status": "error",
                           "stdout": _repl_trunc("".join(out)),
                           "stderr": _repl_trunc("".join(err)),
                           "repr": None,
                           "error": _repl_trunc(fut.formatted_error or "")})

    rep = None
    if res is not None:
        console.globals["_"] = res
        try:
            rep = _repl_trunc(repr(res), 4000)
        except BaseException as exc:
            rep = "<unreprable: %s>" % exc
    return json.dumps({"status": "ok",
                       "stdout": _repl_trunc("".join(out)),
                       "stderr": _repl_trunc("".join(err)),
                       "repr": rep, "error": None})

def _repl_complete_json(src):
    try:
        matches, start = _repl_state["console"].complete(src)
        return json.dumps({"matches": sorted(set(matches)), "start": start})
    except BaseException:
        return json.dumps({"matches": [], "start": 0})

def _repl_banner():
    return "Python %s on Pyodide (%s)" % (
        sys.version.split()[0], sys.platform)
`;

/* ── message handler ──────────────────────────────────────── */
self.onmessage = async function (e) {
  const msg = e.data;

  /* ── init ── */
  if (msg.type === 'init') {
    try {
      const { loadPyodide } = await import(msg.pyodideUrl);
      pyodide = await loadPyodide();
      pyodide.runPython(REPL_SETUP);
      replPush     = pyodide.globals.get('_repl_push_json');
      replComplete = pyodide.globals.get('_repl_complete_json');
      replReset    = pyodide.globals.get('_repl_reset_json');
      const banner = pyodide.globals.get('_repl_banner')();
      postMessage({ type: 'ready', banner });
    } catch (err) {
      postMessage({ type: 'error', error: String(err) });
    }
    return;
  }

  if (!pyodide) {
    postMessage({ type: 'error', error: 'Pyodide not ready yet' });
    return;
  }

  /* ── run (exec, used by the Run and Check buttons) ── */
  if (msg.type === 'run') {
    const res = capture(() => {
      if (msg.fresh) {
        // Check grades in a throwaway namespace: a name left in __main__ by an
        // earlier Run or a console command must NOT stand in for a definition the
        // student has since renamed or deleted, or Check would pass broken code.
        // Run and the console stay on __main__, so they still share state.
        const ns = pyodide.toPy({});
        try { pyodide.runPython(msg.code, { globals: ns }); }
        finally { ns.destroy(); }
      } else {
        pyodide.runPython(msg.code);
      }
    });
    postMessage({ type: 'result', ...res });
    return;
  }

  /* ── console: one push into the incremental interpreter ── */
  if (msg.type === 'console') {
    let res;
    try {
      res = JSON.parse(await replPush(msg.code, !!msg.force));
    } catch (err) {
      res = { status: 'error', stdout: '', stderr: '', repr: null, error: String(err) };
    }
    postMessage({ type: 'console-result', ...res });
    return;
  }

  /* ── console: tab completion ── */
  if (msg.type === 'complete') {
    let res;
    try {
      res = JSON.parse(replComplete(msg.code));
    } catch (err) {
      res = { matches: [], start: 0 };
    }
    postMessage({ type: 'complete-result', ...res });
    return;
  }

  /* ── console: wipe the namespace ── */
  if (msg.type === 'reset-namespace') {
    let res;
    try { res = JSON.parse(replReset()); }
    catch (err) { res = { status: 'error', error: String(err) }; }
    postMessage({ type: 'console-result', ...res });
    return;
  }
};
