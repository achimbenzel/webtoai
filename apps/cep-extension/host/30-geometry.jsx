/**
 * web2ai ExtendScript host -- geometry. ES3 ONLY.
 *
 * Everything in this file is a pure function over numbers, deliberately: it is
 * the part of the renderer that is easiest to get subtly wrong and the only
 * part that can be tested without Illustrator.
 *
 * Coordinates
 * -----------
 * ui-scene@1 is in DOM space: origin top-left of the document, y growing
 * DOWNWARDS. Illustrator's artboard has y growing UPWARDS. The whole
 * conversion is one sign flip, applied here and nowhere else:
 *
 *     x_ai = x_dom
 *     y_ai = -y_dom
 *
 * Illustrator's rectangle(top, left, width, height) takes `top` as the
 * artboard y of the box's upper edge -- which, after the flip, is the negated
 * DOM y. Getting this backwards puts the whole document below the artboard.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Converts a DOM frame to the (top, left, width, height) Illustrator wants.
 *
 * @param {Object} frame {x, y, w, h} in DOM space, CSS px
 * @param {number} scale points per CSS pixel (render.pointsPerCssPixel)
 * @returns {Object} {top, left, width, height} in artboard points
 */
web2ai.frameToArtboard = function (frame, scale) {
  var k = typeof scale === "number" && scale > 0 ? scale : 1;
  return {
    top: -frame.y * k,
    left: frame.x * k,
    width: Math.max(frame.w * k, 0),
    height: Math.max(frame.h * k, 0)
  };
};

/**
 * Clamps corner radii so that no side's pair exceeds its length.
 *
 * The capture side already applies the CSS scaling rule, but a scene can be
 * hand-edited and Illustrator produces self-intersecting garbage rather than
 * complaining, so the invariant is enforced here too.
 *
 * @param {Array} radius [tl, tr, br, bl]
 * @param {number} width
 * @param {number} height
 * @returns {Array} clamped [tl, tr, br, bl]
 */
web2ai.clampRadii = function (radius, width, height) {
  var tl = Math.max(radius[0] || 0, 0);
  var tr = Math.max(radius[1] || 0, 0);
  var br = Math.max(radius[2] || 0, 0);
  var bl = Math.max(radius[3] || 0, 0);

  var scale = 1;
  var pairs = [
    [tl + tr, width],
    [tr + br, height],
    [br + bl, width],
    [bl + tl, height]
  ];
  var i;
  for (i = 0; i < pairs.length; i += 1) {
    var sum = pairs[i][0];
    var limit = pairs[i][1];
    if (sum > 0 && limit > 0 && sum > limit) {
      var factor = limit / sum;
      if (factor < scale) {
        scale = factor;
      }
    }
  }

  return [tl * scale, tr * scale, br * scale, bl * scale];
};

/** True when all four corners are the same value. */
web2ai.radiiUniform = function (radius) {
  return radius[0] === radius[1] && radius[1] === radius[2] && radius[2] === radius[3];
};

/** True when no corner is rounded. */
web2ai.radiiSquare = function (radius) {
  return (
    (radius[0] || 0) === 0 &&
    (radius[1] || 0) === 0 &&
    (radius[2] || 0) === 0 &&
    (radius[3] || 0) === 0
  );
};

/**
 * Circle-to-Bezier constant.
 *
 * A quarter circle of radius r is approximated by a cubic whose control points
 * sit KAPPA * r along the tangents. The error is under 0.02%, which is far
 * below anything visible at screen sizes.
 */
web2ai.KAPPA = 0.5522847498307936;

/**
 * Builds the anchor/handle list for a rectangle with four independent corner
 * radii.
 *
 * Illustrator's roundedRectangle() takes ONE horizontal and ONE vertical
 * radius for all four corners, so anything with mixed corners -- a very
 * ordinary CSS shape -- has to be constructed by hand. Each point is
 * {anchor, leftDirection, rightDirection}, exactly the shape
 * PathPoint wants.
 *
 * Points run clockwise from the top-left corner, in artboard coordinates.
 *
 * @param {Object} box {top, left, width, height} in artboard space
 * @param {Array} radius [tl, tr, br, bl], already clamped
 * @returns {Array} path points
 */
