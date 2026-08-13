/**
 * web2ai ExtendScript host -- the functions the panel calls via evalScript.
 * ES3 ONLY.
 *
 * Every entry point returns the JSON envelope produced by web2ai.safeCall, so
 * the panel can always tell a host error from a host result.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Handshake, and the point at which the host learns where it lives.
 *
 * The extension root has to come from the panel: a script loaded through the
 * manifest's ScriptPath cannot work it out from $.fileName, which reports the
 * host application instead. See host/10-io.jsx.
 *
 * @param {string} extensionRoot Absolute path of the folder containing CSXS/.
 * @returns {string} JSON envelope
 */
web2ai.hello = function (extensionRoot) {
  return web2ai.safeCall(function () {
    web2ai.setExtensionRoot(extensionRoot);

    var config = null;
    var configError = "";
    try {
      config = web2ai.config();
    } catch (e) {
      configError = String(e.message ? e.message : e);
    }

    return {
      host: "web2ai",
      version: web2ai.VERSION,
      schemaVersion: web2ai.SCHEMA_VERSION,
      app: app.name,
      appVersion: app.version,
      locale: $.locale,
      engine: $.engineName,
      extensionRoot: web2ai._extensionRoot,
      jsonAvailable: typeof JSON !== "undefined" && typeof JSON.stringify === "function",
      configLoaded: config !== null,
      configError: configError,
      renderMaxLayerDepth: config ? config.render.maxLayerDepth : -1,
      sceneLoaded: web2ai._scene !== null,
      scenePath: web2ai._scenePath
    };
  });
};

/**
 * Returns the folder web2ai uses for scene + asset hand-off, creating it if
 * needed. The Node transport writes here; the host reads from here.
 *
 * @returns {string} JSON envelope with the folder path
 */
web2ai.tempFolder = function () {
  return web2ai.safeCall(function () {
    var folder = new Folder(Folder.temp.fsName + "/web2ai");
    if (!folder.exists) {
      folder.create();
    }
    return folder.fsName;
  });
};

/**
 * Opens a file dialog and loads the chosen scene.
 *
 * The dialog lives on this side because the panel has no filesystem access
 * without Node, and because a scene must never travel through evalScript.
 *
 * @returns {string} JSON envelope; {cancelled:true} when the user backed out
 */
web2ai.openScene = function () {
  return web2ai.safeCall(function () {
    var file = web2ai.chooseSceneFile();
    if (file === null) {
      return { cancelled: true };
    }

    var summary = web2ai.loadSceneFile(file.fsName);
    summary.cancelled = false;
    return summary;
  });
};

/**
 * Opens a file dialog for a scene.
 *
 * The filter argument of File.openDialog is platform specific -- Windows takes
 * a "Label:*.ext" string, macOS ignores a string entirely and wants a callback
 * -- and a filter the platform dislikes can make the dialog fail rather than
 * merely show too much. So the filtered call is attempted and the unfiltered
 * one is the fallback: showing every file beats showing no dialog.
 *
 * @returns {File|null} null when the user cancelled
 */
web2ai.chooseSceneFile = function () {
  var prompt = "Select a web2ai scene (.web2ai.json)";

  // es3-ok: String.prototype.indexOf, which ES3 does have.
  if ($.os && String($.os).indexOf("Windows") !== -1) {
    try {
      return File.openDialog(prompt, "web2ai scene:*.json,All files:*.*", false);
    } catch (dialogError) {
      // Fall through to the plain dialog below.
      $.writeln("web2ai: filtered file dialog failed, falling back (" + dialogError + ")");
    }
  }

  return File.openDialog(prompt);
};

/**
 * Loads a scene from a known path, without a dialog. This is the entry point
 * the transport server will use once it lands.
 *
 * @param {string} path
 * @returns {string} JSON envelope
 */
web2ai.loadScene = function (path) {
  return web2ai.safeCall(function () {
    var summary = web2ai.loadSceneFile(path);
    summary.cancelled = false;
    return summary;
  });
};

/**
 * Starts a render: creates the document and queues the work.
 *
 * The panel then calls renderStep repeatedly. Splitting it this way is what
 * lets the panel show progress and offer a Cancel button -- a single blocking
 * call could do neither.
 *
 * @returns {string} JSON envelope with {total, documentName, width, height}
 */
web2ai.startRender = function () {
  return web2ai.safeCall(function () {
    return web2ai.renderBegin();
  });
};

/**
 * Renders the next batch.
 *
 * @param {number} batchSize
 * @returns {string} JSON envelope with {done, built, failed, total}
 */
web2ai.stepRender = function (batchSize) {
  return web2ai.safeCall(function () {
    return web2ai.renderStep(batchSize);
  });
};

/**
 * Ends the render and returns the report.
 *
 * @param {boolean} cancelled
 * @returns {string} JSON envelope with the report summary
 */
web2ai.finishRender = function (cancelled) {
  return web2ai.safeCall(function () {
    return web2ai.renderFinish(cancelled === true);
  });
};

/**
 * Writes the last render's report as Markdown next to the scene file.
 *
 * @returns {string} JSON envelope with the path written
 */
web2ai.exportReport = function () {
  return web2ai.safeCall(function () {
    if (web2ai._lastReport === null) {
      throw new Error("No import has run yet, so there is no report to export.");
    }

    var markdown = web2ai.reportMarkdown(web2ai._lastReport, web2ai._lastReportScene);
    var suggested = web2ai._scenePath
      ? String(web2ai._scenePath).replace(/\.json$/i, "") + "-report.md"
      : Folder.desktop.fsName + "/web2ai-report.md";

    var file = File(suggested).saveDlg("Save the import report");
    if (file === null) {
      return { cancelled: true, path: "" };
    }

    return { cancelled: false, path: web2ai.writeTextFile(file.fsName, markdown) };
  });
};
