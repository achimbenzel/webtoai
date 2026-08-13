/**
 * web2ai ExtendScript host -- turning scene nodes into Illustrator art.
 * ES3 ONLY.
 *
 * Z-order
 * -------
 * `children` in a scene is back-to-front: children[0] is painted first and
 * sits behind. Illustrator inserts every new item at the TOP of its container.
 * Adding children in their natural order therefore produces the right result:
 * children[0] is added first and ends up bottom-most, children[n] last and
 * top-most. The node's own background is added before any child, so it lands
 * underneath all of them.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Makes a layer or group name unique and legible in the palette.
 *
 * @param {Object} node
 * @param {Object} used map of names already taken at this level
 * @returns {string}
 */
web2ai.uniqueName = function (node, used) {
  var base = String(node.name || node.role || "node");
  if (base.length > 60) {
    base = base.substring(0, 57) + "...";
  }
  var name = base;
  var counter = 2;
  while (Object.prototype.hasOwnProperty.call(used, name)) {
    name = base + " (" + counter + ")";
    counter += 1;
  }
  used[name] = true;
  return name;
};

/**
 * Creates the container a node's children go into.
 *
 * Layers are what makes the result navigable, but Illustrator slows to a crawl
 * with deeply nested ones -- so past `render.maxLayerDepth` the builder
 * switches to groups, which are cheap. The depth is configurable and the
 * switch is reported once.
 *
 * @param {Object} node
 * @param {Object} parent layer or groupItem
 * @param {Object} ctx render context
 * @param {number} depth 1-based
 * @returns {Object} the container
 */
web2ai.createContainer = function (node, parent, ctx, depth) {
  var name = web2ai.uniqueName(node, ctx.usedNames);

  if (depth <= ctx.maxLayerDepth && parent.layers) {
    var layer = parent.layers.add();
    layer.name = name;
    return layer;
  }

  if (depth === ctx.maxLayerDepth + 1) {
    web2ai.report(
      ctx,
      "info",
      "layer-depth-exceeded",
      node.name,
      "below depth " + ctx.maxLayerDepth + " the builder uses groups, not layers"
    );
  }

  var group = web2ai.groupIn(parent);
  group.name = name;
  return group;
};

/**
 * `layer.groupItems` and `group.groupItems` behave the same; this hides the
 * difference so callers need not care which they have.
 */
web2ai.groupIn = function (container) {
  return container.groupItems.add();
};

/**
 * Draws the node's own box: fill, border and shadow.
 *
 * @param {Object} node
 * @param {Object} container
 * @param {Object} ctx
 * @returns {Object|null} the path item, or null when there was nothing to draw
 */
web2ai.drawBox = function (node, container, ctx) {
  var paint = node.paint || {};
  var hasFill = paint.fill !== undefined && paint.fill !== null;
  var stroke = paint.stroke;
  var hasStroke = stroke !== undefined && stroke !== null && web2ai.anyPositive(stroke.widths);
  var hasShadow = paint.shadows && paint.shadows.length > 0;

  if (!hasFill && !hasStroke && !hasShadow) {
    return null;
  }

  var box = web2ai.frameToArtboard(node.frame, ctx.scale);
  if (box.width <= 0 || box.height <= 0) {
    return null;
  }

  var item = null;

  if (hasFill) {
    item = web2ai.createRect(container, box, node, ctx);
    web2ai.applyFill(item, paint.fill, node, ctx);
    item.stroked = false;
    if (hasShadow) {
      web2ai.applyShadows(item, paint.shadows, node, ctx);
    }
  } else if (hasShadow) {
    // A shadow with no fill still needs something to cast it.
    item = web2ai.createRect(container, box, node, ctx);
    item.filled = false;
    item.stroked = false;
    web2ai.applyShadows(item, paint.shadows, node, ctx);
  }

  // Leaf nodes never get a layer of their own, so the item name is the only
  // thing identifying them in the palette. Worth setting.
  if (item !== null) {
    item.name = node.name;
  }

  if (hasStroke) {
    web2ai.drawBorders(node, container, ctx, box, stroke);
  }

  if (item !== null && paint.blendMode) {
    web2ai.applyBlendMode(item, paint.blendMode, node, ctx);
  }

  return item;
};

/** @param {Array} values @returns {boolean} */
web2ai.anyPositive = function (values) {
  var i;
  for (i = 0; i < values.length; i += 1) {
    if (values[i] > 0) {
      return true;
    }
  }
  return false;
};

/**
 * Creates the rectangle for a node, rounded however its corners require.
 *
 * Illustrator's roundedRectangle takes one horizontal and one vertical radius
 * for all four corners, so mixed corners -- an entirely ordinary CSS shape --
 * are built from Bezier points instead.
 *
 * @returns {PathItem}
 */