web2ai.roundedRectPoints = function (box, radius) {
  var left = box.left;
  var right = box.left + box.width;
  var top = box.top;
  var bottom = box.top - box.height;

  var tl = radius[0] || 0;
  var tr = radius[1] || 0;
  var br = radius[2] || 0;
  var bl = radius[3] || 0;
  var k = web2ai.KAPPA;

  var points = [];

  function point(x, y, inX, inY, outX, outY) {
    points.push({
      anchor: [x, y],
      leftDirection: [inX, inY],
      rightDirection: [outX, outY]
    });
  }

  // Top edge, left to right.
  if (tl > 0) {
    point(left, top - tl, left, top - tl + tl * k, left, top - tl);
    point(left + tl, top, left + tl - tl * k, top, left + tl, top);
  } else {
    point(left, top, left, top, left, top);
  }

  if (tr > 0) {
    point(right - tr, top, right - tr, top, right - tr + tr * k, top);
    point(right, top - tr, right, top - tr + tr * k, right, top - tr);
  } else {
    point(right, top, right, top, right, top);
  }

  if (br > 0) {
    point(right, bottom + br, right, bottom + br, right, bottom + br - br * k);
    point(right - br, bottom, right - br + br * k, bottom, right - br, bottom);
  } else {
    point(right, bottom, right, bottom, right, bottom);
  }

  if (bl > 0) {
    point(left + bl, bottom, left + bl, bottom, left + bl - bl * k, bottom);
    point(left, bottom + bl, left, bottom + bl - bl * k, left, bottom + bl);
  } else {
    point(left, bottom, left, bottom, left, bottom);
  }

  return points;
};

/**
 * Builds the four edge strips of a border whose sides differ.
 *
 * Illustrator strokes a path with a single width, so a box with, say, a 4px
 * top border and 1px elsewhere cannot be one stroked rectangle. Each visible
 * side becomes its own filled rectangle instead; mitred corners are not
 * reproduced, which is reported rather than hidden.
 *
 * Returns rectangles in artboard coordinates, outer edge aligned with the
 * border box -- CSS borders sit inside it.
 *
 * @param {Object} box {top, left, width, height} artboard space
 * @param {Array} widths [top, right, bottom, left] in points
 * @returns {Array} [{side, top, left, width, height}]
 */
web2ai.borderStrips = function (box, widths) {
  var top = widths[0] || 0;
  var right = widths[1] || 0;
  var bottom = widths[2] || 0;
  var left = widths[3] || 0;
  var strips = [];

  if (top > 0) {
    strips.push({ side: "top", top: box.top, left: box.left, width: box.width, height: top });
  }
  if (bottom > 0) {
    strips.push({
      side: "bottom",
      top: box.top - box.height + bottom,
      left: box.left,
      width: box.width,
      height: bottom
    });
  }
  // Left and right run between the horizontal strips so the corners are not
  // painted twice -- doubled alpha at the corners is very visible.
  var innerTop = box.top - top;
  var innerHeight = Math.max(box.height - top - bottom, 0);
  if (left > 0 && innerHeight > 0) {
    strips.push({
      side: "left",
      top: innerTop,
      left: box.left,
      width: left,
      height: innerHeight
    });
  }
  if (right > 0 && innerHeight > 0) {
    strips.push({
      side: "right",
      top: innerTop,
      left: box.left + box.width - right,
      width: right,
      height: innerHeight
    });
  }

  return strips;
};

/**
 * Converts a CSS gradient angle to Illustrator's.
 *
 * CSS measures clockwise from "to top": 0 points up, 90 points right.
 * Illustrator measures counter-clockwise from "to right": 0 points right,
 * 90 points up. The two meet at ai = 90 - css.
 *
 * @param {number} cssAngle degrees
 * @returns {number} degrees, normalised to (-180, 180]
 */
web2ai.gradientAngle = function (cssAngle) {
  var angle = 90 - cssAngle;
  while (angle <= -180) {
    angle += 360;
  }
  while (angle > 180) {
    angle -= 360;
  }
  return angle;
};

/**
 * Where a shadow lands in artboard space.
 *
 * CSS offsets are x right / y down; Illustrator's Drop Shadow effect takes
 * y up, so the vertical offset flips sign like every other y in the scene.
 *
 * @param {Object} shadow scene shadow
 * @param {number} scale points per CSS pixel
 * @returns {Object} {shiftX, shiftY, blur}
 */
web2ai.shadowOffsets = function (shadow, scale) {
  var k = typeof scale === "number" && scale > 0 ? scale : 1;
  return {
    shiftX: (shadow.offsetX || 0) * k,
    shiftY: -(shadow.offsetY || 0) * k,
    blur: Math.max((shadow.blur || 0) * k, 0)
  };
};
