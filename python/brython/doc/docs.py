from browser import document as doc
from browser import window, html, markdown

import highlight

import header
header.show('../../')

import time

def run(ev):
    # run the code in the elt after the button
    ix = ev.target.parent.children.index(ev.target)
    elt = ev.target.parent.children[ix+1]
    exec(elt.text)
    elt.focus()

def load(url,target):
    # fake query string to bypass browser cache
    qs = '?foo=%s' %time.time()
    try:
        mk,scripts = markdown.mark(open(url+qs).read())
    except IOError:
        doc[target].html = "Page %s not found" %url
        return False
    doc[target].html = mk
    for script in scripts:
        exec(script)
    for elt in doc[target].get(selector='.exec'):
        # Python code executed when user clicks on a button
        elt.contentEditable = True
        src = elt.text.strip()
        h = highlight.highlight(src)
        h.className = "pycode"
        elt.clear()
        elt <= h
        elt.focus()
        btn = html.BUTTON('▶')
        btn.bind('click', run)
        elt.parent.insertBefore(btn, elt)
    for elt in doc[target].get(selector='.exec_on_load'):
        # Python code executed on page load
        src = elt.text.strip()
        h = highlight.highlight(src)
        h.className = "pycode"
        elt.clear()
        elt <= h
        exec(src)
    for elt in doc[target].get(selector='.python'):
        src = elt.text.strip()
        h = highlight.highlight(src)
        h.className = "pycode"
        elt.clear()
        elt <= h
    return False
