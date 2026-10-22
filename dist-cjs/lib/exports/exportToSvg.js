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
var exportToSvg_exports = {};
__export(exportToSvg_exports, {
  embedSvgHtml: () => embedSvgHtml,
  exportToSvg: () => exportToSvg
});
module.exports = __toCommonJS(exportToSvg_exports);
var import_utils = require("@tldraw/utils");
var import_react_dom = require("react-dom");
var import_client = require("react-dom/client");
var import_domUtils = require("./domUtils");
var import_embedMedia = require("./embedMedia");
var import_FontEmbedder = require("./FontEmbedder");
var import_getSvgJsx = require("./getSvgJsx");
var import_StyleEmbedder = require("./StyleEmbedder");
let idCounter = 1;
async function exportToSvg(editor, shapeIds, opts = {}, delay) {
  const result = (0, import_getSvgJsx.getSvgJsx)(editor, shapeIds, opts, delay);
  if (!result) return void 0;
  const container = editor.getContainer();
  const renderTarget = container.ownerDocument.createElement("div");
  renderTarget.className = import_FontEmbedder.SVG_EXPORT_CLASSNAME;
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
  const root = (0, import_client.createRoot)(renderTarget, { identifierPrefix: `export_${idCounter++}_` });
  try {
    await Promise.resolve();
    if (opts.strict) result.exportDelay.signal.throwIfAborted();
    (0, import_react_dom.flushSync)(() => {
      root.render(result.jsx);
    });
    await result.exportDelay.resolve();
    const svg = renderTarget.firstElementChild;
    (0, import_utils.assert)(svg instanceof (0, import_domUtils.getOwnerWindow)(container).SVGSVGElement, "Expected an SVG element");
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
  (0, import_utils.assert)(document.defaultView, "HTML export source document has no browsing context");
  (0, import_utils.assert)(
    roots.every((root) => root.isConnected && root.ownerDocument === document),
    "HTML export roots must be connected to the same source document"
  );
  const styleEmbedder = new import_StyleEmbedder.StyleEmbedder(roots[0]);
  try {
    styleEmbedder.fonts.startFindingDocumentFontFaces(document);
    await Promise.all(roots.map((el) => (0, import_embedMedia.embedMedia)(el)));
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
//# sourceMappingURL=exportToSvg.js.map
