/**
 * web2ai ExtendScript host -- render orchestration. ES3 ONLY.
 *
 * The render runs in batches rather than as one call, for two reasons that
 * both matter:
 *
 *  - ExtendScript is synchronous and blocks Illustrator completely. A large
 *    page would freeze the application for a minute with no sign of progress.
 *  - There is no way to interrupt a running script. Returning to the panel
 *    between batches is what makes a Cancel button possible at all.
 *
 * So the panel drives the loop: renderBegin, then renderStep until done. Each
 * step reports progress and can be the last one.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/** The in-flight render, or null. */
web2ai._render = null;

/**
 * Counts the nodes in a scene, iteratively.
 *
 * @param {Object} root
 * @returns {number}
 */
web2ai.countNodes = function (root) {
  var count = 0;
  var stack = [root];
  while (stack.length > 0) {
    var node = stack.pop();
    count += 1;
    if (node.children) {
      var i;
      for (i = 0; i < node.children.length; i += 1) {
        stack.push(node.children[i]);
      }
    }
  }
  return count;
};

/**
 * Creates the document and prepares the work queue.
 *
 * A new document every time, deliberately: an import must never overwrite what
 * is already open, and re-importing is how a user iterates.
 *
 * @returns {Object} {total, documentName}
 */
web2ai.renderBegin = function () {
  if (web2ai._scene === null) {
    throw new Error("No scene loaded. Open a .web2ai.json first.");
  }

  var scene = web2ai._scene;
  var config = web2ai.config();
  var scale = config.render.pointsPerCssPixel;

  var width = Math.max(scene.source.document.w * scale, 1);
  var height = Math.max(scene.source.document.h * scale, 1);

  // Illustrator's hard artboard limit. Beyond it the document cannot be
  // created at all, so this is refused up front rather than half-built.
  var LIMIT = 16383;
  if (width > LIMIT || height > LIMIT) {
    throw new Error(
      "The captured page is " +
        Math.round(width) +
        " x " +
        Math.round(height) +
        " pt, beyond Illustrator's " +
        LIMIT +
        " pt artboard limit. " +
        "Capture a narrower viewport, or a subtree via the popup's root selector."
    );
  }

  var previousInteraction = app.userInteractionLevel;
  app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

  var doc = app.documents.add(DocumentColorSpace.RGB, width, height);
  doc.rulerOrigin = [0, height];

  var folder = new Folder(Folder.temp.fsName + "/web2ai/assets");
  if (!folder.exists) {
    folder.create();
  }

  web2ai.resetFontSubstitutions();
  var report = web2ai.createReport();
  report.nodesTotal = web2ai.countNodes(scene.root);

  var ctx = {
    doc: doc,
    scene: scene,
    scale: scale,
    maxLayerDepth: config.render.maxLayerDepth,
    embedImages: config.render.embedPlacedImages,
    textAsOutlines: scene.options ? scene.options.textAsOutlines === true : false,
    assets: web2ai.extractAssets(scene, folder.fsName),
    report: report,
    usedNames: {},
    gradientCount: 0,
    previousInteraction: previousInteraction
  };

  // Illustrator's default layer is empty and in the way.
  var rootContainer = doc.layers[0];
  rootContainer.name = "web2ai";

  web2ai._render = {
    ctx: ctx,
    // Depth-first via an explicit stack: a deep page would exhaust the call
    // stack, and the queue is what lets the work be split into batches.
    stack: [{ kind: "enter", node: scene.root, container: rootContainer, depth: 1 }],
    done: false
  };

  return {
    total: report.nodesTotal,
    documentName: doc.name,
    width: width,
    height: height,
    assetCount: scene.assets.length
  };
};

/**
 * Processes up to `batchSize` queued tasks.
 *
 * A failure in one node is caught and recorded; it must never end the import,
 * because one bad element out of two thousand is not a reason to produce
 * nothing.
 *
 * @param {number} batchSize
 * @returns {Object} {done, built, total, failed}
 */
