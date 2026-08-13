/**
 * web2ai ExtendScript host -- font resolution. ES3 ONLY.
 *
 * Fonts are the one thing a renderer cannot fake. web2ai does not install
 * anything: if the page used a web font that is not on this machine, some
 * substitution happens, and the only honest response is to say exactly which
 * font was wanted and which one was used. Nothing here substitutes silently.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/** Substitutions made during the current render, for the report. */
web2ai._fontSubstitutions = [];

web2ai.resetFontSubstitutions = function () {
  web2ai._fontSubstitutions = [];
};

web2ai.fontSubstitutions = function () {
  return web2ai._fontSubstitutions;
};

/**
 * The key a font-map entry is stored under: "400|normal".
 *
 * @param {Object} font scene FontRef
 * @returns {string}
 */
web2ai.fontKey = function (font) {
  var weight = Number(font.weight);
  if (!isFinite(weight)) {
    weight = 400;
  }
  var style = String(font.style || "normal");
  if (style !== "italic" && style !== "oblique") {
    style = "normal";
  }
  // Oblique and italic map to the same Illustrator faces in practice.
  if (style === "oblique") {
    style = "italic";
  }
  return String(Math.round(weight)) + "|" + style;
};

/**
 * Looks a font name up in Illustrator's installed set.
 *
 * @param {string} name
 * @returns {Object|null} the textFont, or null when it is not installed
 */
web2ai.findInstalledFont = function (name) {
  if (!name) {
    return null;
  }
  try {
    return app.textFonts.getByName(name);
  } catch (notFound) {
    return null;
  }
};

/**
 * Searches installed fonts whose family matches, preferring a matching style.
 *
 * This is the step between the explicit map and giving up: a page asking for
 * "Inter" on a machine that has Inter installed should get Inter, even when
 * config/font-map.json has never heard of it.
 *
 * @param {string} family
 * @param {string} key "700|italic"
 * @returns {Object|null}
 */
web2ai.findFontByFamily = function (family, key) {
  var wanted = String(family || "").toLowerCase();
  if (wanted.length === 0) {
    return null;
  }

  var isBold = key.indexOf("|") !== -1 && Number(key.split("|")[0]) >= 600; // es3-ok: String.indexOf
  var isItalic = key.indexOf("italic") !== -1; // es3-ok: String.indexOf

  var best = null;
  var bestScore = -1;
  var i;

  for (i = 0; i < app.textFonts.length; i += 1) {
    var font = app.textFonts[i];
    var fontFamily = String(font.family || "").toLowerCase();
    if (fontFamily !== wanted) {
      continue;
    }

    var styleName = String(font.style || "").toLowerCase();
    var styleBold = styleName.indexOf("bold") !== -1; // es3-ok: String.indexOf
    var styleItalic = styleName.indexOf("italic") !== -1 || styleName.indexOf("oblique") !== -1; // es3-ok: String.indexOf

    // Prefer the face whose weight and slant both match; a family hit with the
    // wrong face still beats no hit at all.
    var score = 1;
    if (styleBold === isBold) {
      score += 2;
    }
    if (styleItalic === isItalic) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = font;
    }
  }

  return best;
};

/**
 * Resolves a scene font to an installed Illustrator font.
 *
 * Order: the explicit map, then the generic-family map, then a search by
 * family name, then the configured fallback. Every step past the first is
 * recorded as a substitution.
 *
 * @param {Object} font scene FontRef
 * @returns {Object} {font: textFont|null, requested: string, used: string, substituted: boolean}
 */
web2ai.resolveFont = function (font) {
  var map = web2ai.fontMap();
  var key = web2ai.fontKey(font);
  var family = String(font.family || "");
  var lower = family.toLowerCase();
  var requested = family + " " + key;

  // 1. Explicit mapping.
  var families = map.families || {};
  if (Object.prototype.hasOwnProperty.call(families, lower)) {
    var entry = families[lower];
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      var mapped = web2ai.findInstalledFont(entry[key]);
      if (mapped !== null) {
        return { font: mapped, requested: requested, used: entry[key], substituted: false };
      }
    }
  }

  // 2. Generic family (sans-serif, monospace, ...).
  var generics = map.genericFamilies || {};
  if (Object.prototype.hasOwnProperty.call(generics, lower)) {
    var generic = web2ai.findInstalledFont(generics[lower]);
    if (generic !== null) {
      web2ai.recordFontSubstitution(requested, generics[lower], "generic-family");
      return { font: generic, requested: requested, used: generics[lower], substituted: true };
    }
  }

  // 3. The family is installed under its own name.
  var byFamily = web2ai.findFontByFamily(family, key);
  if (byFamily !== null) {
    var exact = String(byFamily.name);
    var isExact = !font.isWebFont;
    if (!isExact) {
      web2ai.recordFontSubstitution(requested, exact, "family-match");
    }
    return { font: byFamily, requested: requested, used: exact, substituted: !isExact };
  }

  // 4. Give up and say so.
  var config = web2ai.config();
  var fallbackName = config.render.defaultFontFallback;
  var fallback = web2ai.findInstalledFont(fallbackName);
  web2ai.recordFontSubstitution(requested, fallback === null ? "(none)" : fallbackName, "fallback");

  return {
    font: fallback,
    requested: requested,
    used: fallback === null ? "" : fallbackName,
    substituted: true
  };
};

/**
 * @param {string} requested
 * @param {string} used
 * @param {string} reason
 */
web2ai.recordFontSubstitution = function (requested, used, reason) {
  var i;
  for (i = 0; i < web2ai._fontSubstitutions.length; i += 1) {
    var existing = web2ai._fontSubstitutions[i];
    if (existing.requested === requested && existing.used === used) {
      existing.count += 1;
      return;
    }
  }
  web2ai._fontSubstitutions.push({
    requested: requested,
    used: used,
    reason: reason,
    count: 1
  });
};

/**
 * Maps a scene text alignment to Illustrator's Justification.
 *
 * @param {string} align
 * @returns {Justification}
 */
web2ai.justificationFor = function (align) {
  switch (String(align || "start")) {
    case "right":
    case "end":
      return Justification.RIGHT;
    case "center":
      return Justification.CENTER;
    case "justify":
      return Justification.FULLJUSTIFY;
    default:
      return Justification.LEFT;
  }
};
