"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};
var ExportDelay_exports = {};
__export(ExportDelay_exports, {
  ExportDelay: () => ExportDelay
});
module.exports = __toCommonJS(ExportDelay_exports);
var import_utils = require("@tldraw/utils");
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
  failure = (0, import_utils.promiseWithResolve)();
  controller = new AbortController();
  timers = new import_utils.Timers().forContext("export");
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
      await (0, import_utils.sleep)(0);
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
  import_utils.bind
], ExportDelay.prototype, "abort", 1);
__decorateClass([
  import_utils.bind
], ExportDelay.prototype, "waitUntil", 1);
//# sourceMappingURL=ExportDelay.js.map
