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
 * Milestone 0 handshake. Proves the host bundle parsed (i.e. it is valid ES3),
 * json2.js is present, and the config files were copied into the extension.
 *
 * @returns {string} JSON envelope
 */
web2ai.hello = function () {
  return web2ai.safeCall(function () {
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
      extensionRoot: web2ai.extensionRoot(),
      jsonAvailable: typeof JSON !== "undefined" && typeof JSON.stringify === "function",
      configLoaded: config !== null,
      configError: configError,
      renderMaxLayerDepth: config ? config.render.maxLayerDepth : -1
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
