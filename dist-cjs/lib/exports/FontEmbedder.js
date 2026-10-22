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
var FontEmbedder_exports = {};
__export(FontEmbedder_exports, {
  FontEmbedder: () => FontEmbedder,
  SVG_EXPORT_CLASSNAME: () => SVG_EXPORT_CLASSNAME
});
module.exports = __toCommonJS(FontEmbedder_exports);
var import_utils = require("@tldraw/utils");
var import_fetchCache = require("./fetchCache");
var import_parseCss = require("./parseCss");
const SVG_EXPORT_CLASSNAME = "tldraw-svg-export";
class FontEmbedder {
  fontFacesPromise = null;
  sourceDocument = null;
  foundFontNames = /* @__PURE__ */ new Set();
  fontFacesToEmbed = /* @__PURE__ */ new Set();
  pendingPromises = [];
  startFindingDocumentFontFaces(doc) {
    (0, import_utils.assert)(!this.fontFacesPromise, "FontEmbedder already started");
    this.sourceDocument = doc;
    this.fontFacesPromise = getDocumentFontFaces(doc);
  }
  onFontFamilyValue(fontFamilyValue) {
    (0, import_utils.assert)(this.fontFacesPromise, "FontEmbedder not started");
    const fonts = (0, import_parseCss.parseCssFontFamilyValue)(fontFamilyValue);
    for (const font of fonts) {
      if (this.foundFontNames.has(font)) continue;
      this.foundFontNames.add(font);
      this.pendingPromises.push(
        this.fontFacesPromise.then((fontFaces) => {
          const relevantFontFaces = fontFaces.filter((fontFace) => fontFace.fontFamilies.has(font));
          for (const fontFace of relevantFontFaces) {
            if (this.fontFacesToEmbed.has(fontFace)) continue;
            this.fontFacesToEmbed.add(fontFace);
            for (const url of fontFace.urls) {
              if (!url.resolved || url.embedded) continue;
              url.embedded = (0, import_fetchCache.resourceToDataUrl)(url.resolved);
            }
          }
        })
      );
    }
  }
  async createCss(strict = false) {
    await Promise.all(this.pendingPromises);
    if (strict) {
      const faces = await this.fontFacesPromise;
      for (const font of this.sourceDocument?.fonts ?? []) {
        for (const family of (0, import_parseCss.parseCssFontFamilyValue)(font.family)) {
          if (this.foundFontNames.has(family) && !faces?.some((face) => face.fontFamilies.has(family))) {
            throw new Error(`Cannot embed the source font face ${font.family}`);
          }
        }
      }
    }
    let css = "";
    for (const fontFace of this.fontFacesToEmbed) {
      if (strict && !fontFace.urls.length)
        throw new Error("A source font face has no embeddable font bytes");
      let fontFaceString = `@font-face {${fontFace.fontFace}}`;
      for (const url of fontFace.urls) {
        if (!url.embedded) {
          if (strict) throw new Error("A source font URL could not be resolved");
          continue;
        }
        const dataUrl = await url.embedded;
        if (!dataUrl) {
          if (strict) throw new Error("A source font could not be embedded");
          continue;
        }
        fontFaceString = fontFaceString.replace(url.original, dataUrl);
      }
      css += fontFaceString;
    }
    return css;
  }
}
__decorateClass([
  import_utils.bind
], FontEmbedder.prototype, "onFontFamilyValue", 1);
async function getDocumentFontFaces(doc) {
  const win = doc.defaultView ?? globalThis;
  const fontFaces = [];
  const styleSheetsWithoutSvgExports = Array.from(doc.styleSheets).filter(
    (styleSheet) => !styleSheet.disabled && (!styleSheet.media.length || win.matchMedia(styleSheet.media.mediaText).matches) && !styleSheet.ownerNode?.closest(`.${SVG_EXPORT_CLASSNAME}`)
  );
  const visitRules = (rules, base) => {
    for (const rule of rules) {
      if (rule instanceof win.CSSFontFaceRule) {
        fontFaces.push((0, import_parseCss.parseCssFontFaces)(rule.cssText, base));
      } else if (rule instanceof win.CSSImportRule) {
        if (rule.media.length && !win.matchMedia(rule.media.mediaText).matches) continue;
        if (rule.supportsText && !win.CSS.supports(rule.supportsText)) continue;
        const url = new URL(rule.href, rule.parentStyleSheet?.href ?? base).href;
        let imported;
        try {
          imported = rule.styleSheet?.cssRules;
        } catch {
        }
        if (imported) visitRules(imported, url);
        else fontFaces.push(fetchCssFontFaces(url));
      } else if ("cssRules" in rule) {
        if (rule instanceof win.CSSMediaRule && !win.matchMedia(rule.conditionText).matches)
          continue;
        if (rule instanceof win.CSSSupportsRule && !win.CSS.supports(rule.conditionText)) continue;
        visitRules(rule.cssRules, base);
      }
    }
  };
  for (const styleSheet of styleSheetsWithoutSvgExports) {
    let cssRules;
    try {
      cssRules = styleSheet.cssRules;
    } catch {
    }
    if (cssRules) {
      visitRules(cssRules, styleSheet.href ?? doc.baseURI);
    } else if (styleSheet.href) {
      fontFaces.push(fetchCssFontFaces(styleSheet.href));
    }
  }
  return (0, import_utils.compact)(await Promise.all(fontFaces)).flat();
}
const fetchCssFontFaces = (0, import_fetchCache.fetchCache)(async (response) => {
  const parsed = (0, import_parseCss.parseCss)(await response.text(), response.url);
  const importedFontFaces = await Promise.all(
    parsed.imports.map(({ url }) => fetchCssFontFaces(new URL(url, response.url).href))
  );
  return [...parsed.fontFaces, ...(0, import_utils.compact)(importedFontFaces).flat()];
});
//# sourceMappingURL=FontEmbedder.js.map
