/* pyutil.js — helpers shared by the classroom (app.js) and the standalone
 * shell (shell.js): Python-aware indentation, and traceback colouring.
 *
 * Kept in one place because the two pages must behave identically: an Enter
 * key that indents differently in the shell than in the exercise editor is a
 * bug, not a variation.
 */
(function (global) {
  'use strict';

  // === Python output / traceback colouring ================================
  // Prism has no traceback grammar, so mark up the few line shapes CPython
  // emits and hand the embedded source lines to the python grammar.
  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightPy(code) {
    if (window.Prism && Prism.languages.python) {
      return Prism.highlight(code, Prism.languages.python, 'python');
    }
    return esc(code);
  }

  const TRACEBACK_HEAD_RE = /^Traceback \(most recent call last\):$/;
  const TRACEBACK_FRAME_RE = /^(\s*)File "(.*?)", line (\d+)(?:, in (.*))?$/;
  const TRACEBACK_FINAL_RE = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Warning|Exit))(:\s?)([\s\S]*)$/;

  function isInternalTracebackFile(file) {
    return file.startsWith('/lib/python') || file.includes('/_pyodide/') || file.startsWith('<frozen ');
  }

  // Pyodide often prepends one or two runtime frames before the student's own
  // frame. Drop only that leading prefix, without depending on exact line
  // numbers or file offsets, and keep the rest of the traceback untouched.
  function simplifyTracebackBlock(lines) {
    if (!lines.length || !TRACEBACK_HEAD_RE.test(lines[0])) return lines;

    const frames = [];
    let index = 1;
    while (index < lines.length) {
      const match = lines[index].match(TRACEBACK_FRAME_RE);
      if (!match) break;
      const frame = { file: match[2], lines: [lines[index]] };
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (TRACEBACK_FRAME_RE.test(line) || TRACEBACK_FINAL_RE.test(line)) break;
        frame.lines.push(line);
        index += 1;
      }
      frames.push(frame);
    }

    let firstStudent = 0;
    while (firstStudent < frames.length && isInternalTracebackFile(frames[firstStudent].file)) {
      firstStudent += 1;
    }
    if (firstStudent === 0 || firstStudent === frames.length) return lines;

    return [
      lines[0],
      ...frames.slice(firstStudent).flatMap(frame => frame.lines),
      ...lines.slice(index)
    ];
  }

  function simplifyTracebacks(text) {
    if (!text || !text.includes('Traceback (most recent call last):')) return text;
    const lines = text.split('\n');
    const out = [];
    let index = 0;

    while (index < lines.length) {
      if (!TRACEBACK_HEAD_RE.test(lines[index])) {
        out.push(lines[index]);
        index += 1;
        continue;
      }

      let next = index + 1;
      while (next < lines.length && !TRACEBACK_HEAD_RE.test(lines[next])) next += 1;
      out.push(...simplifyTracebackBlock(lines.slice(index, next)));
      index = next;
    }

    return out.join('\n');
  }

  function renderPyLine(line) {
    let m;

    // Our own banners
    if ((m = line.match(/^--- (ALL TESTS PASSED|.*?) ---$/))) {
      const ok = /ALL TESTS PASSED/.test(line);
      return '<span class="tb-banner ' + (ok ? 'tb-ok' : 'tb-bad') + '">' + esc(line) + '</span>';
    }

    // Traceback (most recent call last):
    if (/^Traceback \(most recent call last\):/.test(line)) {
      return '<span class="tb-head">' + esc(line) + '</span>';
    }

    //   File "/path/to.py", line 12, in func
    if ((m = line.match(TRACEBACK_FRAME_RE))) {
      return m[1] + '<span class="tb-kw">File </span>'
        + '<span class="tb-file">"' + esc(m[2]) + '"</span>'
        + '<span class="tb-kw">, line </span><span class="tb-line">' + m[3] + '</span>'
        + (m[4] ? '<span class="tb-kw">, in </span><span class="tb-func">' + esc(m[4]) + '</span>' : '');
    }

    // Caret / squiggle markers under the offending expression
    if (/^\s*[\^~]+\s*$/.test(line) || /^\s*[~\^]{2,}[~\^\s]*$/.test(line)) {
      return '<span class="tb-caret">' + esc(line) + '</span>';
    }

    // ...<5 lines>...  (CPython 3.13+ elision)
    if (/^\s*\.\.\..*\.\.\.\s*$/.test(line)) {
      return '<span class="tb-head">' + esc(line) + '</span>';
    }

    // ExceptionName: message   (at column 0, this is the final line)
    if ((m = line.match(TRACEBACK_FINAL_RE))) {
      return '<span class="tb-exc">' + esc(m[1]) + '</span>'
        + '<span class="tb-kw">' + esc(m[2]) + '</span>'
        + '<span class="tb-msg">' + esc(m[3]) + '</span>';
    }

    // Check's explanation of a failed test: "Got:       'hello'   (str)"
    if ((m = line.match(/^(Test|Call|Got|Expected|Left|Right|Reason|Note|Hint):(\s+)([\s\S]*)$/))) {
      const label = m[1];
      const cls = label === 'Hint' || label === 'Reason' ? 'tb-msg' : '';
      const value = cls ? '<span class="' + cls + '">' + esc(m[3]) + '</span>' : highlightPy(m[3]);
      return '<span class="tb-kw">' + label + ':</span>' + m[2] + value;
    }
    if ((m = line.match(/^(Test \d+ of \d+ failed.*|Hint: .*)$/))) {
      return '<span class="tb-exc">' + esc(line) + '</span>';
    }

    // Indented source echo -> real Python highlighting
    if (/^\s+\S/.test(line)) {
      const indent = line.match(/^\s*/)[0];
      return indent + highlightPy(line.slice(indent.length));
    }

    return esc(line);
  }

  // Paint `text` into `el`. Plain program output stays plain; tracebacks get
  // marked up line by line.
  function renderOutput(el, text) {
    if (!text) { el.textContent = ''; return; }
    el.innerHTML = simplifyTracebacks(text).split('\n').map(renderPyLine).join('\n');
  }

  // === Python smart indentation ==========================================
  // No small standalone library does this without dragging in a whole editor
  // (CodeMirror / Ace / Monaco each ship their own Python mode). These are the
  // same rules those modes apply, kept deliberately short:
  //   - a line ending in ':'        -> indent one level deeper
  //   - an unclosed '(', '[', '{'   -> indent one level deeper
  //   - return/pass/break/continue/raise -> dedent one level (leaves the suite)
  //   - otherwise                   -> keep the current indent
  const INDENT = '    ';
  const INDENT_N = 4;
  const DEDENT_RE = /^\s*(return|pass|break|continue|raise)\b/;

  // Blank out comments and string literals so brackets inside them don't count.
  // Length is preserved so caller offsets stay valid.
  function stripLiterals(src) {
    let out = '', quote = null, i = 0;
    while (i < src.length) {
      const c = src[i];
      if (quote) {
        if (c === '\\') {
          // Keep the newline: blanking it would merge two lines and make
          // indentAfter() inspect the wrong one.
          out += ' ' + (src[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (src.startsWith(quote, i)) { out += ' '.repeat(quote.length); i += quote.length; quote = null; continue; }
        out += (c === '\n' ? '\n' : ' ');
        i++;
        continue;
      }
      if (c === '#') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
      const triple = src.substr(i, 3);
      if (triple === '"""' || triple === "'''") { quote = triple; out += '   '; i += 3; continue; }
      if (c === '"' || c === "'") { quote = c; out += ' '; i++; continue; }
      out += c;
      i++;
    }
    return out;
  }

  // Net unclosed-bracket depth
  function bracketDepth(src) {
    let d = 0;
    for (const c of stripLiterals(src)) {
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d = Math.max(0, d - 1);
    }
    return d;
  }

  // The indent that the line following `before` should start with
  function indentAfter(before) {
    const cur = before.split('\n').pop();
    const clean = stripLiterals(before).split('\n').pop();
    const indent = (cur.match(/^[ \t]*/) || [''])[0].replace(/\t/g, INDENT);

    if (/:[ \t]*$/.test(clean)) return indent + INDENT;     // opens a suite

    // Inside brackets, indent one level past the line that OPENED them, not past
    // the current line -- otherwise every continuation line drifts one deeper.
    const depth = bracketDepth(before);
    if (depth > 0) {
      const lines = before.split('\n');
      let opener = lines.length - 1;
      while (opener > 0 && bracketDepth(lines.slice(0, opener).join('\n')) > 0) opener--;
      const base = (lines[opener].match(/^[ \t]*/) || [''])[0].replace(/\t/g, INDENT);
      return base + INDENT.repeat(depth);
    }

    if (DEDENT_RE.test(cur)) {                              // leaves the suite
      return indent.slice(0, Math.max(0, indent.length - INDENT_N));
    }
    // A line that only closes a bracket group returns to the opener's level
    if (/^[ \t]*[)\]}][ \t,]*$/.test(cur)) {
      return indent.slice(0, Math.max(0, indent.length - INDENT_N));
    }
    return indent;
  }

  // Insert a newline with smart indentation into a textarea
  function smartNewline(el, after) {
    const v = el.value;
    const at = el.selectionStart;
    const ins = '\n' + indentAfter(v.slice(0, at));
    el.value = v.slice(0, at) + ins + v.slice(el.selectionEnd);
    el.selectionStart = el.selectionEnd = at + ins.length;
    if (after) after();
  }

  // Backspace at the head of an indent removes a whole level
  function smartBackspace(el, ev, after) {
    const at = el.selectionStart;
    if (at !== el.selectionEnd || at === 0) return false;
    const lineStart = el.value.lastIndexOf('\n', at - 1) + 1;
    const before = el.value.slice(lineStart, at);
    if (before.length === 0 || /[^ ]/.test(before)) return false;
    const remove = before.length % INDENT_N || INDENT_N;
    ev.preventDefault();
    el.value = el.value.slice(0, at - remove) + el.value.slice(at);
    el.selectionStart = el.selectionEnd = at - remove;
    if (after) after();
    return true;
  }


  global.PyUtil = {
    esc, highlightPy, renderPyLine, renderOutput, simplifyTracebacks,
    INDENT, INDENT_N, stripLiterals, bracketDepth, indentAfter,
    smartNewline, smartBackspace
  };
})(typeof window !== 'undefined' ? window : self);
