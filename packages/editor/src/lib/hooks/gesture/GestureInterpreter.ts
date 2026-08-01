/*

# Interpreting a touch gesture that is still happening

The classifier this replaces asked "what is this gesture?" once, kept the answer,
and had no way back: `pinchState` reached `'zooming'` and `updatePinchState`
returned early from then on. A finger still settling could widen the span far
enough to answer "zoom", and the rest of the drag zoomed however the fingers
moved afterwards. Raising the threshold made zooming sluggish and lowering it
made the latch fire more often, because neither adds a way back.

So the interpretation here is revisable, and revising it is ordinary rather than
exceptional. Two questions are asked separately, because they have different
answers:

  1. What is this gesture, now? Re-answered every frame from RECENT motion —
     accumulators that decay, so a burst while the fingers settle stops counting
     once the fingers stop doing it. Hysteresis keeps it from fluttering.

  2. Does the gesture we just left keep what it did? Asked only when (1)
     changes, and answered by MAGNITUDE, not by the new answer to (1). Panning
     and then pinching means two deliberate gestures, and the pan is kept.
     Three pixels of pinch and then panning means a finger settled, and those
     three pixels are given back.

## Continuity is structural, not smoothed

Every value here is a per-frame delta, and on any frame where the interpretation
changes the deltas are zero. Whoever owns the gesture next therefore starts from
wherever the fingers are now, and its first frame moves nothing. Handing over
cannot jump, because there is no absolute the new owner could jump to.

That matters most when the finger COUNT changes, which is where the centroid
really does leap — the midpoint of two fingers and the centroid of three are far
apart. Dropping that one frame is invisible; not dropping it is the snap.

Fingers leaving are the same transition running backwards, so touches are keyed
by identifier rather than by position in `event.touches`. Indexing by position
silently re-pairs the remaining fingers when the first one lifts, which reads as
a jump that no amount of smoothing removes.

## Panning is never withheld

While the interpretation is still `undecided` the pan is applied and only the
scale is held back. A pinch begins slowly — a second finger is arriving — so
waiting a few frames to be sure about scale is not perceptible. A pan is
supposed to move the instant you move, and any wait there reads as broken.

This is also why there is no settling window for the finger count. A three
finger gesture necessarily passes through two fingers, but during those few tens
of milliseconds it is already panning, and it goes on panning when the third
finger lands. There is nothing for a window to buy.

*/

/** How the fingers are being read right now. Only `zooming` applies scale. */
export type TLGestureKind = 'undecided' | 'panning' | 'zooming'

/** One live touch, keyed by the identifier the platform assigns it. */
export interface TLGesturePoint {
	id: number
	x: number
	y: number
}

/** What the owner should apply this frame. Deltas, never absolutes. */
export interface TLGestureFrame {
	kind: TLGestureKind
	/** How many fingers are down. Revised as they arrive and leave. */
	count: number
	/** The interpretation changed this frame, so the deltas below are inert. */
	transitioned: boolean
	/** Centroid movement since the previous frame. */
	pan: { x: number; y: number }
	/** Multiplicative scale change since the previous frame, deflation included. */
	scale: number
	/** Current centroid, in the same client coordinates as the points. */
	origin: { x: number; y: number }
}

export interface TLGestureTuning {
	/**
	 * Per-frame decay of the motion accumulators — how fast the classifier
	 * forgets. Borrowed from the axis lock in tlda's own pan handler, which uses
	 * this same decay to keep an axis tracking recent travel.
	 */
	decay: number
	/** Below this much recent motion there is nothing to read, so hold. */
	minMotion: number
	/** How decisively spread must beat travel to first claim the gesture. */
	decideRatio: number
	/**
	 * How decisively it must beat travel to TAKE the gesture from the other
	 * reading. Higher than `decideRatio` for the reason tldraw's own numbers are
	 * ordered that way: it asks 24px to start zooming but 64px to convert a pan.
	 */
	stealRatio: number
	/**
	 * A zoom episode that stayed inside this ratio of where it started is read as
	 * a finger settling, and is given back. Outside it, it was meant, and stays.
	 */
	deflateWithin: number
	/** How long a given-back zoom takes to return. Slow enough to read as a correction. */
	deflateMs: number
}

