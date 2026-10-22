var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};
import { bind, promiseWithResolve, sleep, Timers } from "@tldraw/utils";
class ExportDelay {
  constructor(maxDelayTimeMs, options = {}) {
    this.maxDelayTimeMs = maxDelayTimeMs;
    this.options = options;
    if (options.strict) {
      this.timers.setTimeout(
        () => this.fail(new Error(`SVG export preparation timed out after ${maxDelayTimeMs}ms`)),
        maxDelayTimeMs
      );
    }
    if (options.strict && options.signal) {
      if (options.signal.aborted) this.abort();
      else options.signal.addEventListener("abort", this.abort, { once: true });
    }
  }
  maxDelayTimeMs;
  options;
  isResolved = false;
  promisesToWaitFor = [];
  failure = promiseWithResolve();
  controller = new AbortController();
  timers = new Timers().forContext("export");
  error;
  signal = this.controller.signal;
  abort() {
    this.fail(new Error("SVG export preparation was cancelled"));
  }
  fail(error) {
    this.error ??= error;
    this.failure.resolve(this.error);
    this.controller.abort();
  }
  /** Keep the same strict deadline and cancellation through all export phases. */
  async waitFor(promise) {
    if (!this.options.strict) return promise;
    try {
      if (this.signal.aborted) {
        void promise.catch(() => {
        });
        throw this.error ?? new Error("SVG export preparation is disposed");
      }
      const result = await Promise.race([
        promise,
        this.failure.then((error) => {
          throw error;
        })
      ]);
      if (this.signal.aborted) throw this.error ?? new Error("SVG export preparation is disposed");
      return result;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw this.error;
    }
  }
  waitUntil(promise) {
    if (this.isResolved) {
      throw new Error(
        "Cannot `waitUntil` - the export has already been resolved. Make sure to call `waitUntil` as soon as possible during an export - ie within the first react effect after rendering."
      );
    }
    this.promisesToWaitFor.push(
      promise.catch((err) => {
        if (this.options.strict) this.fail(err instanceof Error ? err : new Error(String(err)));
        else console.error("Error while waiting for export:", err);
      })
    );
  }
  async resolvePromises() {
    let lastLength = null;
    while (this.promisesToWaitFor.length !== lastLength) {
      if (this.options.strict && this.signal.aborted) return;
      lastLength = this.promisesToWaitFor.length;
      await Promise.allSettled(this.promisesToWaitFor);
      await sleep(0);
    }
  }
  async resolve() {
    if (this.options.strict) {
      try {
        await this.waitFor(this.resolvePromises());
      } finally {
        this.isResolved = true;
      }
      return;
    }
    const timeoutPromise = new Promise((resolve) => {
      this.timers.setTimeout(() => resolve("timeout"), this.maxDelayTimeMs);
    });
    const resolvePromise = this.resolvePromises().then(() => "resolved");
    try {
      const result = await Promise.race([timeoutPromise, resolvePromise]);
      if (result === "timeout") {
        console.warn("[tldraw] Export delay timed out after ${this.maxDelayTimeMs}ms");
      }
    } finally {
      this.dispose();
    }
  }
  dispose() {
    this.timers.dispose();
    this.isResolved = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    if (this.options.strict)
      this.fail(this.error ?? new Error("SVG export preparation is disposed"));
  }
}
__decorateClass([
  bind
], ExportDelay.prototype, "abort", 1);
__decorateClass([
  bind
], ExportDelay.prototype, "waitUntil", 1);
export {
  ExportDelay
};
//# sourceMappingURL=ExportDelay.mjs.map
