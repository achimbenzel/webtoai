/**
 * web2ai ExtendScript host -- loading and inspecting a ui-scene@1 file.
 * ES3 ONLY.
 *
 * The scene is read here rather than in the panel on purpose. The panel has no
 * filesystem access without Node, and the architecture forbids passing payloads
 * through evalScript anyway -- so the host opens the file itself and keeps it,
 * ready for the renderer in milestone 3.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/** The most recently loaded scene, kept for the renderer. */
web2ai._scene = null;
web2ai._scenePath = "";

/**
 * Structural check of a parsed scene.
 *
 * Deliberately shallow: the Chrome side validates against the full zod schema
 * before it ever writes the file, so this only has to catch a wrong or
 * corrupted file, not a subtly malformed one.
 *
 * @param {Object} scene
 * @returns {Array} list of problem strings; empty when the scene looks sound
 */
web2ai.checkScene = function (scene) {
  var problems = [];

  if (!scene || typeof scene !== "object") {
    return ["The file does not contain a JSON object."];
  }
  if (scene.version !== web2ai.SCHEMA_VERSION) {
    problems.push(
      "Unsupported schema version: expected " + web2ai.SCHEMA_VERSION + ", found " + scene.version
    );
  }
  if (!scene.source || typeof scene.source !== "object") {
    problems.push("Missing 'source'.");
  }
  if (!scene.root || typeof scene.root !== "object") {
    problems.push("Missing 'root' node.");
  }
  if (!scene.assets || typeof scene.assets.length !== "number") {
    problems.push("Missing 'assets' array.");
  }
  if (!scene.fonts || typeof scene.fonts.length !== "number") {
    problems.push("Missing 'fonts' array.");
  }

  return problems;
};

/**
 * Walks a scene and counts what it contains.
 *
 * Iterative rather than recursive: a deep DOM produces a deep scene, and
 * ExtendScript's call stack is not generous.
 *
 * @param {Object} root
 * @returns {Object}
 */
web2ai.sceneStats = function (root) {
  var nodeCount = 0;
  var maxDepth = 0;
  var textCount = 0;
  var imageCount = 0;
  var degraded = 0;
  var reasons = {};

  var stack = [{ node: root, depth: 1 }];
  var i;

  while (stack.length > 0) {
    var entry = stack.pop();
    var node = entry.node;
    nodeCount += 1;
    if (entry.depth > maxDepth) {
      maxDepth = entry.depth;
    }

    if (node.role === "text") {
      textCount += 1;
    }
    if (node.role === "image" || node.role === "svg") {
      imageCount += 1;
    }
    if (node.unsupportedReasons && node.unsupportedReasons.length > 0) {
      degraded += 1;
      for (i = 0; i < node.unsupportedReasons.length; i += 1) {
        var code = node.unsupportedReasons[i];
        reasons[code] = (reasons[code] || 0) + 1;
      }
    }

    if (node.children) {
      for (i = 0; i < node.children.length; i += 1) {
        stack.push({ node: node.children[i], depth: entry.depth + 1 });
      }
    }
  }

  // ES3 has no Object.keys, so the reason table is flattened by hand. The
  // hasOwnProperty call goes through Object.prototype: a reason code is a
  // string from the scene file, and one of them could be named "hasOwnProperty".
  var owns = Object.prototype.hasOwnProperty;
  var reasonList = [];
  for (var key in reasons) {
    if (owns.call(reasons, key)) {
      reasonList.push({ code: key, count: reasons[key] });
    }
  }
  reasonList.sort(function (a, b) {
    return b.count - a.count;
  });

  return {
    nodeCount: nodeCount,
    maxDepth: maxDepth,
    textCount: textCount,
    imageCount: imageCount,
    degraded: degraded,
    reasons: reasonList
  };
};

/**
 * Reads a scene file from disk and remembers it.
 *
 * @param {string} path Absolute path to a .web2ai.json file.
 * @returns {Object} summary of what was loaded
 */
web2ai.loadSceneFile = function (path) {
  var scene = web2ai.readJsonFile(path);

  var problems = web2ai.checkScene(scene);
  if (problems.length > 0) {
    throw new Error("Not a usable ui-scene file:\n" + problems.join("\n"));
  }

  web2ai._scene = scene;
  web2ai._scenePath = path;

  var stats = web2ai.sceneStats(scene.root);
  return {
    path: path,
    url: scene.source.url,
    title: scene.source.title,
    capturedAt: scene.source.capturedAt,
    documentWidth: scene.source.document ? scene.source.document.w : 0,
    documentHeight: scene.source.document ? scene.source.document.h : 0,
    assetCount: scene.assets.length,
    fontCount: scene.fonts.length,
    nodeCount: stats.nodeCount,
    maxDepth: stats.maxDepth,
    textCount: stats.textCount,
    imageCount: stats.imageCount,
    degraded: stats.degraded,
    reasons: stats.reasons
  };
};