/**
 * Feel numbers. The ratios are ours; the ordering of `decideRatio` below
 * `stealRatio` is tldraw's, and `decay` is tlda's. `deflateWithin` and
 * `deflateMs` are picked by feel, which the spec for this work explicitly
 * permits: the error is bounded by the quantity that triggers the decision, so
 * being wrong about a small zoom costs a small zoom.
 */
export const DEFAULT_GESTURE_TUNING: TLGestureTuning = {
	decay: 0.8,
	minMotion: 2,
	decideRatio: 1.2,
	stealRatio: 2,
	deflateWithin: 1.08,
	deflateMs: 260,
}

/** Centroid of the live points. */
function centroidOf(points: readonly TLGesturePoint[]) {
	let x = 0
	let y = 0
	for (const p of points) {
		x += p.x
		y += p.y
	}
	return { x: x / points.length, y: y / points.length }
}

/**
 * How far apart the fingers are, defined for any number of them: twice the mean
 * distance from the centroid. For two fingers that is exactly the distance
 * between them, so tldraw's thresholds keep the meaning they were tuned with.
 */
function spreadOf(points: readonly TLGesturePoint[], centroid: { x: number; y: number }) {
	if (points.length < 2) return 0
	let total = 0
	for (const p of points) {
		total += Math.hypot(p.x - centroid.x, p.y - centroid.y)
	}
	return (2 * total) / points.length
}

function keyOf(points: readonly TLGesturePoint[]) {
	// Sorted, so the same fingers in a different event order are the same set.
	return points
		.map((p) => p.id)
		.sort((a, b) => a - b)
		.join(',')
}

export class GestureInterpreter {
	private tuning: TLGestureTuning

	private kind: TLGestureKind = 'undecided'
	private pointKey = ''
	private count = 0
	private centroid = { x: 0, y: 0 }
	private spread = 0

	/** Decayed recent motion. These, not totals since the start, decide the kind. */
	private recentTravel = 0
	private recentSpread = 0

	/** Scale applied since the current zoom episode began. Reset on entering `zooming`. */
	private episodeScale = 1

	/** Scale still owed back from a zoom that turned out to be a finger settling. */
	private owedScale = 1
	private owedUntil = 0
	private lastTime = 0

	constructor(tuning: Partial<TLGestureTuning> = {}) {
		this.tuning = { ...DEFAULT_GESTURE_TUNING, ...tuning }
	}

	getKind() {
		return this.kind
	}

	getCount() {
		return this.count
	}

	/** True while a zoom is being handed back. */
	isDeflating() {
		return this.owedScale !== 1
	}

