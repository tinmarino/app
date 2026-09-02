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
import ast, codeop, json, sys, traceback
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
_REPL_KEEP = {"ast", "codeop", "json", "sys", "traceback", "pyodide", "_REPL_KEEP"}


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

def _repl_chunks(src):
    """ Split the source into its top-level statements, as the REPL would want
    them typed: one compound statement per chunk. Returns (chunks, tail):
    the tail is the part after the last statement that parses on its own,
    or None. Whole-source parse failing means the LAST statement is
    unfinished (or wrong), so the tail is what codeop has to judge, while the
    head is only run once the whole thing is complete.
    """
    lines = src.split("\\n")
    for cut in range(len(lines), -1, -1):
        head = "\\n".join(lines[:cut])
        try:
            tree = ast.parse(head)
        except SyntaxError:
            continue
        chunks = ["\\n".join(lines[node.lineno - 1:node.end_lineno]) for node in tree.body]
        tail = "\\n".join(lines[cut:])
        return chunks, (tail if tail.strip() else None)
    return [], src


async def _repl_push_one(console, chunk, force):
    # Console.push() appends to its own buffer and only clears it when the
    # result is not INCOMPLETE. Left alone, an unfinished block stays in that
    # buffer and the next, unrelated command is compiled glued to it -- which
    # surfaces as a SyntaxError pointing at code the student already ran. So
    # each chunk starts from a clean buffer.
    console.buffer.clear()
    fut = console.push(chunk)
    status = fut.syntax_check
    # codeop wants the blank line that ends a suite in a real REPL: supply it
    # for a complete compound statement (a chunk the parser already accepted)
    # and for Ctrl+Enter, "run it now".
    if status == "incomplete" and force:
        fut = console.push("")
        status = fut.syntax_check
    return fut, status


async def _repl_push_json(src, force=False):
    console = _repl_state["console"]
    out, err = [], []
    console.stdout_callback = out.append
    console.stderr_callback = err.append

    # The caller sends the COMPLETE source, possibly several statements: a
    # pasted script, or "i = 3 / j = 4 / for ..." typed with Shift+Enter.
    # codeop compiles in "single" mode, so that whole text at once is a
    # SyntaxError ("multiple statements found"); feed it statement by
    # statement instead, as a person would at a real prompt. When the source
    # does not parse at all, push it whole so the status is "incomplete"
    # (unfinished block: hand it back) or a real syntax error.
    chunks, tail = _repl_chunks(src)
    if tail is not None:
        # Unfinished (or wrong) last statement: nothing runs yet. Ask codeop
        # which it is, on the tail alone and without executing anything, so an
        # unfinished block is handed back to the editor instead of failing as
        # "multiple statements". Ctrl+Enter runs it as it stands.
        try:
            complete = codeop.compile_command(tail, "<console>", "single") is not None
        except (SyntaxError, ValueError, OverflowError):
            return json.dumps({"status": "error", "stdout": "", "stderr": "",
                               "repr": None,
                               "error": _repl_trunc(traceback.format_exc(limit=0))})
        if not complete and not force:
            return json.dumps({"status": "incomplete", "stdout": "", "stderr": "",
                               "repr": None, "error": None})
        chunks = chunks + [tail]

    def _fail(fut, reps):
        return json.dumps({"status": "error",
                           "stdout": _repl_trunc("".join(out)),
                           "stderr": _repl_trunc("".join(err)),
                           "repr": "\\n".join(reps) or None,
                           "error": _repl_trunc(fut.formatted_error or "")})

    reps = []
    for chunk in chunks:
        # Every chunk is complete by now, so the closing blank line is implied.
        fut, status = await _repl_push_one(console, chunk, True)
        if status == "incomplete":
            return json.dumps({"status": "incomplete", "stdout": "", "stderr": "",
                               "repr": None, "error": None})
        if status == "syntax-error":
            return _fail(fut, reps)
        # Run each statement to the end before pushing the next one, so
        # execution order and a mid-script exception behave as at a real prompt.
        try:
            res = await fut
        except BaseException:
            return _fail(fut, reps)
        if res is not None:
            console.globals["_"] = res
            try:
                reps.append(_repl_trunc(repr(res), 4000))
            except BaseException as exc:
                reps.append("<unreprable: %s>" % exc)
    return json.dumps({"status": "ok",
                       "stdout": _repl_trunc("".join(out)),
                       "stderr": _repl_trunc("".join(err)),
                       "repr": "\\n".join(reps) or None, "error": None})

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
