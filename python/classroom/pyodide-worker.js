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
let checkRun = null;      // (code) -> failure text or None

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
import ast, codeop, io, json, linecache, re, sys, traceback
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
_REPL_KEEP = {"ast", "codeop", "io", "json", "linecache", "re", "sys", "traceback",
              "pyodide", "_REPL_KEEP"}


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

# ---------------------------------------------------------------- Check
# Check runs the student's code plus the exercise's tests in a throwaway
# namespace. A failed assert is explained for a learner: which test, the
# call, what came back and what was expected, with the type of each and a
# hint about the usual cause. Any other exception keeps its traceback, plus a
# hint keyed on the message (task: make errors specific and easy to read).

_CHECK_HINTS = [
    (r"NameError: name '(\\w+)' is not defined",
     "'{0}' is not defined here. A typo? Or it is only defined inside another "
     "function? Check the parameter names in the signature too."),
    (r"'NoneType' object",
     "Something is None. A function with no 'return' gives None: make sure "
     "every path of your function returns a value (and that you did not "
     "'return' the result of print or of list.append, which are None)."),
    (r"can only concatenate str|unsupported operand type\\(s\\)|must be str, not|"
     r"not supported between instances",
     "You are mixing text and numbers. Convert first: str(number) to join "
     "text, int(text) or float(text) to compute."),
    (r"'(int|float)' object is not iterable",
     "You are looping over a number. To loop n times, loop over range(n)."),
    (r"object is not subscriptable",
     "You are indexing something that has no items ([...] only works on "
     "lists, strings, tuples and dicts)."),
    (r"takes (\\d+) positional arguments? but (\\d+) were given|missing \\d+ required positional",
     "Wrong number of arguments: compare your 'def' line with the signature "
     "in the Instructions."),
    (r"IndexError: (list|string) index out of range",
     "Valid indices go from 0 to len(...) - 1. Off by one? Empty input?"),
    (r"KeyError: (.+)",
     "The key {0} is not in the dictionary. Test with 'key in dct' first, or "
     "use dct.get(key, default)."),
    (r"RecursionError",
     "The function calls itself forever. Does the base case stop it, and does "
     "each call get closer to that base case?"),
    (r"ZeroDivisionError",
     "Division by zero: guard the case where the divisor is 0 (an empty list "
     "when computing an average, for instance)."),
    (r"'str' object has no attribute '(append|extend|insert|pop|sort|reverse)'",
     "Strings have no .{0}(): they cannot be changed in place. Build a list "
     "and join it, or make a new string with +."),
    (r"AttributeError: '(\\w+)' object has no attribute '(\\w+)'",
     "A {0} has no .{1}. Check the type of that variable (print(type(x))) and "
     "the method's spelling."),
    (r"is not callable",
     "You put parentheses after something that is not a function: a variable "
     "shadowing a function name, or a list indexed with (i) instead of [i]?"),
    (r"IndentationError|expected an indented block|unexpected indent",
     "Indentation: every line after a ':' must be indented by 4 spaces, and "
     "lines of the same block must line up."),
    (r"SyntaxError",
     "Python could not read that line: a missing ':' at the end of an if/for/"
     "def, an unclosed quote or parenthesis, or '=' where you meant '=='?"),
]


def _check_trunc_repr(value, limit=300):
    try:
        text = repr(value)
    except BaseException as exc:
        text = "<unreprable: %s>" % exc
    return _repl_trunc(text, limit)


def _check_describe(value):
    return "%s   (%s)" % (_check_trunc_repr(value), type(value).__name__)


def _check_a(value):
    """ 'an int', 'a list': the type name with its article. """
    name = type(value).__name__
    return ("an " if name[:1] in "aeiou" else "a ") + name


def _check_compare_hint(got, exp):
    """ One line on the usual cause behind got != exp, or None. """
    if got is None:
        return ("Your function returned None: it reached the end without a "
                "'return', or you used print instead of return.")
    if callable(got) and not callable(exp):
        return ("You returned the function itself: call it with parentheses "
                "and return the result.")
    if type(got) is not type(exp):
        if isinstance(exp, str) and not isinstance(got, str):
            return ("A string (text) was expected but you returned %s: build "
                    "the text with str(...) or an f-string." % _check_a(got))
        if isinstance(exp, bool):
            return "True or False was expected, not %s." % _check_a(got)
        if isinstance(exp, (int, float)) and isinstance(got, str):
            return "A number was expected but you returned text: int(...) or float(...) converts."
        if isinstance(exp, list) and isinstance(got, (tuple, set, str, dict)):
            return ("A list was expected but you returned %s: wrap it with "
                    "list(...) or build a list with .append()." % _check_a(got))
        return ("%s was expected but your function returned %s."
                % (_check_a(exp).capitalize(), _check_a(got)))
    if isinstance(exp, str):
        if got.strip() == exp.strip():
            return "Only the spaces at the ends differ."
        if got.lower() == exp.lower():
            return "Only upper/lower case differs."
        if got == exp[::-1]:
            return "Your result is the expected one, reversed."
        if got.replace(" ", "") == exp.replace(" ", ""):
            return "Only the spaces differ."
        if exp in got:
            return "Your result contains extra text around the expected one."
        return None
    if isinstance(exp, (list, tuple)):
        if len(got) != len(exp):
            if sorted(map(repr, got)) == sorted(map(repr, exp)):
                return "Same items, different order."
            return "Expected %d item(s), got %d." % (len(exp), len(got))
        if sorted(map(repr, got)) == sorted(map(repr, exp)):
            return "Same items, different order."
        for i, (a, b) in enumerate(zip(got, exp)):
            if a != b:
                return "First difference at index %d: got %s, expected %s." % (
                    i, _check_trunc_repr(a, 80), _check_trunc_repr(b, 80))
        return None
    if isinstance(exp, dict):
        missing = [k for k in exp if k not in got]
        extra = [k for k in got if k not in exp]
        if missing:
            return "Missing key(s): %s." % ", ".join(map(repr, missing))
        if extra:
            return "Unexpected key(s): %s." % ", ".join(map(repr, extra))
        for k in exp:
            if got[k] != exp[k]:
                return "Key %r: got %s, expected %s." % (
                    k, _check_trunc_repr(got[k], 80), _check_trunc_repr(exp[k], 80))
        return None
    if isinstance(exp, set):
        missing, extra = exp - got, got - exp
        if missing:
            return "Missing: %s." % ", ".join(map(repr, missing))
        if extra:
            return "Unexpected: %s." % ", ".join(map(repr, extra))
    if isinstance(exp, bool):
        return None
    if isinstance(exp, (int, float)):
        diff = got - exp
        if diff in (1, -1):
            return "Off by one."
        if isinstance(exp, float) and abs(diff) < 1e-6:
            return "Almost: a rounding difference."
    return None


