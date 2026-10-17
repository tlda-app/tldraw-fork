import { assert } from "@tldraw/utils";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { getOwnerWindow } from "./domUtils.mjs";
import { embedMedia } from "./embedMedia.mjs";
import { SVG_EXPORT_CLASSNAME } from "./FontEmbedder.mjs";
import { getSvgJsx } from "./getSvgJsx.mjs";
import { StyleEmbedder } from "./StyleEmbedder.mjs";
let idCounter = 1;
async function exportToSvg(editor, shapeIds, opts = {}, delay) {
  const result = getSvgJsx(editor, shapeIds, opts, delay);
  if (!result) return void 0;
  const container = editor.getContainer();
  const renderTarget = container.ownerDocument.createElement("div");
  renderTarget.className = SVG_EXPORT_CLASSNAME;
  renderTarget.inert = true;
  renderTarget.tabIndex = -1;
  Object.assign(renderTarget.style, {
    position: "absolute",
    top: "0px",
    left: "0px",
    width: result.width + "px",
    height: result.height + "px",
    pointerEvents: "none",
    opacity: 0
  });
  container.appendChild(renderTarget);
  const root = createRoot(renderTarget, { identifierPrefix: `export_${idCounter++}_` });
  try {
    await Promise.resolve();
    if (opts.strict) result.exportDelay.signal.throwIfAborted();
    flushSync(() => {
      root.render(result.jsx);
    });
    await result.exportDelay.resolve();
    const svg = renderTarget.firstElementChild;
    assert(svg instanceof getOwnerWindow(container).SVGSVGElement, "Expected an SVG element");
    await result.exportDelay.waitFor(
      applyChangesToForeignObjects(svg, {
        strict: opts.strict,
        signal: opts.strict ? result.exportDelay.signal : void 0
      })
    );
    return { svg, width: result.width, height: result.height, trimPadding: result.trimPadding };
  } finally {
    result.exportDelay.dispose();
    setTimeout(() => {
      root.unmount();
      container.removeChild(renderTarget);
    }, 0);
  }
}
async function applyChangesToForeignObjects(svg, options) {
  const foreignObjectChildren = [
    ...svg.querySelectorAll("foreignObject.tl-export-embed-styles > *")
  ];
  if (!foreignObjectChildren.length) return;
  const css = await embedSvgHtml(foreignObjectChildren, options);
  if (css) {
    const style = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = css;
    svg.prepend(style);
  }
}
async function embedSvgHtml(roots, options = {}) {
  options.signal?.throwIfAborted();
  if (!roots.length) return "";
  const document = roots[0].ownerDocument;
  assert(document.defaultView, "HTML export source document has no browsing context");
  assert(
    roots.every((root) => root.isConnected && root.ownerDocument === document),
    "HTML export roots must be connected to the same source document"
  );
  const styleEmbedder = new StyleEmbedder(roots[0]);
  try {
    styleEmbedder.fonts.startFindingDocumentFontFaces(document);
    await Promise.all(roots.map((el) => embedMedia(el)));
    options.signal?.throwIfAborted();
    for (const el of roots) {
      styleEmbedder.readRootElementStyles(el);
    }
    await styleEmbedder.fetchResources(options.strict);
    const fontCss = await styleEmbedder.getFontFaceCss(options.strict);
    options.signal?.throwIfAborted();
    styleEmbedder.unwrapCustomElements();
    const pseudoCss = styleEmbedder.embedStyles();
    return fontCss || pseudoCss ? `${fontCss}
${pseudoCss}` : "";
  } finally {
    styleEmbedder.dispose();
  }
}
export {
  embedSvgHtml,
  exportToSvg
};
//# sourceMappingURL=exportToSvg.mjs.map
