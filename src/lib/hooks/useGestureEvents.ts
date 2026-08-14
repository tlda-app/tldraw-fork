import * as React from 'react'
import { TLWheelEventInfo } from '../editor/types/event-types'
import { TLViewportId } from '../editor/viewports/TLViewport'
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
			editor.timers.requestAnimationFrame(() => {
				dispatchPinchEvent('pinch_end', origin, { x: 0, y: 0 }, zoom, event)
			})
		}

		/**
		 * Every touch event goes through here. A finger arriving or leaving is a
		 * change to the gesture rather than the end of one, so there is no separate
		 * start or end handler deciding anything.
		 */
		function handleTouches(event: TouchEvent) {
			activeTouches = event.touches.length
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

			dispatchPinchEvent('pinch', frame.origin, frame.pan, zoom, event)
		}

		function onTouchStart(event: TouchEvent) {
			if (!(event.target === elm || elm?.contains(event.target as Node))) return
			handleTouches(event)
		}

		// --- Safari trackpad pinch (GestureEvent) ---

		/** `GestureEvent.scale` is relative to the start of the gesture, so is this. */
		let safariGestureInitialScale = 1

		/**
		 * Whether fingers are on the glass right now.
		 *
		 * The comment at the top of this file says a `gesturechange` is a zoom and
		 * nothing else. That is true of a trackpad and false of iPadOS, which fires
		 * the same events for a two-finger touch gesture — interleaved with the
		 * touchmoves, one pair per frame. Recorded on a real iPad: 204 GestureEvents
		 * across a single drag, every one carrying a `scale` that merely reflects how
		 * the finger spread happened to change, and `onGestureChange` zooming the
		 * camera from it with no classification in the way. One drag went 1.66 to
		 * 4.75. It also explains why nothing in `GestureInterpreter` could affect it:
		 * the touch path was never the one running.
		 *
		 * So the GestureEvent path is for a trackpad, and a trackpad has no touches.
		 * While any finger is down, the touch path owns the gesture.
		 */
		let activeTouches = 0

		function onGestureStart(event: Event) {
			const e = event as GestureEvent
			if (!(e.target === elm || elm?.contains(e.target as Node))) return

			preventDefault(e)
			e.stopPropagation()

			// Fingers own this gesture; the touch path is already reading it. Still
			// swallow the event so Safari does not page-zoom on top of us.
			if (activeTouches > 0) return

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

			// Fingers own this gesture; the touch path is already reading it. Still
			// swallow the event so Safari does not page-zoom on top of us.
			if (activeTouches > 0) return

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

			// Fingers own this gesture; the touch path is already reading it. Still
			// swallow the event so Safari does not page-zoom on top of us.
			if (activeTouches > 0) return

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

		// On a touch device, read the touches. On non-touch Safari (macOS trackpad),
		// use GestureEvent. Never both — Safari fires both for the same pinch, and
		// two handlers driving one camera is the conflict this branch exists to stop.
		//
		// The test used to be `!tlenv.isIos`, and that is the bug an iPad exposes:
		// iPadOS Safari presents itself as a Mac, so `isIos` is false, so an iPad
		// took the trackpad branch. The touch listeners were then never registered,
		// `GestureInterpreter` never saw a single finger, and the camera was driven
		// straight from `GestureEvent.scale` with no pan-or-zoom decision anywhere.
		// That is why a two-finger drag zoomed: on that path, nothing ever asks.
		//
		// Ask about the input instead of the operating system. A trackpad reports no
		// touch points; a screen you can put fingers on reports some.
		const hasTouchScreen =
			(typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
			(typeof window !== 'undefined' && 'ontouchstart' in window)
		const useGestureEvents = !hasTouchScreen && 'GestureEvent' in window

		// Belt and braces for the case the branch above is still wrong somewhere:
		// count fingers at the document, so `activeTouches` is true even when our own
		// touch listeners are not the ones registered. Whether a finger is on the
		// glass is a property of the screen, not of which element was hit.
		const countTouches = (e: Event) => {
			activeTouches = (e as TouchEvent).touches.length
		}
		const touchCountOpts = { capture: true, passive: true } as AddEventListenerOptions
		for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
			document.addEventListener(name, countTouches, touchCountOpts)
		}

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
			for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
				document.removeEventListener(name, countTouches, touchCountOpts)
			}
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
