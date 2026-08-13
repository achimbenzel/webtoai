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
 * Weight names as they appear in font style names, with their usWeightClass.
 *
 * Ordered longest first, because the matcher takes the first hit and every
 * short name here is a substring of a longer one: "ExtraBold" contains "Bold",
 * "UltraLight" contains "Light". Checking "bold" first would file every
 * ExtraBold face as 700.
 */
web2ai.WEIGHT_NAMES = [
  ["extrablack", 950],
  ["ultrablack", 950],
  ["extralight", 200],
  ["ultralight", 200],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semilight", 350],
  ["demilight", 350],
  ["semibold", 600],
  ["demibold", 600],
  ["hairline", 100],
  ["regular", 400],
  ["medium", 500],
  ["normal", 400],
  ["light", 300],
  ["black", 900],
  ["heavy", 900],
  ["roman", 400],
  ["book", 400],
  ["bold", 700],
  ["demi", 600],
  ["semi", 600],
  ["thin", 100],
  ["ultra", 900]
];

/** Width keywords; a page that did not ask for one should not be given one. */
web2ai.WIDTH_NAMES = ["condensed", "narrow", "compressed", "expanded", "extended", "wide"];

/**
 * The numeric weight an Illustrator style name implies.
 *
 * Pure function over a string -- the part of font matching that is worth
 * testing, and the part that was wrong: the previous matcher only asked
 * "does the name contain 'bold'", which collapsed Thin, Light, Regular,
 * Medium and SemiBold into a single bucket and then picked whichever of them
 * Illustrator happened to enumerate first.
 *
 * @param {string} styleName e.g. "SemiBold Italic", "Light", ""
 * @returns {number} 100-950; 400 when the name says nothing about weight
 */
web2ai.weightOfStyleName = function (styleName) {
  var name = String(styleName || "").toLowerCase();
  var i;
  for (i = 0; i < web2ai.WEIGHT_NAMES.length; i += 1) {
    // es3-ok: String.indexOf
    if (name.indexOf(web2ai.WEIGHT_NAMES[i][0]) !== -1) {
      return web2ai.WEIGHT_NAMES[i][1];
    }
  }
  return 400;
};

/** @param {string} styleName @returns {boolean} */
web2ai.isItalicStyleName = function (styleName) {
  var name = String(styleName || "").toLowerCase();
  return name.indexOf("italic") !== -1 || name.indexOf("oblique") !== -1; // es3-ok: String.indexOf
};

/** @param {string} styleName @returns {boolean} */
web2ai.hasWidthKeyword = function (styleName) {
  var name = String(styleName || "").toLowerCase();
  var i;
  for (i = 0; i < web2ai.WIDTH_NAMES.length; i += 1) {
    // es3-ok: String.indexOf
    if (name.indexOf(web2ai.WIDTH_NAMES[i]) !== -1) {
      return true;
    }
  }
  return false;
};

/**
 * How well an installed face answers a request. Lower is better.
 *
 * Slant dominates: an upright face at the wrong weight is a far better stand-in
 * for italic text than an italic face at the right one is for upright text --
 * the reader sees slant immediately and a 100-unit weight step barely at all.
 *
 * Within the same slant, faces are ranked by weight distance, breaking ties
 * towards the heavier face. That one-unit nudge reproduces the CSS font
 * matching rule without special-casing it: a request for 450 lands on Medium
 * rather than Regular (the 400-500 band searches upwards first), while 500
 * against a family of only Regular and Bold still lands on Regular, because
 * 100 apart beats 200 apart.
 *
 * @param {string} styleName the installed face's style name
 * @param {number} weight requested numeric weight
 * @param {boolean} italic requested slant
 * @returns {number} distance, 0 for a perfect match
 */
web2ai.fontStyleDistance = function (styleName, weight, italic) {
  var faceWeight = web2ai.weightOfStyleName(styleName);
  var faceItalic = web2ai.isItalicStyleName(styleName);

  var distance = Math.abs(faceWeight - weight);
  if (faceItalic !== italic) {
    // Larger than the widest possible weight gap (950 - 100), so no weight
    // match can ever outrank the correct slant.
    distance += 1000;
  }
  if (faceWeight < weight) {
    distance += 1;
  }
  if (web2ai.hasWidthKeyword(styleName)) {
    distance += 2000;
  }
  return distance;
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
  var wanted = web2ai.normaliseFamily(family);
  if (wanted.length === 0) {
    return null;
  }

  var parts = String(key).split("|");
  var weight = Number(parts[0]);
  if (!isFinite(weight)) {
    weight = 400;
  }
  var italic = parts[1] === "italic";

  var best = null;
  var bestDistance = -1;
  var i;

  for (i = 0; i < app.textFonts.length; i += 1) {
    var font = app.textFonts[i];
    if (web2ai.normaliseFamily(font.family) !== wanted) {
      continue;
    }

    var distance = web2ai.fontStyleDistance(font.style, weight, italic);
    if (bestDistance === -1 || distance < bestDistance) {
      bestDistance = distance;
      best = font;
    }
  }

  return best;
};

