/**
 * web2ai ExtendScript host -- colour, gradients and effects. ES3 ONLY.
 *
 * The functions that only compute values are separated from the ones that
 * touch the Illustrator object model, so the arithmetic can be tested without
 * Illustrator and the rest can be exercised against a fake document.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Scene RGBA to an Illustrator RGBColor.
 *
 * Alpha does not survive: Illustrator has no per-colour alpha, only per-object
 * opacity. The caller is responsible for pushing `color.a` into the item's
 * opacity, and for noting it when that is lossy.
 *
 * @param {Object} rgba {r, g, b, a}
 * @returns {RGBColor}
 */
web2ai.toRGBColor = function (rgba) {
  var color = new RGBColor();
  color.red = web2ai.clamp255(rgba.r);
  color.green = web2ai.clamp255(rgba.g);
  color.blue = web2ai.clamp255(rgba.b);
  return color;
};

/**
 * @param {number} value
 * @returns {number} value clamped to 0..255
 */
web2ai.clamp255 = function (value) {
  var n = Number(value);
  if (!isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 255) {
    return 255;
  }
  return n;
};

/**
 * Combines a paint's alpha with the node's own opacity.
 *
 * A semi-transparent fill and a semi-transparent element multiply in CSS, and
 * since Illustrator can only express the product as object opacity, that is
 * what gets computed here.
 *
 * @param {number} colorAlpha 0..1
 * @param {number} nodeOpacity 0..1
 * @returns {number} 0..100, Illustrator's scale
 */
web2ai.effectiveOpacity = function (colorAlpha, nodeOpacity) {
  var a = typeof colorAlpha === "number" ? colorAlpha : 1;
  var o = typeof nodeOpacity === "number" ? nodeOpacity : 1;
  var combined = a * o;
  if (combined < 0) {
    combined = 0;
  }
  if (combined > 1) {
    combined = 1;
  }
  return combined * 100;
};

/**
 * Normalises gradient stops for Illustrator.
 *
 * Illustrator requires at least two stops, ramp points in 0..100 strictly
 * ascending, and a midpoint per stop. CSS allows coincident stops (a hard
 * colour break); those are nudged apart by the smallest step Illustrator
 * accepts, because equal ramp points make it reject the gradient outright.
 *
 * @param {Array} stops scene stops [{color, offset}]
 * @returns {Array} [{color, rampPoint, midPoint}]
 */
web2ai.normaliseGradientStops = function (stops) {
  var out = [];
  var i;
  var previous = -1;

  for (i = 0; i < stops.length; i += 1) {
    var offset = Number(stops[i].offset);
    if (!isFinite(offset)) {
      offset = 0;
    }
    var ramp = offset * 100;
    if (ramp < 0) {
      ramp = 0;
    }
    if (ramp > 100) {
      ramp = 100;
    }
    // Strictly ascending: a hard colour break becomes a very narrow ramp.
    if (ramp <= previous) {
      ramp = previous + 0.01;
    }
    if (ramp > 100) {
      ramp = 100;
    }
    previous = ramp;

    out.push({ color: stops[i].color, rampPoint: ramp, midPoint: 50 });
  }

  // A one-stop gradient is not a gradient; duplicate rather than fail.
  if (out.length === 1) {
    out.push({ color: out[0].color, rampPoint: 100, midPoint: 50 });
  }

  return out;
};

/**
 * Builds an Illustrator gradient from a scene paint.
 *
 * @param {Object} doc the document
 * @param {Object} paint scene Paint of kind linear-gradient or radial-gradient
 * @param {string} name gradient name (must be unique in the document)
 * @returns {Gradient}
 */
web2ai.createGradient = function (doc, paint, name) {
  var gradient = doc.gradients.add();
  gradient.name = name;
  gradient.type = paint.kind === "radial-gradient" ? GradientType.RADIAL : GradientType.LINEAR;

  var stops = web2ai.normaliseGradientStops(paint.stops);
  var i;

  // Illustrator gradients start with two stops that cannot be removed, so the
  // first two are overwritten and any further ones appended.
  for (i = 0; i < stops.length; i += 1) {
    var stop;
    if (i < gradient.gradientStops.length) {
      stop = gradient.gradientStops[i];
    } else {
      stop = gradient.gradientStops.add();
    }
    stop.color = web2ai.toRGBColor(stops[i].color);
    stop.rampPoint = stops[i].rampPoint;
    stop.midPoint = stops[i].midPoint;
  }

  return gradient;
};

/**
 * The Adobe live-effect XML for a drop shadow.
 *
 * The Dict grammar is Illustrator's own and is not documented publicly; this
 * follows the shape that applyEffect() accepts for "Adobe Drop Shadow".
 * Keys: R = real, I = integer, B = boolean, C = colour.
 *
 * NOTE: this has not been verified against a running Illustrator. If shadows
 * come out wrong, this string is the first thing to check --
 * docs/LIMITATIONS.md records it as unverified.
 *
 * @param {Object} shadow scene shadow
 * @param {number} scale points per CSS pixel
 * @returns {string} XML for applyEffect
 */
web2ai.dropShadowXml = function (shadow, scale) {
  var offsets = web2ai.shadowOffsets(shadow, scale);
  var opacity = typeof shadow.color.a === "number" ? shadow.color.a : 1;
  var r = web2ai.clamp255(shadow.color.r) / 255;
  var g = web2ai.clamp255(shadow.color.g) / 255;
  var b = web2ai.clamp255(shadow.color.b) / 255;

  return (
    '<LiveEffect name="Adobe Drop Shadow"><Dict data="' +
    "R opac " +
    web2ai.round3(opacity) +
    " R blur " +
    web2ai.round3(offsets.blur) +
    " R shiftX " +
    web2ai.round3(offsets.shiftX) +
    " R shiftY " +
    web2ai.round3(offsets.shiftY) +
    " R dark 0 I mode 1 B useColor 1 C color " +
    web2ai.round3(r) +
    " " +
    web2ai.round3(g) +
    " " +
    web2ai.round3(b) +
    ' "/></LiveEffect>'
  );
};

/**
 * ES3 has no Number.prototype.toFixed rounding we can rely on for output
 * shape, so this keeps effect XML stable and readable.
 *
 * @param {number} value
 * @returns {number}
 */
web2ai.round3 = function (value) {
  var n = Number(value);
  if (!isFinite(n)) {
    return 0;
  }
  return Math.round(n * 1000) / 1000;
};

/**
 * Maps a CSS blend mode to Illustrator's BlendModes.
 *
 * Illustrator has no equivalent for several CSS modes; those return null and
 * the caller reports the node as degraded rather than picking something that
 * merely looks plausible.
 *
 * @param {string} cssMode
 * @returns {string|null} a BlendModes key, or null when unsupported
 */
web2ai.blendModeKey = function (cssMode) {
  var map = {
    normal: "NORMAL",
    multiply: "MULTIPLY",
    screen: "SCREEN",
    overlay: "OVERLAY",
    darken: "DARKEN",
    lighten: "LIGHTEN",
    "color-dodge": "COLORDODGE",
    "color-burn": "COLORBURN",
    "hard-light": "HARDLIGHT",
    "soft-light": "SOFTLIGHT",
    difference: "DIFFERENCE",
    exclusion: "EXCLUSION",
    hue: "HUE",
    saturation: "SATURATIONBLEND",
    color: "COLORBLEND",
    luminosity: "LUMINOSITY"
  };
  var key = String(cssMode || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
};
