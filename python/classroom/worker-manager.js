/* worker-manager.js
 * Spawns pyodide-worker.js as a real module Worker file (not a Blob) so that
 * the dynamic import() inside the worker resolves against the page origin.
 */

class PyodideWorkerManager {
  constructor(pyodideUrl, workerUrl) {
    this.pyodideUrl = pyodideUrl;
    this.workerUrl  = workerUrl;
    this.worker     = null;
    this.ready      = false;
    this._pending   = null;
    this._readyResolve = null;
    this.readyPromise  = new Promise(r => { this._readyResolve = r; });
  }

  init() {
    // Module worker: Pyodide 3.14 builds are ESM-only (no classic workers)
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = e => this._onMessage(e.data);
    this.worker.onerror   = err => {
      console.error('[Worker error]', err);
      if (this._pending) {
        this._pending.reject(new Error('Worker error: ' + (err.message || err)));
        this._pending = null;
      }
    };
    // Send the absolute URL of pyodide.mjs so the dynamic import succeeds
    this.worker.postMessage({ type: 'init', pyodideUrl: this.pyodideUrl });
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this.ready = true;
      this._readyResolve();
    } else if (msg.type === 'error') {
      console.error('[Worker init error]', msg.error);
    } else if (msg.type === 'result' || msg.type === 'console-result') {
      if (this._pending) {
        this._pending.resolve({
          stdout: msg.stdout,
          stderr: msg.stderr,
          result: msg.result,
          error:  msg.error
        });
        this._pending = null;
      }
    }
  }

  _enqueue(msgType, extra) {
    if (this._pending) {
      // Busy: reject immediately so the caller knows
      return Promise.reject(new Error('Python runtime busy — please wait'));
    }
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage({ type: msgType, ...extra });
    });
  }

  async run(code) {
    await this.readyPromise;
    return this._enqueue('run', { code });
  }

  async runConsole(code) {
    await this.readyPromise;
    return this._enqueue('console', { code });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready  = false;
      this.readyPromise = new Promise(r => { this._readyResolve = r; });
    }
  }

  restart() {
    this.terminate();
    this.init();
  }
}