/**
 * Family names for comparison.
 *
 * CSS says family names are matched case-insensitively and that runs of
 * whitespace are equivalent; Illustrator reports "Helvetica Neue" where a page
 * may say "HelveticaNeue" or "Helvetica  Neue". Dropping spaces and case
 * removes the difference without letting unrelated families collide.
 *
 * @param {string} family
 * @returns {string}
 */
web2ai.normaliseFamily = function (family) {
  return String(family || "")
    .toLowerCase()
    .replace(/^['"]|['"]$/g, "")
    .replace(/[\s_]+/g, "");
};

/**
 * The CSS font-family list, first entry first.
 *
 * The scene records both the resolved first family and the whole declared
 * stack. Walking the stack is what the browser did to pick the face the user
 * actually saw, so a page whose first family is a web font that is not
 * installed here should land on the same second choice the browser would have
 * -- not on the global fallback.
 *
 * @param {Object} font scene FontRef
 * @returns {Array} family names, deduplicated, without quotes
 */
web2ai.familyStack = function (font) {
  var out = [];
  var seen = {};
  var raw = [String(font.family || "")];

  if (font.stack) {
    var parts = String(font.stack).split(",");
    var j;
    for (j = 0; j < parts.length; j += 1) {
      raw.push(parts[j]);
    }
  }

  var i;
  for (i = 0; i < raw.length; i += 1) {
    var name = web2ai.trimFamily(raw[i]);
    if (name.length === 0) {
      continue;
    }
    var key = web2ai.normaliseFamily(name);
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      continue;
    }
    seen[key] = true;
    out.push(name);
  }

  return out;
};

/** Strips surrounding whitespace and CSS quotes from one family name. */
web2ai.trimFamily = function (name) {
  return String(name || "")
    .replace(/^[\s'"]+/, "")
    .replace(/[\s'"]+$/, "");
};

/**
 * Finds an installed font for one family name.
 *
 * @returns {Object|null} {font, used, reason}
 */
web2ai.resolveFamily = function (family, key) {
  var map = web2ai.fontMap();
  var lower = String(family).toLowerCase();

  // 1. Explicit mapping, which is per weight and slant.
  var families = map.families || {};
  if (Object.prototype.hasOwnProperty.call(families, lower)) {
    var entry = families[lower];
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      var mapped = web2ai.findInstalledFont(entry[key]);
      if (mapped !== null) {
        return { font: mapped, used: entry[key], reason: "font-map" };
      }
    }
  }

  // 2. Generic family (sans-serif, monospace, ...).
  var generics = map.genericFamilies || {};
  if (Object.prototype.hasOwnProperty.call(generics, lower)) {
    var generic = web2ai.findInstalledFont(generics[lower]);
    if (generic !== null) {
      return { font: generic, used: generics[lower], reason: "generic-family" };
    }
  }

  // 3. The family is installed under its own name.
  var byFamily = web2ai.findFontByFamily(family, key);
  if (byFamily !== null) {
    return { font: byFamily, used: String(byFamily.name), reason: "family-match" };
  }

  return null;
};

/**
 * Resolves a scene font to an installed Illustrator font.
 *
 * For each family in the CSS stack, in order: the explicit map, the
 * generic-family map, then a search by family name. Failing the whole stack,
 * the configured fallback. Anything but an exact hit on the first family is
 * recorded as a substitution -- nothing here substitutes silently.
 *
 * @param {Object} font scene FontRef
 * @returns {Object} {font: textFont|null, requested: string, used: string, substituted: boolean}
 */
web2ai.resolveFont = function (font) {
  var key = web2ai.fontKey(font);
  var stack = web2ai.familyStack(font);
  var requested = String(font.family || "") + " " + key;

  var i;
  for (i = 0; i < stack.length; i += 1) {
    var hit = web2ai.resolveFamily(stack[i], key);
    if (hit === null) {
      continue;
    }

    // The first family found under its own name is what the page asked for.
    // Everything else -- a mapped name, a generic, a later entry in the stack
    // -- is a stand-in and is reported as one.
    var exact =
      i === 0 && (hit.reason === "font-map" || (hit.reason === "family-match" && !font.isWebFont));
    if (!exact) {
      web2ai.recordFontSubstitution(requested, hit.used, i === 0 ? hit.reason : "family-stack");
    }
    return { font: hit.font, requested: requested, used: hit.used, substituted: !exact };
  }

  // Nothing in the stack is installed. Say so.
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
