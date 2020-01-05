Brython implements Python version 3, based on the
[Python Language Reference](https://docs.python.org/3/reference/index.html)


The implementation takes into account the browsers limitations, in particular
those related to the file system. Writing is impossible, and reading is
limited to the folders accessible with an Ajax request.

Keywords and built-in functions
-------------------------------

Brython supports all the keywords and functions of Python 3 :

- keywords : `and, as, assert, async, await, break, class, continue, def, del, `
  `elif, else, except, False, finally, for, from, global, if, import, in, is, `
  `lambda, None, nonlocal, not, or, pass, raise, return, True, try, while, with, yield`
- built-in functions and classes : `abs, all, any, ascii, bin, bool, bytes,`
  `callable, chr, classmethod, delattr, dict, dir, divmod, `
  `enumerate, eval, exec, filter, float, frozenset, getattr, `
  `globals, hasattr, hash, hex, id, input, int, isinstance, `
  `iter, len, list, locals, map, max, memoryview, min, `
  `next, object, open, ord, pow, print, property, range, `
  `repr, reversed, round, set, setattr, slice, sorted, str, `
  `sum, super, tuple, type, vars, zip, __import__`

Here are a few features and limitations imposed by the browser and Javascript :

- Javascript functions can't block execution for a given time, or waiting for
  an event to happen, before going to the next instruction. For this reason:

 - `time.sleep()` can't be used : functions in module **browser.timer** such
   as `set_timeout()` or `set_interval()` must be used instead

 - the built-in function `input()` is simulated by the Javascript function
 `prompt()`. An example in the gallery shows how to simulate
  an input function in a custom dialog box.

- for the same reason, and also because the browser has its own implicit
  event loop, the CPython `asyncio` module is not usable. A Brython-specific
  module, [**`browser.aio`**](aio.html), is provided for asynchronous
  programming.

- the built-in function `open()` takes as argument the url of the file to
  open. Since it is read with an Ajax call, it must be in the same domain as
  the script. The object returned by `open()` has the usual reading and access
  methods : `read, readlines, seek, tell, close`. Only text mode is supported:
  the Ajax call is blocking and in this mode the `responseType` attribute
  can't be set

- by default, `print()` will output to the web browser console and so are the
  error messages. `sys.stderr` and `sys.stdout` can be assigned to an object
  with a `write()` method, and this allows for the redirection of output to go
  to a window or text area, for example.

- to open a print dialog (to a printer), call `window.print` (`window` is
  defined in module **browser**).

- the objects lifecycle is managed by the Javascript garbage collector,
  Brython doesn't manage reference counting like CPython. Therefore, method
  `__del__()` is not called when a class instance is no more referenced.

Standard library
----------------
Brython is shipped with a part of the CPython standard library.

Some of the modules that are written in C in CPython standard library have
been written in Javascript in Brython distribution (`math`, `unicodedata`...).
For others (module `re` or package `json` for instance), a pure-Python version
is provided (it is not as fast !).

The `xml` package is not provided because that of the CPython distribution
uses a C module (`pyexpat`) which is available neither in Javascript nor in
pure Python.

Built-in value `__name__`
-------------------------

The built-in variable `__name__` is set to the value of the attribute `id`
of the script. For instance:

```xml
<script type="text/python" id="myscript">
assert __name__ == 'myscript'
</script>
```

If 2 scripts have the same `id`, an exception is raised.

For scripts that don't have an explicit `id` set :

- if no script has its `id` set to `__main__`, the first "unnamed" script has
  its `__name__` set to `"__main__"`. So, if there only one script in the page,
  it will be able to run the usual test :

<blockquote>
```xml
<script type="text/python">
if __name__=='__main__':
    print('hello !')
</script>
```
</blockquote>

- for the other unnamed scripts, `__name__` is set to a random string starting
  with `__main__`