web2ai.createRect = function (container, box, node, ctx) {
  var radius = web2ai.clampRadii(
    (node.paint && node.paint.radius) || [0, 0, 0, 0],
    box.width,
    box.height
  );

  if (web2ai.radiiSquare(radius)) {
    return container.pathItems.rectangle(box.top, box.left, box.width, box.height);
  }

  if (web2ai.radiiUniform(radius)) {
    return container.pathItems.roundedRectangle(
      box.top,
      box.left,
      box.width,
      box.height,
      radius[0],
      radius[0]
    );
  }

  var points = web2ai.roundedRectPoints(box, radius);
  var path = container.pathItems.add();
  path.setEntirePath(web2ai.anchorsOf(points));

  // setEntirePath only places anchors; the handles have to be applied after,
  // or every rounded corner comes out as a straight chamfer.
  var i;
  for (i = 0; i < points.length && i < path.pathPoints.length; i += 1) {
    var pathPoint = path.pathPoints[i];
    pathPoint.leftDirection = points[i].leftDirection;
    pathPoint.rightDirection = points[i].rightDirection;
  }
  path.closed = true;
  return path;
};

/** @param {Array} points @returns {Array} anchor pairs */
web2ai.anchorsOf = function (points) {
  var anchors = [];
  var i;
  for (i = 0; i < points.length; i += 1) {
    anchors.push(points[i].anchor);
  }
  return anchors;
};

/**
 * Applies a scene Paint as an item's fill.
 */
web2ai.applyFill = function (item, paint, node, ctx) {
  item.filled = true;

  if (paint.kind === "solid") {
    item.fillColor = web2ai.toRGBColor(paint.color);
    item.opacity = web2ai.effectiveOpacity(paint.color.a, node.paint.opacity);
    return;
  }

  if (paint.kind === "linear-gradient" || paint.kind === "radial-gradient") {
    ctx.gradientCount += 1;
    var gradient = web2ai.createGradient(ctx.doc, paint, "web2ai-" + ctx.gradientCount);
    var color = new GradientColor();
    color.gradient = gradient;
    if (paint.kind === "linear-gradient") {
      color.angle = web2ai.gradientAngle(paint.angle);
    }
    item.fillColor = color;
    item.opacity = web2ai.effectiveOpacity(1, node.paint.opacity);
    return;
  }

  item.filled = false;
};

/**
 * Draws borders.
 *
 * A uniform border is one stroked path. Anything else becomes one filled
 * rectangle per visible side, because Illustrator strokes a path with a single
 * width -- there is no per-side stroke. Mitred corners are lost, and the
 * capture side has already flagged the node for it.
 */
web2ai.drawBorders = function (node, container, ctx, box, stroke) {
  var widths = stroke.widths;
  var uniform =
    widths[0] === widths[1] && widths[1] === widths[2] && widths[2] === widths[3] && widths[0] > 0;

  if (uniform) {
    var outline = web2ai.createRect(container, box, node, ctx);
    outline.filled = false;
    outline.stroked = true;
    outline.strokeWidth = widths[0] * ctx.scale;
    outline.strokeColor = web2ai.toRGBColor(stroke.color);
    outline.opacity = web2ai.effectiveOpacity(stroke.color.a, node.paint.opacity);
    web2ai.applyDashes(outline, stroke.style, ctx, node);
    return;
  }

  var scaled = [
    widths[0] * ctx.scale,
    widths[1] * ctx.scale,
    widths[2] * ctx.scale,
    widths[3] * ctx.scale
  ];
  var strips = web2ai.borderStrips(box, scaled);
  var colors = stroke.colors;
  var sideIndex = { top: 0, right: 1, bottom: 2, left: 3 };
  var i;

  for (i = 0; i < strips.length; i += 1) {
    var strip = strips[i];
    var color = colors ? colors[sideIndex[strip.side]] : stroke.color;
    var rect = container.pathItems.rectangle(strip.top, strip.left, strip.width, strip.height);
    rect.filled = true;
    rect.stroked = false;
    rect.fillColor = web2ai.toRGBColor(color);
    rect.opacity = web2ai.effectiveOpacity(color.a, node.paint.opacity);
    rect.name = "border " + strip.side;
  }

  web2ai.report(
    ctx,
    "warn",
    "border-widths-differ",
    node.name,
    "drawn as " + strips.length + " separate edges; mitred corners are lost"
  );
};

/**
 * Dashed and dotted borders. Illustrator's dash array is in points and has no
 * notion of CSS's "the browser decides"; these are reasonable equivalents and
 * are reported as approximations.
 */
