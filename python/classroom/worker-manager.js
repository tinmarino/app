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
    this.failed     = null;   // Error, once the runtime is unusable
    this._pending   = null;
    this._newReadyPromise();
  }

  _newReadyPromise() {
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject  = reject;
    });
    // Nothing may reject an unobserved promise; callers await it explicitly.
    this.readyPromise.catch(() => {});
  }

  // Fail whatever is in flight. Without this a single error leaves _pending set
  // and every later request is rejected as "busy" for the rest of the session.
  _failPending(err) {
    if (this._pending) {
      const pending = this._pending;
      this._pending = null;
      pending.reject(err);
    }
  }

  init() {
    // Module worker: Pyodide 3.14 builds are ESM-only (no classic workers)
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = e => this._onMessage(e.data);
    this.worker.onerror   = err => {
      const error = new Error('Worker error: ' + (err.message || err));
      console.error('[Worker error]', err);
      this.failed = error;
      this._failPending(error);
      if (!this.ready) this._readyReject(error);
    };
    // Send the absolute URL of pyodide.mjs so the dynamic import succeeds
    this.worker.postMessage({ type: 'init', pyodideUrl: this.pyodideUrl });
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this.ready = true;
      this.failed = null;
      this.banner = msg.banner || '';
      this._readyResolve();
      return;
    }
    if (msg.type === 'error') {
      // Init failure, or a request the worker refused. Either way something is
      // waiting on it, so surface it rather than logging into the void.
      const error = new Error(msg.error || 'Python runtime error');
      console.error('[Worker error]', msg.error);
      if (!this.ready) {
        this.failed = error;
        this._readyReject(error);
      }
      this._failPending(error);
      return;
    }
    if (!this._pending) return;
    // Only the response to the request actually in flight may resolve it,
    // otherwise a late message could hand one request's data to the next.
    if (msg.type !== this._pending.expect) {
      console.warn('[Worker] ignoring', msg.type, 'while expecting', this._pending.expect);
      return;
    }
    const pending = this._pending;
    this._pending = null;
    const { type, ...data } = msg;
    pending.resolve(data);
  }

  // Response type expected for each request type
  static RESPONSE = {
    'run': 'result',
    'console': 'console-result',
    'complete': 'complete-result',
    'reset-namespace': 'console-result'
  };

  _enqueue(msgType, extra) {
    if (this.failed) return Promise.reject(this.failed);
    if (this._pending) {
      const err = new Error('Python is still busy running your last command.');
      err.busy = true;
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this._pending = {
        resolve, reject,
        expect: PyodideWorkerManager.RESPONSE[msgType] || 'result'
      };
      this.worker.postMessage({ type: msgType, ...extra });
    });
  }

  async run(code) {
    await this.readyPromise;
    return this._enqueue('run', { code });
  }

  // Push a block into pyodide.console.Console.
  // Resolves { status: 'ok'|'incomplete'|'error', stdout, stderr, repr, error }
  async runConsole(code) {
    await this.readyPromise;
    return this._enqueue('console', { code });
  }

  // rlcompleter-backed tab completion -> { matches, start }
  async complete(code) {
    await this.readyPromise;
    return this._enqueue('complete', { code });
  }

  // Wipe the shared namespace and rebuild the console
  async resetNamespace() {
    await this.readyPromise;
    return this._enqueue('reset-namespace', {});
  }

  // Hard-kill the worker. This is the only escape from an infinite loop in
  // student code: a blocked Worker thread cannot be interrupted otherwise.
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.failed = null;
    this._failPending(new Error('Python runtime was stopped.'));
    this._newReadyPromise();
  }

  restart() {
    this.terminate();
    this.init();
  }
}
