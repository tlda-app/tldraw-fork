"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var useGestureEvents_exports = {};
__export(useGestureEvents_exports, {
  useGestureEvents: () => useGestureEvents
});
module.exports = __toCommonJS(useGestureEvents_exports);
var React = __toESM(require("react"), 1);
var import_Vec = require("../primitives/Vec");
var import_dom = require("../utils/dom");
var import_keyboard = require("../utils/keyboard");
var import_normalizeWheel = require("../utils/normalizeWheel");
var import_GestureInterpreter = require("./gesture/GestureInterpreter");
var import_useEditor = require("./useEditor");
function useGestureEvents(ref, opts) {
  const editor = (0, import_useEditor.useEditor)();
  const viewportId = opts?.viewportId;
  React.useEffect(() => {
    const elm = ref.current;
    if (!elm) return;
    function onWheel(event) {
      if (!editor.getInstanceState().isFocused) {
        return;
      }
      const editingShapeId = editor.getEditingShapeId();
      if (editingShapeId) {
        const shape = editor.getShape(editingShapeId);
        if (shape) {
          const util = editor.getShapeUtil(shape);
          if (util.canScroll(shape)) {
            const bounds = editor.getShapePageBounds(editingShapeId);
            if (bounds?.containsPoint(editor.inputs.getCurrentPagePoint())) {
              return;
            }
          }
        }
      }
      (0, import_dom.preventDefault)(event);
      event.stopPropagation();
      const delta = (0, import_normalizeWheel.normalizeWheel)(event);
      if (delta.x === 0 && delta.y === 0) return;
      const info = {
        type: "wheel",
        name: "wheel",
        delta,
        point: new import_Vec.Vec(event.clientX, event.clientY),
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.metaKey || event.ctrlKey,
        metaKey: event.metaKey,
        accelKey: (0, import_keyboard.isAccelKey)(event),
        viewportId
      };
      editor.dispatch(info);
    }
    const prevPointBetweenFingers = new import_Vec.Vec();
    let scaleOffset = 1;
    function getScaleBounds() {
      const baseZoom = editor.getBaseZoom();
      const { zoomSteps, zoomSpeed } = editor.getCameraOptions();
      const zoomMin = zoomSteps[0] * baseZoom;
      const zoomMax = zoomSteps[zoomSteps.length - 1] * baseZoom;
      return {
        min: zoomMin ** (1 / zoomSpeed),
        max: zoomMax ** (1 / zoomSpeed)
      };
    }
    function getScaleFrom() {
      const { zoomSpeed } = editor.getCameraOptions();
      return editor.getZoomLevel() ** (1 / zoomSpeed);
    }
    function applyScale(factor) {
      const bounds = getScaleBounds();
      scaleOffset = Math.min(bounds.max, Math.max(bounds.min, scaleOffset * factor));
      return scaleOffset ** editor.getCameraOptions().zoomSpeed;
    }
    function dispatchPinchEvent(name, origin, delta, zoom, event) {
      editor.dispatch({
        type: "pinch",
        name,
        point: { x: origin.x, y: origin.y, z: zoom },
        delta,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.metaKey || event.ctrlKey,
        metaKey: event.metaKey,
        accelKey: (0, import_keyboard.isAccelKey)(event),
        viewportId
      });
    }
    const interpreter = new import_GestureInterpreter.GestureInterpreter();
    let isPinching = false;
    let deflationId = 0;
    function touchPoints(event) {
      return Array.from(event.touches).map((t) => ({
        id: t.identifier,
        x: t.clientX,
        y: t.clientY
      }));
    }
    function deflate(owed, origin, event) {
      const id = ++deflationId;
      const from = scaleOffset;
      const to = scaleOffset * owed.scale;
      let startedAt = -1;
      const step = (now) => {
        if (id !== deflationId) return;
        if (startedAt < 0) startedAt = now;
        const t = Math.min(1, (now - startedAt) / owed.ms);
        const eased = t * t * (3 - 2 * t);
        scaleOffset = from * Math.pow(to / from, eased);
        const zoom = scaleOffset ** editor.getCameraOptions().zoomSpeed;
        if (t < 1) {
          dispatchPinchEvent("pinch", origin, { x: 0, y: 0 }, zoom, event);
          editor.timers.requestAnimationFrame(step);
          return;
        }
        isPinching = false;
        dispatchPinchEvent("pinch_end", origin, { x: 0, y: 0 }, zoom, event);
      };
      editor.timers.requestAnimationFrame(step);
    }
    function endPinch(event) {
      const origin = { x: prevPointBetweenFingers.x, y: prevPointBetweenFingers.y };
      const owed = interpreter.end();
      if (owed) {
        deflate(owed, origin, event);
        return;
      }
      isPinching = false;
      const zoom = scaleOffset ** editor.getCameraOptions().zoomSpeed;
      editor.timers.requestAnimationFrame(() => {
        dispatchPinchEvent("pinch_end", origin, { x: 0, y: 0 }, zoom, event);
      });
    }
    function handleTouches(event) {
      activeTouches = event.touches.length;
      const frame = interpreter.update(touchPoints(event), event.timeStamp);
      if (frame.count < 2) {
        if (isPinching) endPinch(event);
        return;
      }
      prevPointBetweenFingers.x = frame.origin.x;
      prevPointBetweenFingers.y = frame.origin.y;
      if (!isPinching) {
        deflationId++;
        isPinching = true;
        scaleOffset = getScaleFrom();
        dispatchPinchEvent(
          "pinch_start",
          frame.origin,
          { x: 0, y: 0 },
          editor.getZoomLevel(),
          event
        );
        return;
      }
      let zoom;
      if (frame.kind === "zooming") {
        zoom = applyScale(frame.scale);
      } else {
        scaleOffset = getScaleFrom();
        zoom = editor.getZoomLevel();
      }
      dispatchPinchEvent("pinch", frame.origin, frame.pan, zoom, event);
    }
    function onTouchStart(event) {
      if (!(event.target === elm || elm?.contains(event.target))) return;
      handleTouches(event);
    }
    let safariGestureInitialScale = 1;
    let activeTouches = 0;
    function onGestureStart(event) {
      const e = event;
      if (!(e.target === elm || elm?.contains(e.target))) return;
      (0, import_dom.preventDefault)(e);
      e.stopPropagation();
      if (activeTouches > 0) return;
      deflationId++;
      safariGestureInitialScale = getScaleFrom();
      scaleOffset = safariGestureInitialScale;
      prevPointBetweenFingers.x = e.clientX;
      prevPointBetweenFingers.y = e.clientY;
      dispatchPinchEvent(
        "pinch_start",
        { x: e.clientX, y: e.clientY },
        { x: 0, y: 0 },
        editor.getZoomLevel(),
        e
      );
    }
    function onGestureChange(event) {
      const e = event;
      if (!(e.target === elm || elm?.contains(e.target))) return;
      (0, import_dom.preventDefault)(e);
      e.stopPropagation();
      if (activeTouches > 0) return;
      const dx = e.clientX - prevPointBetweenFingers.x;
      const dy = e.clientY - prevPointBetweenFingers.y;
      prevPointBetweenFingers.x = e.clientX;
      prevPointBetweenFingers.y = e.clientY;
      const bounds = getScaleBounds();
      const rawScale = safariGestureInitialScale * e.scale;
      scaleOffset = Math.min(bounds.max, Math.max(bounds.min, rawScale));
      const currZoom = scaleOffset ** editor.getCameraOptions().zoomSpeed;
      dispatchPinchEvent("pinch", { x: e.clientX, y: e.clientY }, { x: dx, y: dy }, currZoom, e);
    }
    function onGestureEnd(event) {
      const e = event;
      if (!(e.target === elm || elm?.contains(e.target))) return;
      (0, import_dom.preventDefault)(e);
      e.stopPropagation();
      if (activeTouches > 0) return;
      const scale = scaleOffset ** editor.getCameraOptions().zoomSpeed;
      editor.timers.requestAnimationFrame(() => {
        dispatchPinchEvent(
          "pinch_end",
          { x: e.clientX, y: e.clientY },
          { x: e.clientX, y: e.clientY },
          scale,
          e
        );
      });
    }
    elm.addEventListener("wheel", onWheel, { passive: false });
    const hasTouchScreen = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 || typeof window !== "undefined" && "ontouchstart" in window;
    const useGestureEvents2 = !hasTouchScreen && "GestureEvent" in window;
    const countTouches = (e) => {
      activeTouches = e.touches.length;
    };
    const touchCountOpts = { capture: true, passive: true };
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      document.addEventListener(name, countTouches, touchCountOpts);
    }
    if (useGestureEvents2) {
      elm.addEventListener("gesturestart", onGestureStart);
      elm.addEventListener("gesturechange", onGestureChange);
      elm.addEventListener("gestureend", onGestureEnd);
    } else {
      elm.addEventListener("touchstart", onTouchStart);
      elm.addEventListener("touchmove", handleTouches);
      elm.addEventListener("touchend", handleTouches);
      elm.addEventListener("touchcancel", handleTouches);
    }
    return () => {
      deflationId++;
      elm.removeEventListener("wheel", onWheel);
      for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
        document.removeEventListener(name, countTouches, touchCountOpts);
      }
      if (useGestureEvents2) {
        elm.removeEventListener("gesturestart", onGestureStart);
        elm.removeEventListener("gesturechange", onGestureChange);
        elm.removeEventListener("gestureend", onGestureEnd);
      } else {
        elm.removeEventListener("touchstart", onTouchStart);
        elm.removeEventListener("touchmove", handleTouches);
        elm.removeEventListener("touchend", handleTouches);
        elm.removeEventListener("touchcancel", handleTouches);
      }
    };
  }, [editor, ref, viewportId]);
}
//# sourceMappingURL=useGestureEvents.js.map