web2ai.applyDashes = function (item, style, ctx, node) {
  if (style === "dashed") {
    item.strokeDashes = [item.strokeWidth * 3, item.strokeWidth * 2];
    web2ai.report(ctx, "warn", "border-style-approximated", node.name, "dashed pattern estimated");
  } else if (style === "dotted") {
    item.strokeDashes = [0, item.strokeWidth * 2];
    item.strokeCap = StrokeCap.ROUNDENDCAP;
    web2ai.report(ctx, "warn", "border-style-approximated", node.name, "dotted pattern estimated");
  } else if (style === "double" || style === "groove" || style === "ridge") {
    web2ai.report(
      ctx,
      "warn",
      "border-style-approximated",
      node.name,
      style + " drawn as a single solid stroke"
    );
  }
};

/**
 * Applies box shadows.
 *
 * Illustrator's Drop Shadow is one effect per object, so only the first shadow
 * can be a live effect. What happens to the rest is a configuration decision
 * (render.multiShadowStrategy) and either way it is reported -- a stack of
 * shadows is a deliberate design choice and silently dropping it would be
 * misleading.
 */
web2ai.applyShadows = function (item, shadows, node, ctx) {
  var first = null;
  var i;

  for (i = 0; i < shadows.length; i += 1) {
    if (!shadows[i].inset) {
      first = shadows[i];
      break;
    }
  }

  var insetCount = 0;
  for (i = 0; i < shadows.length; i += 1) {
    if (shadows[i].inset) {
      insetCount += 1;
    }
  }
  if (insetCount > 0) {
    web2ai.report(
      ctx,
      "unsupported",
      "shadow-inset",
      node.name,
      insetCount + " inset shadow(s); Illustrator's Drop Shadow has no inset mode"
    );
  }

  if (first === null) {
    return;
  }

  try {
    item.applyEffect(web2ai.dropShadowXml(first, ctx.scale));
  } catch (e) {
    web2ai.report(
      ctx,
      "unsupported",
      "shadow-effect-failed",
      node.name,
      e.message ? e.message : String(e)
    );
    return;
  }

  var outer = shadows.length - insetCount;
  if (outer > 1) {
    web2ai.report(
      ctx,
      "unsupported",
      "shadow-multiple",
      node.name,
      outer + " outer shadows; only the first is applied (render.multiShadowStrategy)"
    );
  }
};

/**
 * Applies a CSS blend mode, or reports that Illustrator has no equivalent.
 */
web2ai.applyBlendMode = function (item, cssMode, node, ctx) {
  var key = web2ai.blendModeKey(cssMode);
  if (key === null || key === "NORMAL") {
    if (key === null) {
      web2ai.report(
        ctx,
        "unsupported",
        "blend-mode-unsupported",
        node.name,
        cssMode + " has no Illustrator equivalent; left as normal"
      );
    }
    return;
  }
  try {
    item.blendingMode = BlendModes[key];
  } catch (e) {
    web2ai.report(ctx, "unsupported", "blend-mode-unsupported", node.name, cssMode);
  }
};

/**
 * Draws a text node.
 *
 * Single-line text becomes point text, which keeps its position exactly.
 * Multi-line text becomes area text in a box the size of the DOM element, so
 * it wraps roughly where the browser wrapped it -- roughly, because line
 * breaking depends on the exact font metrics and those will not match once a
 * font has been substituted.
 */
web2ai.drawText = function (node, container, ctx) {
  var text = node.text;
  if (!text || !text.runs || text.runs.length === 0) {
    return null;
  }

  var box = web2ai.frameToArtboard(node.frame, ctx.scale);
  var contents = "";
  var i;
  for (i = 0; i < text.runs.length; i += 1) {
    contents += text.runs[i].chars;
  }
  if (contents.length === 0) {
    return null;
  }

  var frame;
  if (text.isSingleLine) {
    // Point text anchors at the baseline, which sits roughly 80% down the
    // line box. The exact figure needs font metrics the scene does not carry.
    var first = text.runs[0];
    var baseline = box.top - first.lineHeight * ctx.scale * 0.8;
    frame = container.textFrames.pointText([box.left, baseline]);
  } else {
    var area = container.pathItems.rectangle(box.top, box.left, box.width, box.height);
    frame = container.textFrames.areaText(area);
  }

  frame.contents = contents;
  frame.name = node.name;

  if (ctx.textAsOutlines) {
    web2ai.styleRuns(frame, text.runs, node, ctx);
    try {
      return frame.createOutline();
    } catch (e) {
      web2ai.report(
        ctx,
        "warn",
        "text-outline-failed",
        node.name,
        e.message ? e.message : String(e)
      );
      return frame;
    }
  }

  web2ai.styleRuns(frame, text.runs, node, ctx);
  return frame;
};