	/**
	 * Read the current touches and say what to apply. Call this for every
	 * touchstart, touchmove and touchend while any finger is down — arrivals and
	 * departures are gesture changes, not gesture boundaries.
	 */
	update(points: readonly TLGesturePoint[], time: number): TLGestureFrame {
		const count = points.length
		const centroid = count > 0 ? centroidOf(points) : this.centroid
		const spread = spreadOf(points, centroid)
		const key = keyOf(points)

		// A different set of fingers moves the centroid and the spread for reasons
		// that have nothing to do with the hand moving, so this frame reports no
		// motion and everything re-baselines to where the fingers now are.
		const pointsChanged = key !== this.pointKey

		const dx = pointsChanged ? 0 : centroid.x - this.centroid.x
		const dy = pointsChanged ? 0 : centroid.y - this.centroid.y
		const dSpread = pointsChanged ? 0 : spread - this.spread
		const frameScale = pointsChanged || this.spread <= 0 ? 1 : spread / this.spread

		const decay = this.tuning.decay
		this.recentTravel = this.recentTravel * decay + Math.hypot(dx, dy)
		this.recentSpread = this.recentSpread * decay + Math.abs(dSpread)

		const previousKind = this.kind
		this.kind = this.nextKind(count)

		const kindChanged = this.kind !== previousKind
		const transitioned = kindChanged || pointsChanged

		if (kindChanged) {
			this.onLeavingKind(previousKind, time)
			if (this.kind === 'zooming') this.episodeScale = 1
		}

		this.pointKey = key
		this.count = count
		this.centroid = centroid
		this.spread = spread
		this.lastTime = time

		// Panning is applied as soon as there is anything to apply, including while
		// undecided. Scale waits until the gesture has said it is a zoom.
		const pan = transitioned ? { x: 0, y: 0 } : { x: dx, y: dy }
		let scale = transitioned || this.kind !== 'zooming' ? 1 : frameScale
		if (this.kind === 'zooming') this.episodeScale *= scale

		scale *= this.deflationStep(time)

		return { kind: this.kind, count, transitioned, pan, scale, origin: centroid }
	}

	/**
	 * The gesture ended. Any zoom still owed back is returned as a single factor
	 * for the owner to animate over `deflateMs`, since there are no more frames to
	 * spread it across.
	 */
	end(): { scale: number; ms: number } | null {
		this.onLeavingKind(this.kind, this.lastTime)
		const owed = this.owedScale
		this.reset()
		if (owed === 1) return null
		return { scale: owed, ms: this.tuning.deflateMs }
	}

	private reset() {
		this.kind = 'undecided'
		this.pointKey = ''
		this.count = 0
		this.spread = 0
		this.recentTravel = 0
		this.recentSpread = 0
		this.episodeScale = 1
		this.owedScale = 1
		this.owedUntil = 0
	}

	/**
	 * Question one, re-answered every frame. Symmetric: a zoom can be taken back
	 * by a pan on exactly the terms a pan can be taken by a zoom.
	 */
	private nextKind(count: number): TLGestureKind {
		if (count < 2) return 'undecided'

		const { minMotion, decideRatio, stealRatio } = this.tuning
		if (this.recentTravel + this.recentSpread < minMotion) return this.kind

		const ratio = this.kind === 'undecided' ? decideRatio : stealRatio
		if (this.recentSpread > this.recentTravel * ratio) return 'zooming'
		if (this.recentTravel > this.recentSpread * ratio) return 'panning'
		return this.kind
	}

	/**
	 * Question two, asked only on a change and answered only by magnitude. A zoom
	 * small enough to have been a finger settling is given back; one large enough
	 * to have been meant is kept, whatever the gesture turned into afterwards.
	 */
	private onLeavingKind(kind: TLGestureKind, time: number) {
		if (kind !== 'zooming') return
		const episode = this.episodeScale
		this.episodeScale = 1
		if (episode === 1) return

		const within = this.tuning.deflateWithin
		if (episode > within || episode < 1 / within) return // meant, so kept

		this.owedScale = 1 / episode
		this.owedUntil = time + this.tuning.deflateMs
	}

	/**
	 * The slice of the owed zoom to hand back this frame. Folding it into the
	 * frame's scale means it composes with whatever the fingers are doing now,
	 * rather than fighting a camera animation for the same value.
	 */
	private deflationStep(time: number): number {
		if (this.owedScale === 1) return 1
		const remaining = this.owedUntil - time
		if (remaining <= 0) {
			const step = this.owedScale
			this.owedScale = 1
			this.owedUntil = 0
			return step
		}
		// Multiplicative, so equal fractions of the log are returned per unit time.
		const elapsed = this.tuning.deflateMs - remaining
		const previous = Math.max(0, elapsed - (time - this.lastTime))
		const portion = (elapsed - previous) / this.tuning.deflateMs
		const step = Math.pow(this.owedScale, portion)
		this.owedScale = this.owedScale / step
		return step
	}
}
