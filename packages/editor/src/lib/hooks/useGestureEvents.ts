import * as React from 'react'
import { TLWheelEventInfo } from '../editor/types/event-types'
import { TLViewportId } from '../editor/viewports/TLViewport'
import { tlenv } from '../globals/environment'
import { Vec } from '../primitives/Vec'
import { preventDefault } from '../utils/dom'
import { isAccelKey } from '../utils/keyboard'
import { normalizeWheel } from '../utils/normalizeWheel'
import { GestureInterpreter, TLGesturePoint } from './gesture/GestureInterpreter'
import { useEditor } from './useEditor'

/*

# How does pinching work?

The pinching handler is fired under two circumstances:
- when a user is on a MacBook trackpad and is ZOOMING with a two-finger pinch
- when a user is on a touch device and is ZOOMING with a two-finger pinch
- when a user is on a touch device and is PANNING with two fingers

Zooming is much more expensive than panning (because it causes shapes to render),
so we want to be sure that we don't zoom while two-finger panning.

A trackpad pinch says what it is: a `gesturechange` event is a zoom and nothing
else, so that path below zooms directly.

Fingers do not. Reading them is `GestureInterpreter`, which is told about every
touch that arrives, moves and leaves, and answers with what to apply this frame.
It can change its mind — a pinch that turns out to be a pan gives the zoom back
if the zoom was small enough to have been a finger settling — and it reports pan
deltas from the first frame, so a pan never waits to be recognised. See the file
for why it is shaped that way.

Everything it returns is a per-frame delta, and on the frame where its reading
changes the deltas are zero. So changing what a gesture means, or how many
fingers it has, cannot make the camera jump.

*/

/** Safari's non-standard GestureEvent */
interface GestureEvent extends Event {
	scale: number
	rotation: number
	clientX: number
	clientY: number
	shiftKey: boolean
	altKey: boolean
	metaKey: boolean
	ctrlKey: boolean
}