def _check_eval(node, ns):
    """ Evaluate one expression node again, silently. """
    real = sys.stdout
    sys.stdout = io.StringIO()
    try:
        return eval(compile(ast.Expression(node), "<check>", "eval"), ns)
    finally:
        sys.stdout = real


_CHECK_OPS = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">",
              ast.GtE: ">=", ast.In: "in", ast.NotIn: "not in", ast.Is: "is",
              ast.IsNot: "is not"}


def _check_explain_assert(code, tests_start, lineno, ns):
    """ Lines explaining the assert at 'lineno' of 'code', for a learner. """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    asserts = [n for n in ast.walk(tree) if isinstance(n, ast.Assert)]
    node = next((n for n in asserts if n.lineno <= lineno <= (n.end_lineno or n.lineno)), None)
    if node is None:
        return None
    tests = [n for n in asserts if n.lineno > tests_start]
    lines = []
    if node in tests:
        before = tests.index(node)
        lines.append("Test %d of %d failed%s." % (
            before + 1, len(tests),
            " (the %d before it passed)" % before if before else ""))
    src = ast.get_source_segment(code, node.test) or "?"

    test = node.test
    if isinstance(test, ast.Compare) and len(test.ops) == 1:
        lines.append("Test:      " + " ".join(src.split()))
        op = _CHECK_OPS.get(type(test.ops[0]), "?")
        try:
            got = _check_eval(test.left, ns)
            exp = _check_eval(test.comparators[0], ns)
        except BaseException as exc:      # the function is not even deterministic
            lines.append("Note:      re-running it raised %s: %s" % (type(exc).__name__, exc))
            got = exp = None
        else:
            call = ast.get_source_segment(code, test.left) or ""
            if isinstance(test.left, ast.Call):
                lines.append("Call:      " + " ".join(call.split()))
            if op == "==":
                lines.append("Got:       " + _check_describe(got))
                lines.append("Expected:  " + _check_describe(exp))
                hint = _check_compare_hint(got, exp)
            else:
                lines.append("Left:      " + _check_describe(got))
                lines.append("Right:     " + _check_describe(exp))
                hint = "The condition 'left %s right' is False." % op
            if hint:
                lines.append("Hint:      " + hint)
    elif node.msg is not None:
        try:
            msg = str(_check_eval(node.msg, ns))
        except BaseException:
            msg = ""
        if "banned shortcut" in msg:
            lines.append("Reason:    your code uses " + msg.split("banned shortcut", 1)[1].strip()
                         + ", which this exercise asks you to write by hand.")
        else:
            lines.append("Test:      " + " ".join(src.split()))
            if msg:
                lines.append("Reason:    " + msg)
    else:
        lines.append("Test:      " + " ".join(src.split()))
        lines.append("Reason:    this condition was False.")
    return lines


def _check_hint(error_text):
    for pattern, hint in _CHECK_HINTS:
        found = re.search(pattern, error_text)
        if found:
            return "Hint: " + hint.format(*found.groups())
    return None


def _check_run(code):
    """ Run code (student source + tests) in a fresh namespace.

    Returns None when everything passed, else the text to show under FAIL.
    """
    tests_start = 0
    for i, line in enumerate(code.split("\\n"), 1):
        if line.startswith("__student_code__ = "):
            tests_start = i
    ns = {"__name__": "__main__"}
    # Register the source so a traceback can quote the offending line, which
    # compile() from a string otherwise cannot do.
    linecache.cache["<exec>"] = (len(code), None, code.splitlines(True), "<exec>")
    try:
        exec(compile(code, "<exec>", "exec"), ns)
    except AssertionError as exc:
        tb = exc.__traceback__
        lineno = None
        for frame in traceback.extract_tb(tb):
            if frame.filename == "<exec>":
                lineno = frame.lineno
        explained = _check_explain_assert(code, tests_start, lineno, ns) if lineno else None
        if explained:
            return "\\n".join(explained)
        return "".join(traceback.format_exception(type(exc), exc, tb.tb_next))
    except BaseException as exc:
        # Skip this harness's own frame: the traceback starts at the student's code.
        text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__.tb_next))
        hint = _check_hint(text)
        return text.rstrip("\\n") + ("\\n\\n" + hint if hint else "")
    return None

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
      checkRun     = pyodide.globals.get('_check_run');
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
        // _check_run also turns a failed assert into a learner-readable
        // explanation (got / expected / hint) instead of a bare traceback.
        const fail = checkRun(msg.code);
        if (fail) throw new Error(fail);
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
