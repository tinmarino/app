/* worker-manager.js
 * Manages a Pyodide Web Worker for running student code without blocking the UI.
 * Communicates via postMessage.
 */

class PyodideWorkerManager {
  constructor(pyodideUrl) {
    this.pyodideUrl = pyodideUrl;
    this.worker = null;
    this.ready = false;
    this._pending = null;
    this._readyResolve = null;
    this.readyPromise = new Promise(resolve => { this._readyResolve = resolve; });
  }

  init() {
    const blob = new Blob([this._workerCode()], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (err) => {
      console.error('[Worker error]', err);
      if (this._pending) {
        this._pending.reject(new Error('Worker error: ' + err.message));
        this._pending = null;
      }
    };
    this.worker.postMessage({ type: 'init', pyodideUrl: this.pyodideUrl });
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this.ready = true;
      if (this._readyResolve) this._readyResolve();
    } else if (msg.type === 'result') {
      if (this._pending) {
        this._pending.resolve({ stdout: msg.stdout, stderr: msg.stderr, result: msg.result, error: msg.error });
        this._pending = null;
      }
    } else if (msg.type === 'console-result') {
      if (this._pending) {
        this._pending.resolve({ stdout: msg.stdout, stderr: msg.stderr, result: msg.result, error: msg.error });
        this._pending = null;
      }
    }
  }

  async run(code, mode = 'exec') {
    await this.readyPromise;
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage({ type: 'run', code, mode });
    });
  }

  async runConsole(line) {
    await this.readyPromise;
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage({ type: 'console', code: line });
    });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.readyPromise = new Promise(resolve => { this._readyResolve = resolve; });
    }
  }

  restart() {
    this.terminate();
    this.init();
  }

  _workerCode() {
    return `
      let pyodide = null;

      async function initPyodide(url) {
        importScripts(url);
        pyodide = await loadPyodide();
        postMessage({ type: 'ready' });
      }

      function captureRun(code, mode) {
        let stdout = '';
        let stderr = '';
        pyodide.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
        pyodide.setStderr({ batched: (s) => { stderr += s + '\\n'; } });

        let result = null;
        let error = null;
        try {
          if (mode === 'eval') {
            result = String(pyodide.runPython(code));
          } else {
            pyodide.runPython(code);
          }
        } catch (e) {
          error = e.message || String(e);
        }
        return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), result, error };
      }

      self.onmessage = async function(e) {
        const msg = e.data;
        if (msg.type === 'init') {
          await initPyodide(msg.pyodideUrl);
        } else if (msg.type === 'run') {
          const res = captureRun(msg.code, msg.mode);
          postMessage({ type: 'result', ...res });
        } else if (msg.type === 'console') {
          // H4 fix: proper REPL eval-then-exec with correct repr
          let stdout = '';
          let stderr = '';
          let result = null;
          let error = null;
          pyodide.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
          pyodide.setStderr({ batched: (s) => { stderr += s + '\\n'; } });
          try {
            // Try as expression first (like Python REPL)
            const val = pyodide.runPython('__builtins__.__import__("builtins").eval(' + JSON.stringify(msg.code) + ')');
            if (val !== undefined && val !== null) {
              pyodide.globals.set('_', val);
              const noneType = pyodide.globals.get('None');
              if (val !== noneType) {
                result = String(pyodide.runPython('repr(_)'));
              }
            }
          } catch(evalErr) {
            // Not an expression, try exec
            stdout = '';
            stderr = '';
            pyodide.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
            pyodide.setStderr({ batched: (s) => { stderr += s + '\\n'; } });
            try {
              pyodide.runPython(msg.code);
            } catch(execErr) {
              error = execErr.message || String(execErr);
            }
          }
          postMessage({ type: 'console-result', stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), result, error });
        }
      };
    `;
  }
}
