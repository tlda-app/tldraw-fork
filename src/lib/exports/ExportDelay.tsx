import { bind, promiseWithResolve, sleep, Timers } from '@tldraw/utils'

/**
 * Export delay is a helper class that allows you to wait for a set of promises to resolve before
 * proceeding with an export. Over time, promises can be added by calling `waitUntil`.
 *
 * When `resolve` is called, we'll wait for all the promises already added (and any new ones added
 * in the mean time) to resolve before proceeding. The class is designed to be used once: after
 * `resolve` has been called and finished, new promises cannot be added.
 */
export class ExportDelay {
	private isResolved = false
	private readonly promisesToWaitFor: Promise<void>[] = []
	private readonly failure = promiseWithResolve<Error>()
	private readonly controller = new AbortController()
	private readonly timers = new Timers().forContext('export')
	private error: Error | undefined
	readonly signal = this.controller.signal
	@bind private abort() {
		this.fail(new Error('SVG export preparation was cancelled'))
	}

	constructor(
		private readonly maxDelayTimeMs: number,
		private readonly options: { strict?: boolean; signal?: AbortSignal } = {}
	) {
		if (options.strict) {
			this.timers.setTimeout(
				() => this.fail(new Error(`SVG export preparation timed out after ${maxDelayTimeMs}ms`)),
				maxDelayTimeMs
			)
		}
		if (options.strict && options.signal) {
			if (options.signal.aborted) this.abort()
			else options.signal.addEventListener('abort', this.abort, { once: true })
		}
	}

	private fail(error: Error) {
		this.error ??= error
		this.failure.resolve(this.error)
		this.controller.abort()
	}

	/** Keep the same strict deadline and cancellation through all export phases. */
	async waitFor<T>(promise: Promise<T>): Promise<T> {
		if (!this.options.strict) return promise
		try {
			if (this.signal.aborted) {
				void promise.catch(() => {})
				throw this.error ?? new Error('SVG export preparation is disposed')
			}
			const result = await Promise.race([
				promise,
				this.failure.then((error) => {
					throw error
				}),
			])
			if (this.signal.aborted) throw this.error ?? new Error('SVG export preparation is disposed')
			return result
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)))
			throw this.error
		}
	}

	@bind waitUntil(promise: Promise<void>): void {
		if (this.isResolved) {
			throw new Error(
				'Cannot `waitUntil` - the export has already been resolved. Make sure to call `waitUntil` as soon as possible during an export - ie within the first react effect after rendering.'
			)
		}
		this.promisesToWaitFor.push(
			promise.catch((err) => {
				if (this.options.strict) this.fail(err instanceof Error ? err : new Error(String(err)))
				else console.error('Error while waiting for export:', err)
			})
		)
	}

	private async resolvePromises() {
		let lastLength = null
		while (this.promisesToWaitFor.length !== lastLength) {
			if (this.options.strict && this.signal.aborted) return
			lastLength = this.promisesToWaitFor.length
			await Promise.allSettled(this.promisesToWaitFor)

			// wait for a cycle of the event loop to allow any of those promises to add more if needed.
			await sleep(0)
		}
	}

	async resolve() {
		if (this.options.strict) {
			try {
				await this.waitFor(this.resolvePromises())
			} finally {
				this.isResolved = true
			}
			// The owner disposes after embedding, not after just the React work.
			return
		}
		const timeoutPromise = new Promise<'timeout'>((resolve) => {
			this.timers.setTimeout(() => resolve('timeout'), this.maxDelayTimeMs)
		})
		const resolvePromise = this.resolvePromises().then(() => 'resolved' as const)

		try {
			const result = await Promise.race([timeoutPromise, resolvePromise])
			if (result === 'timeout') {
				console.warn('[tldraw] Export delay timed out after ${this.maxDelayTimeMs}ms')
			}
		} finally {
			this.dispose()
		}
	}

	dispose() {
		this.timers.dispose()
		this.isResolved = true
		this.options.signal?.removeEventListener('abort', this.abort)
		if (this.options.strict)
			this.fail(this.error ?? new Error('SVG export preparation is disposed'))
	}
}