export function useGestureEvents(
	ref: React.RefObject<HTMLDivElement | null>,
	opts?: { viewportId?: TLViewportId }
) {
	const editor = useEditor()
	const viewportId = opts?.viewportId

	React.useEffect(() => {
		const elm = ref.current
		if (!elm) return

		// --- Wheel handling ---

		function onWheel(event: WheelEvent) {
			if (!editor.getInstanceState().isFocused) {
				return
			}

			// Don't handle wheel events over a scrollable editing shape
			const editingShapeId = editor.getEditingShapeId()
			if (editingShapeId) {
				const shape = editor.getShape(editingShapeId)
				if (shape) {
					const util = editor.getShapeUtil(shape)
					if (util.canScroll(shape)) {
						const bounds = editor.getShapePageBounds(editingShapeId)
						if (bounds?.containsPoint(editor.inputs.getCurrentPagePoint())) {
							return
						}
					}
				}
			}

			preventDefault(event)
			event.stopPropagation()
			const delta = normalizeWheel(event)

			if (delta.x === 0 && delta.y === 0) return

			const info: TLWheelEventInfo = {
				type: 'wheel',
				name: 'wheel',
				delta,
				point: new Vec(event.clientX, event.clientY),
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.metaKey || event.ctrlKey,
				metaKey: event.metaKey,
				accelKey: isAccelKey(event),
				viewportId,
			}

			editor.dispatch(info)
		}

		// --- Pinch state shared by both input paths ---

		const prevPointBetweenFingers = new Vec()

		/**
		 * The zoom level in scale space, accumulated multiplicatively and clamped to
		 * the camera's bounds. Multiplicative rather than measured from the start of
		 * the gesture, because the interpreter re-baselines whenever its reading
		 * changes and there is then no "start" left to measure from.
		 */
		let scaleOffset = 1

		function getScaleBounds() {
			const baseZoom = editor.getBaseZoom()
			const { zoomSteps, zoomSpeed } = editor.getCameraOptions()
			const zoomMin = zoomSteps[0] * baseZoom
			const zoomMax = zoomSteps[zoomSteps.length - 1] * baseZoom
			return {
				min: zoomMin ** (1 / zoomSpeed),
				max: zoomMax ** (1 / zoomSpeed),
			}
		}

		function getScaleFrom() {
			const { zoomSpeed } = editor.getCameraOptions()
			return editor.getZoomLevel() ** (1 / zoomSpeed)
		}

		function applyScale(factor: number) {
			const bounds = getScaleBounds()
			scaleOffset = Math.min(bounds.max, Math.max(bounds.min, scaleOffset * factor))
			return scaleOffset ** editor.getCameraOptions().zoomSpeed
		}

		function dispatchPinchEvent(
			name: 'pinch_start' | 'pinch' | 'pinch_end',
			origin: { x: number; y: number },
			delta: { x: number; y: number },
			zoom: number,
			event: TouchEvent | GestureEvent
		) {
			editor.dispatch({
				type: 'pinch',
				name,
				point: { x: origin.x, y: origin.y, z: zoom },
				delta,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.metaKey || event.ctrlKey,
				metaKey: event.metaKey,
				accelKey: isAccelKey(event),
				viewportId,
			})
		}

		// --- Touch pinch handling ---

		const interpreter = new GestureInterpreter()
		let isPinching = false

		// TEMPORARY. Records what the camera has against what it is being handed,
		// every frame, and posts the gesture in one payload on release. This lives
		// in the fork because the app's own gesture code sits behind an `expanded`
		// guard and does not run on a plain document page. Remove once the flick is
		// located.
		let trace: Array<Record<string, unknown>> = []
		function traceFrame(phase: string, handedZ: number, extra: Record<string, unknown> = {}) {
			try {
				const cam = editor.getCamera()
				trace.push({
					phase,
					camZ: Number(cam.z.toPrecision(12)),
					handedZ: Number(handedZ.toPrecision(12)),
					deltaZ: Number((handedZ - cam.z).toPrecision(6)),
					camX: Number(cam.x.toFixed(2)),
					camY: Number(cam.y.toFixed(2)),
					...extra,
				})
			} catch {
				trace.push({ phase, error: true })
			}
		}
		function flushTrace(why: string) {
			if (!trace.length) return
			const payload = trace
			trace = []
			try {
				const zs = payload.map((p) => p.camZ as number).filter((v) => typeof v === 'number')
				const body = JSON.stringify({
					ts: new Date().toISOString(),
					level: 'warn',
					ns: 'fork-pinch-trace',
					msg: 'fork pinch trace',
					data: {
						why,
						frames: payload.length,
						camZFirst: zs[0],
						camZLast: zs[zs.length - 1],
						camZMin: Math.min(...zs),
						camZMax: Math.max(...zs),
						maxAbsDeltaZ: Math.max(...payload.map((p) => Math.abs((p.deltaZ as number) || 0))),
						trace: payload,
					},
				})
				navigator.sendBeacon?.('/api/log', new Blob([body], { type: 'application/json' }))
			} catch {
				// never let instrumentation affect the gesture
			}
		}
		/** Bumped to abandon an in-flight give-back when the user touches again. */
		let deflationId = 0

		function touchPoints(event: TouchEvent): TLGesturePoint[] {
			return Array.from(event.touches).map((t) => ({
				id: t.identifier,
				x: t.clientX,
				y: t.clientY,
			}))
		}

		/**
		 * Hand back a zoom the interpreter judged accidental, over `ms`, by going on
		 * dispatching pinch frames after the fingers have left. Reusing the pinch
		 * path means the give-back zooms about the same point the gesture did,
		 * rather than reimplementing that math against the camera.
		 */
		function deflate(
			owed: { scale: number; ms: number },
			origin: { x: number; y: number },
			event: TouchEvent
		) {
			const id = ++deflationId
			const from = scaleOffset
			const to = scaleOffset * owed.scale
			let startedAt = -1

			const step = (now: number) => {
				if (id !== deflationId) return // the user started something else
				if (startedAt < 0) startedAt = now

				const t = Math.min(1, (now - startedAt) / owed.ms)
				// Eased at both ends, so it reads as the application correcting itself
				// rather than as a second thing going wrong.
				const eased = t * t * (3 - 2 * t)
				scaleOffset = from * Math.pow(to / from, eased)
				const zoom = scaleOffset ** editor.getCameraOptions().zoomSpeed

				if (t < 1) {
					dispatchPinchEvent('pinch', origin, { x: 0, y: 0 }, zoom, event)
					editor.timers.requestAnimationFrame(step)
					return
				}

				isPinching = false
				dispatchPinchEvent('pinch_end', origin, { x: 0, y: 0 }, zoom, event)
			}

			editor.timers.requestAnimationFrame(step)
		}

		function endPinch(event: TouchEvent) {
			const origin = { x: prevPointBetweenFingers.x, y: prevPointBetweenFingers.y }
			const owed = interpreter.end()

			if (owed) {
				deflate(owed, origin, event)
				return
			}

			isPinching = false
			const zoom = scaleOffset ** editor.getCameraOptions().zoomSpeed
			traceFrame('pinch_end', zoom, { owed: owed ? 'yes' : 'no' })
			editor.timers.requestAnimationFrame(() => {
				dispatchPinchEvent('pinch_end', origin, { x: 0, y: 0 }, zoom, event)
				editor.timers.setTimeout(() => {
					traceFrame('settled+250ms', zoom)
					flushTrace('pinch_end')
				}, 250)
			})
		}

		/**
		 * Every touch event goes through here. A finger arriving or leaving is a
		 * change to the gesture rather than the end of one, so there is no separate
		 * start or end handler deciding anything.
		 */
		function handleTouches(event: TouchEvent) {
			const frame = interpreter.update(touchPoints(event), event.timeStamp)

			if (frame.count < 2) {
				// Leave the origin at the last point the fingers actually pinched about,
				// which is where a give-back should zoom about too.
				if (isPinching) endPinch(event)
				return
			}

			prevPointBetweenFingers.x = frame.origin.x
			prevPointBetweenFingers.y = frame.origin.y

			if (!isPinching) {
				deflationId++ // abandon any give-back still running
				isPinching = true
				scaleOffset = getScaleFrom()
				traceFrame('pinch_start', editor.getZoomLevel(), {
					n: frame.count,
					kind: frame.kind,
					origX: Number(frame.origin.x.toFixed(1)),
					origY: Number(frame.origin.y.toFixed(1)),
					bounds: getScaleBounds(),
					scaleOffset: Number(scaleOffset.toPrecision(12)),
				})
				dispatchPinchEvent(
					'pinch_start',
					frame.origin,
					{ x: 0, y: 0 },
					editor.getZoomLevel(),
					event
				)
				return
			}

			// A gesture that is not a zoom must hand back the zoom the camera already
			// has, exactly. The camera update zooms about the gesture origin —
			// `- x/cz + x/z` — so those terms cancel only when `z` is byte-identical
			// to the camera's own `z`. Anything else, including a scale accumulator
			// that is merely close, turns a moving origin into a visible flick, and
			// the origin moves furthest at exactly the moment a third finger lands.
			// So while panning, read the live camera rather than the accumulator, and
			// keep the accumulator in step for when a zoom does start.
			let zoom: number
			if (frame.kind === 'zooming') {
				zoom = applyScale(frame.scale)
			} else {
				scaleOffset = getScaleFrom()
				zoom = editor.getZoomLevel()
			}

			traceFrame('pinch', zoom, {
				n: frame.count,
				kind: frame.kind,
				transitioned: frame.transitioned,
				panX: Number(frame.pan.x.toFixed(2)),
				panY: Number(frame.pan.y.toFixed(2)),
				scale: Number(frame.scale.toPrecision(8)),
				origX: Number(frame.origin.x.toFixed(1)),
				origY: Number(frame.origin.y.toFixed(1)),
			})
			dispatchPinchEvent('pinch', frame.origin, frame.pan, zoom, event)
		}

		function onTouchStart(event: TouchEvent) {
			if (!(event.target === elm || elm?.contains(event.target as Node))) return
			handleTouches(event)
		}

		// --- Safari trackpad pinch (GestureEvent) ---

		/** `GestureEvent.scale` is relative to the start of the gesture, so is this. */
		let safariGestureInitialScale = 1

		function onGestureStart(event: Event) {
			const e = event as GestureEvent
			if (!(e.target === elm || elm?.contains(e.target as Node))) return

			preventDefault(e)
			e.stopPropagation()

			deflationId++
			safariGestureInitialScale = getScaleFrom()
			scaleOffset = safariGestureInitialScale

			prevPointBetweenFingers.x = e.clientX
			prevPointBetweenFingers.y = e.clientY

			dispatchPinchEvent(
				'pinch_start',
				{ x: e.clientX, y: e.clientY },
				{ x: 0, y: 0 },
				editor.getZoomLevel(),
				e
			)
		}

		function onGestureChange(event: Event) {
			const e = event as GestureEvent
			if (!(e.target === elm || elm?.contains(e.target as Node))) return

			preventDefault(e)
			e.stopPropagation()

			const dx = e.clientX - prevPointBetweenFingers.x
			const dy = e.clientY - prevPointBetweenFingers.y

			prevPointBetweenFingers.x = e.clientX
			prevPointBetweenFingers.y = e.clientY

			// Safari GestureEvent.scale is a multiplier relative to the gesture start,
			// so the absolute it implies is the reference scale times it.
			const bounds = getScaleBounds()
			const rawScale = safariGestureInitialScale * e.scale
			scaleOffset = Math.min(bounds.max, Math.max(bounds.min, rawScale))
			const currZoom = scaleOffset ** editor.getCameraOptions().zoomSpeed

			dispatchPinchEvent('pinch', { x: e.clientX, y: e.clientY }, { x: dx, y: dy }, currZoom, e)
		}

		function onGestureEnd(event: Event) {
			const e = event as GestureEvent
			if (!(e.target === elm || elm?.contains(e.target as Node))) return

			preventDefault(e)
			e.stopPropagation()

			const scale = scaleOffset ** editor.getCameraOptions().zoomSpeed

			editor.timers.requestAnimationFrame(() => {
				dispatchPinchEvent(
					'pinch_end',
					{ x: e.clientX, y: e.clientY },
					{ x: e.clientX, y: e.clientY },
					scale,
					e
				)
			})
		}

		// --- Attach event listeners ---

		elm.addEventListener('wheel', onWheel, { passive: false })

		// On touch devices (iOS), use pointer events for pinch.
		// On non-touch Safari (macOS trackpad), use GestureEvent.
		// Never use both simultaneously — on iOS Safari, both event types fire
		// for the same pinch gesture, causing conflicting state updates.
		const useGestureEvents = !tlenv.isIos && 'GestureEvent' in window

		if (useGestureEvents) {
			elm.addEventListener('gesturestart', onGestureStart)
			elm.addEventListener('gesturechange', onGestureChange)
			elm.addEventListener('gestureend', onGestureEnd)
		} else {
			elm.addEventListener('touchstart', onTouchStart)
			elm.addEventListener('touchmove', handleTouches)
			elm.addEventListener('touchend', handleTouches)
			elm.addEventListener('touchcancel', handleTouches)
		}

		return () => {
			deflationId++
			elm.removeEventListener('wheel', onWheel)
			if (useGestureEvents) {
				elm.removeEventListener('gesturestart', onGestureStart)
				elm.removeEventListener('gesturechange', onGestureChange)
				elm.removeEventListener('gestureend', onGestureEnd)
			} else {
				elm.removeEventListener('touchstart', onTouchStart)
				elm.removeEventListener('touchmove', handleTouches)
				elm.removeEventListener('touchend', handleTouches)
				elm.removeEventListener('touchcancel', handleTouches)
			}
		}
	}, [editor, ref, viewportId])
}