web2ai.renderStep = function (batchSize) {
  if (web2ai._render === null) {
    throw new Error("No render in progress.");
  }

  var state = web2ai._render;
  var ctx = state.ctx;
  var limit = typeof batchSize === "number" && batchSize > 0 ? batchSize : 50;
  var processed = 0;

  while (processed < limit && state.stack.length > 0) {
    var task = state.stack.pop();
    processed += 1;

    try {
      if (task.kind === "enter") {
        web2ai.renderEnter(task, state, ctx);
      } else {
        web2ai.applyClip(task.node, task.container, ctx);
      }
    } catch (e) {
      ctx.report.nodesFailed += 1;
      web2ai.report(
        ctx,
        "unsupported",
        "node-render-failed",
        task.node.name,
        e.message ? e.message : String(e)
      );
    }
  }

  if (state.stack.length === 0) {
    state.done = true;
  }

  return {
    done: state.done,
    built: ctx.report.nodesBuilt,
    failed: ctx.report.nodesFailed,
    total: ctx.report.nodesTotal
  };
};

/**
 * Builds one node and queues its children.
 */
web2ai.renderEnter = function (task, state, ctx) {
  var node = task.node;
  var container = task.container;
  var i;

  ctx.report.nodesBuilt += 1;

  if (node.role === "unsupported") {
    var reasons = node.unsupportedReasons || [];
    web2ai.report(
      ctx,
      "unsupported",
      reasons.length > 0 ? reasons[0] : "node-unsupported",
      node.name,
      reasons.join(", ")
    );
    return;
  }

  // Anything the capture side flagged is carried into the import report, so
  // the two halves tell one story rather than two.
  if (node.unsupportedReasons) {
    for (i = 0; i < node.unsupportedReasons.length; i += 1) {
      web2ai.report(ctx, "warn", node.unsupportedReasons[i], node.name, "reported by capture");
    }
  }

  var hasChildren = node.children && node.children.length > 0;

  if (node.role === "text") {
    web2ai.drawText(node, container, ctx);
    return;
  }

  if (node.role === "image" || node.role === "svg") {
    web2ai.drawImage(node, container, ctx);
    return;
  }

  if (!hasChildren) {
    web2ai.drawBox(node, container, ctx);
    return;
  }

  // A node with children gets its own container. Its background goes in first
  // so that every child paints over it.
  var childContainer = web2ai.createContainer(node, container, ctx, task.depth);
  web2ai.drawBox(node, childContainer, ctx);

  if (node.assetId) {
    web2ai.drawImage(node, childContainer, ctx);
  }

  // The clip mask must be the topmost item, so it is queued to run after every
  // child has been added.
  if (node.clip) {
    state.stack.push({ kind: "finish", node: node, container: childContainer });
  }

  // Pushed in reverse so they pop in order: children[0] is added first and
  // therefore ends up furthest back, matching the scene's back-to-front order.
  for (i = node.children.length - 1; i >= 0; i -= 1) {
    state.stack.push({
      kind: "enter",
      node: node.children[i],
      container: childContainer,
      depth: task.depth + 1
    });
  }
};

/**
 * Ends the render, successfully or not, and restores Illustrator's state.
 *
 * @param {boolean} cancelled
 * @returns {Object} the report summary
 */
web2ai.renderFinish = function (cancelled) {
  if (web2ai._render === null) {
    throw new Error("No render in progress.");
  }

  var ctx = web2ai._render.ctx;
  ctx.report.finishedAt = new Date().getTime();
  ctx.report.cancelled = cancelled === true;

  try {
    app.userInteractionLevel = ctx.previousInteraction;
  } catch (e) {
    // Restoring the interaction level is best-effort; never worth failing over.
    $.writeln("web2ai: could not restore userInteractionLevel (" + e + ")");
  }

  if (cancelled === true) {
    web2ai.report(
      ctx,
      "info",
      "render-cancelled",
      "",
      "stopped after " + ctx.report.nodesBuilt + " of " + ctx.report.nodesTotal + " nodes"
    );
  }

  web2ai._lastReport = ctx.report;
  web2ai._lastReportScene = ctx.scene;

  var summary = web2ai.reportSummary(ctx.report);
  web2ai._render = null;
  return summary;
};

/** The report of the most recent render, for export after the fact. */
web2ai._lastReport = null;
web2ai._lastReportScene = null;
