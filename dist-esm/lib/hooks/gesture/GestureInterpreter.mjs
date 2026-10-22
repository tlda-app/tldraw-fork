const DEFAULT_GESTURE_TUNING = {
  decay: 0.8,
  minMotion: 2,
  decideRatio: 1.2,
  stealRatio: 2,
  deflateWithin: 2,
  deflateMs: 260,
  minAxisSpread: 8
};
function centroidOf(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}
function spreadOf(points, centroid) {
  if (points.length < 2) return { d: 0, x: 0, y: 0 };
  let d = 0;
  let x = 0;
  let y = 0;
  for (const p of points) {
    d += Math.hypot(p.x - centroid.x, p.y - centroid.y);
    x += Math.abs(p.x - centroid.x);
    y += Math.abs(p.y - centroid.y);
  }
  const n = points.length / 2;
  return { d: d / n, x: x / n, y: y / n };
}
function keyOf(points) {
  return points.map((p) => p.id).sort((a, b) => a - b).join(",");
}
class GestureInterpreter {
  tuning;
  kind = "undecided";
  pointKey = "";
  count = 0;
  centroid = { x: 0, y: 0 };
  spread = { d: 0, x: 0, y: 0 };
  /** Decayed recent motion. These, not totals since the start, decide the kind. */
  recentTravel = 0;
  recentSpread = 0;
  /** Scale applied since the current zoom episode began. Reset on entering `zooming`. */
  episodeScale = 1;
  /** Scale still owed back from a zoom that turned out to be a finger settling. */
  owedScale = 1;
  owedUntil = 0;
  lastTime = 0;
  constructor(tuning = {}) {
    this.tuning = { ...DEFAULT_GESTURE_TUNING, ...tuning };
  }
  getKind() {
    return this.kind;
  }
  getCount() {
    return this.count;
  }
  /** True while a zoom is being handed back. */
  isDeflating() {
    return this.owedScale !== 1;
  }
  /**
   * Read the current touches and say what to apply. Call this for every
   * touchstart, touchmove and touchend while any finger is down — arrivals and
   * departures are gesture changes, not gesture boundaries.
   */
  update(points, time) {
    const count = points.length;
    const centroid = count > 0 ? centroidOf(points) : this.centroid;
    const spread = spreadOf(points, centroid);
    const key = keyOf(points);
    const pointsChanged = key !== this.pointKey;
    const dx = pointsChanged ? 0 : centroid.x - this.centroid.x;
    const dy = pointsChanged ? 0 : centroid.y - this.centroid.y;
    const dSpread = pointsChanged ? 0 : spread.d - this.spread.d;
    const ratio = (now, before) => pointsChanged || before < this.tuning.minAxisSpread ? 1 : now / before;
    const frameScale = ratio(spread.d, this.spread.d);
    const frameScaleX = this.spread.x < this.tuning.minAxisSpread ? frameScale : ratio(spread.x, this.spread.x);
    const frameScaleY = this.spread.y < this.tuning.minAxisSpread ? frameScale : ratio(spread.y, this.spread.y);
    const decay = this.tuning.decay;
    this.recentTravel = this.recentTravel * decay + Math.hypot(dx, dy);
    this.recentSpread = this.recentSpread * decay + Math.abs(dSpread);
    const previousKind = this.kind;
    this.kind = this.nextKind(count);
    const kindChanged = this.kind !== previousKind;
    const transitioned = kindChanged || pointsChanged;
    if (kindChanged) {
      this.onLeavingKind(previousKind, time);
      if (this.kind === "zooming") this.episodeScale = 1;
    }
    this.pointKey = key;
    this.count = count;
    this.centroid = centroid;
    this.spread = spread;
    this.lastTime = time;
    const pan = transitioned ? { x: 0, y: 0 } : { x: dx, y: dy };
    const scaling = !transitioned && this.kind === "zooming";
    let scale = scaling ? frameScale : 1;
    let scaleX = scaling ? frameScaleX : 1;
    let scaleY = scaling ? frameScaleY : 1;
    if (this.kind === "zooming") this.episodeScale *= scale;
    const step = this.deflationStep(time);
    scale *= step;
    scaleX *= step;
    scaleY *= step;
    return { kind: this.kind, count, transitioned, pan, scale, scaleX, scaleY, origin: centroid };
  }
  /**
   * The gesture ended. Any zoom still owed back is returned as a single factor
   * for the owner to animate over `deflateMs`, since there are no more frames to
   * spread it across.
   */
  end() {
    const owed = this.owedScale;
    this.reset();
    if (owed === 1) return null;
    return { scale: owed, ms: this.tuning.deflateMs };
  }
  reset() {
    this.kind = "undecided";
    this.pointKey = "";
    this.count = 0;
    this.spread = { d: 0, x: 0, y: 0 };
    this.recentTravel = 0;
    this.recentSpread = 0;
    this.episodeScale = 1;
    this.owedScale = 1;
    this.owedUntil = 0;
  }
  /**
   * Question one, re-answered every frame. Symmetric: a zoom can be taken back
   * by a pan on exactly the terms a pan can be taken by a zoom.
   */
  nextKind(count) {
    if (count < 2) return "undecided";
    const { minMotion, decideRatio, stealRatio } = this.tuning;
    if (this.recentTravel + this.recentSpread < minMotion) return this.kind;
    const ratio = this.kind === "undecided" ? decideRatio : stealRatio;
    if (this.recentSpread > this.recentTravel * ratio) return "zooming";
    if (this.recentTravel > this.recentSpread * ratio) return "panning";
    return this.kind;
  }
  /**
   * Question two, asked only on a change and answered only by magnitude. A zoom
   * small enough to have been a finger settling is given back; one large enough
   * to have been meant is kept, whatever the gesture turned into afterwards.
   */
  onLeavingKind(kind, time) {
    if (kind !== "zooming") return;
    const episode = this.episodeScale;
    this.episodeScale = 1;
    if (episode === 1) return;
    const within = this.tuning.deflateWithin;
    if (episode > within || episode < 1 / within) return;
    this.owedScale = 1 / episode;
    this.owedUntil = time + this.tuning.deflateMs;
  }
  /**
   * The slice of the owed zoom to hand back this frame. Folding it into the
   * frame's scale means it composes with whatever the fingers are doing now,
   * rather than fighting a camera animation for the same value.
   */
  deflationStep(time) {
    if (this.owedScale === 1) return 1;
    const remaining = this.owedUntil - time;
    if (remaining <= 0) {
      const step2 = this.owedScale;
      this.owedScale = 1;
      this.owedUntil = 0;
      return step2;
    }
    const elapsed = this.tuning.deflateMs - remaining;
    const previous = Math.max(0, elapsed - (time - this.lastTime));
    const portion = (elapsed - previous) / this.tuning.deflateMs;
    const step = Math.pow(this.owedScale, portion);
    this.owedScale = this.owedScale / step;
    return step;
  }
}
export {
  DEFAULT_GESTURE_TUNING,
  GestureInterpreter
};
//# sourceMappingURL=GestureInterpreter.mjs.map
