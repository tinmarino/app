/* markdown.js — a small Markdown renderer for exercise descriptions.
 *
 * Deliberately not a dependency: the classroom is served same-origin and
 * offline-capable, and pulling marked/showdown from a CDN for a few headings
 * and tables is not worth the network and CSP surface. This covers exactly the
 * subset the exercise files use:
 *
 *   headings, paragraphs, fenced code (Prism-highlighted), inline code,
 *   bold, italic, strikethrough, links, blockquotes, lists, pipe tables,
 *   horizontal rules
 *
 * Everything is escaped before any markup is emitted, so exercise content
 * cannot inject HTML.
 *
 * renderMarkdown(src, {headingShift}) -> HTML string
 *   headingShift is subtracted from each heading level, so `### x` with
 *   headingShift 2 becomes <h1>. Levels clamp to 1..6.
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(code, lang) {
    if (global.Prism && lang && global.Prism.languages[lang]) {
      return global.Prism.highlight(code, global.Prism.languages[lang], lang);
    }
    return escapeHtml(code);
  }

  // Inline spans. Code spans are pulled out first so their contents are never
  // reinterpreted as emphasis or links, then put back at the end.
  function inline(text) {
    const codes = [];
    // The placeholder must survive escapeHtml() and never collide with prose.
    let out = text.replace(/`([^`]+)`/g, function (_, c) {
      codes.push('<code>' + escapeHtml(c) + '</code>');
      return '@@MDCODE' + (codes.length - 1) + 'ENDMD@@';
    });

    out = escapeHtml(out);

    // [label](href) — only http(s), mailto and relative targets
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
      if (/^(https?:|mailto:|[./#])/.test(href)) {
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      }
      return m;
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return out.replace(/@@MDCODE(\d+)ENDMD@@/g, function (_, i) { return codes[+i]; });
  }

  function renderTable(rows) {
    const cells = function (line) {
      return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    };
    const head = cells(rows[0]);
    const aligns = cells(rows[1]).map(function (spec) {
      const l = spec.startsWith(':'), r = spec.endsWith(':');
      return (r && l) ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    const attr = function (i) { return aligns[i] ? ' style="text-align:' + aligns[i] + '"' : ''; };
    const th = head.map(function (c, i) { return '<th' + attr(i) + '>' + inline(c) + '</th>'; });
    const body = rows.slice(2).map(function (line) {
      return '<tr>' + cells(line).map(function (c, i) {
        return '<td' + attr(i) + '>' + inline(c) + '</td>';
      }).join('') + '</tr>';
    });
    return '<div class="md-table-wrap"><table><thead><tr>' + th.join('') +
           '</tr></thead><tbody>' + body.join('') + '</tbody></table></div>';
  }

  function renderMarkdown(src, opts) {
    const shift = (opts && opts.headingShift) || 0;
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const isTableSep = function (l) {
      return l != null && /^\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf('-') !== -1;
    };
    const isListItem = function (l) { return /^\s*([-*+]|\d+[.)])\s+/.test(l); };

    while (i < lines.length) {
      const line = lines[i];
      let m;

      // Fenced code
      if ((m = line.match(/^\s*```+\s*(\S*)/))) {
        const lang = (m[1] || '').replace(/^#\s*/, '').trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;  // closing fence
        out.push('<pre class="md-code"><code>' +
                 highlight(buf.join('\n'), lang || 'python') + '</code></pre>');
        continue;
      }

      // Heading
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        const level = Math.min(6, Math.max(1, m[1].length - shift));
        out.push('<h' + level + '>' + inline(m[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Table: a header row followed by a separator row
      if (line.indexOf('|') !== -1 && isTableSep(lines[i + 1])) {
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) rows.push(lines[i++]);
        out.push(renderTable(rows));
        continue;
      }

      // Blockquote
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + renderMarkdown(buf.join('\n'), opts) + '</blockquote>');
        continue;
      }

      // Lists (single level; continuation lines fold into their item)
      if (isListItem(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && isListItem(lines[i])) {
          let text = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          while (i < lines.length && lines[i].trim() && !isListItem(lines[i]) &&
                 !/^(#{1,6})\s/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
            text += ' ' + lines[i++].trim();
          }
          items.push('<li>' + inline(text) + '</li>');
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      // Blank line
      if (!line.trim()) { i++; continue; }

      // Paragraph
      const para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*```/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) &&
             !isListItem(lines[i]) &&
             !(lines[i].indexOf('|') !== -1 && isTableSep(lines[i + 1]))) {
        para.push(lines[i++]);
      }
      out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }

    return out.join('\n');
  }

  global.renderMarkdown = renderMarkdown;
})(typeof window !== 'undefined' ? window : self);