/**
 * Applies each run's font, size, colour and spacing.
 *
 * One run styles the whole frame at once. Several runs have to be applied per
 * character range, which is markedly slower -- so the common case stays fast
 * and the expensive one is only paid when a paragraph really is mixed.
 */
web2ai.styleRuns = function (frame, runs, node, ctx) {
  if (runs.length === 1) {
    web2ai.applyRunAttributes(frame.textRange, runs[0], node, ctx);
    frame.textRange.paragraphAttributes.justification = web2ai.justificationFor(runs[0].align);
    return;
  }

  var offset = 0;
  var i;
  var j;
  for (i = 0; i < runs.length; i += 1) {
    var run = runs[i];
    var length = run.chars.length;
    for (j = 0; j < length; j += 1) {
      var index = offset + j;
      if (index >= frame.characters.length) {
        break;
      }
      web2ai.applyRunAttributes(frame.characters[index], run, node, ctx);
    }
    offset += length;
  }
  frame.textRange.paragraphAttributes.justification = web2ai.justificationFor(runs[0].align);
};

/**
 * @param {Object} target a TextRange or a character
 * @param {Object} run scene TextRun
 */
web2ai.applyRunAttributes = function (target, run, node, ctx) {
  var attributes = target.characterAttributes;
  var resolved = web2ai.resolveFont(run.font);

  if (resolved.font !== null) {
    attributes.textFont = resolved.font;
  } else {
    web2ai.report(
      ctx,
      "unsupported",
      "font-unavailable",
      node.name,
      "no usable font for " + resolved.requested
    );
  }

  attributes.size = run.size * ctx.scale;
  attributes.fillColor = web2ai.toRGBColor(run.color);
  if (typeof run.letterSpacing === "number" && run.letterSpacing !== 0) {
    // Illustrator tracking is in 1/1000 em.
    attributes.tracking = Math.round((run.letterSpacing / run.size) * 1000);
  }
  if (typeof run.lineHeight === "number" && run.lineHeight > 0) {
    attributes.leading = run.lineHeight * ctx.scale;
    attributes.autoLeading = false;
  }
  if (run.decoration === "underline") {
    attributes.underline = true;
  }
};

/**
 * Places an image asset.
 *
 * @returns {Object|null} the placed item
 */
web2ai.drawImage = function (node, container, ctx) {
  var extracted = ctx.assets[node.assetId];
  if (!extracted || !extracted.ok) {
    web2ai.report(
      ctx,
      "unsupported",
      "asset-unavailable",
      node.name,
      extracted ? extracted.reason : "asset " + node.assetId + " not in the scene"
    );
    return null;
  }

  var box = web2ai.frameToArtboard(node.frame, ctx.scale);
  var placed;
  try {
    placed = container.placedItems.add();
    placed.file = new File(extracted.path);
  } catch (e) {
    web2ai.report(
      ctx,
      "unsupported",
      "asset-place-failed",
      node.name,
      e.message ? e.message : String(e)
    );
    return null;
  }

  // Position first, then size: setting width/height moves the item's anchor.
  placed.width = box.width;
  placed.height = box.height;
  placed.top = box.top;
  placed.left = box.left;
  placed.name = node.name;

  if (node.paint && typeof node.paint.opacity === "number" && node.paint.opacity < 1) {
    placed.opacity = node.paint.opacity * 100;
  }

  if (ctx.embedImages) {
    try {
      placed.embed();
    } catch (e) {
      web2ai.report(
        ctx,
        "warn",
        "asset-embed-failed",
        node.name,
        "left as a link: " + (e.message ? e.message : String(e))
      );
    }
  }

  return placed;
};

/**
 * Turns a container into a clipping group using its own frame as the mask.
 *
 * Illustrator clips with the TOPMOST object in a group, so the mask rectangle
 * is added after every child. Only rectangular clipping is supported, which
 * covers `overflow: hidden` -- the case that actually matters.
 */
web2ai.applyClip = function (node, container, ctx) {
  if (!container.pathItems) {
    return;
  }
  var box = web2ai.frameToArtboard(node.frame, ctx.scale);
  if (box.width <= 0 || box.height <= 0) {
    return;
  }

  try {
    var mask = web2ai.createRect(container, box, node, ctx);
    mask.name = "clip";
    mask.filled = false;
    mask.stroked = false;
    container.clipped = true;
  } catch (e) {
    web2ai.report(ctx, "warn", "clip-failed", node.name, e.message ? e.message : String(e));
  }
};
