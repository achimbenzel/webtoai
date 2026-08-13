/**
 * web2ai ExtendScript host -- file IO and config loading. ES3 ONLY.
 *
 * Large payloads never travel through evalScript: the panel writes the scene
 * to a temp file and passes only the path. Everything in this file exists to
 * make that path work.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Reads a UTF-8 file completely.
 *
 * @param {string} path Absolute filesystem path.
 * @returns {string}
 */
web2ai.readTextFile = function (path) {
  var file = new File(path);
  var content;
  if (!file.exists) {
    throw new Error("File not found: " + path);
  }
  file.encoding = "UTF-8";
  if (!file.open("r")) {
    throw new Error("Cannot open file for reading: " + path);
  }
  try {
    content = file.read();
  } finally {
    file.close();
  }
  return content;
};

/**
 * Writes a UTF-8 file, creating parent folders as needed.
 *
 * @param {string} path
 * @param {string} content
 * @returns {string} the path written
 */
web2ai.writeTextFile = function (path, content) {
  var file = new File(path);
  var parent = file.parent;
  if (parent && !parent.exists) {
    parent.create();
  }
  file.encoding = "UTF-8";
  if (!file.open("w")) {
    throw new Error("Cannot open file for writing: " + path);
  }
  try {
    file.write(content);
  } finally {
    file.close();
  }
  return file.fsName;
};

/**
 * Reads and parses a JSON file.
 *
 * @param {string} path
 * @returns {Object}
 */
web2ai.readJsonFile = function (path) {
  return JSON.parse(web2ai.readTextFile(path));
};

/**
 * Absolute path of the extension root, as told to us by the panel.
 *
 * $.fileName is NOT usable here. For a script loaded through the manifest's
 * ScriptPath, ExtendScript reports the host application's own executable
 * rather than the script -- deriving a path from it lands somewhere inside
 * "Adobe Illustrator 2025/Support Files/Contents" and every config read fails.
 *
 * Only the panel knows the real location, via CEP's getSystemPath(EXTENSION),
 * so it passes it in through web2ai.hello() before anything else runs.
 *
 * @type {string}
 */
web2ai._extensionRoot = "";

/**
 * @param {string} path Absolute path of the folder containing CSXS/.
 * @returns {string} the path that was stored
 */
web2ai.setExtensionRoot = function (path) {
  if (path && String(path).length > 0) {
    // The backslash before "/" looks redundant and ESLint flags it as such,
    // but ExtendScript ends a regex literal at the first unescaped slash even
    // inside a character class -- without it this line is a syntax error that
    // takes down the whole bundle.
    web2ai._extensionRoot = String(path).replace(/[\\\/]+$/, "");
    // A different extension root invalidates anything cached from the old one.
    web2ai._config = null;
    web2ai._fontMap = null;
  }
  return web2ai._extensionRoot;
};

/**
 * @returns {string}
 */
web2ai.extensionRoot = function () {
  if (web2ai._extensionRoot.length === 0) {
    throw new Error(
      "Extension root unknown -- the panel must call web2ai.hello(root) before reading config."
    );
  }
  return web2ai._extensionRoot;
};

/**
 * Loads config/web2ai.config.json, which the build copies into the extension
 * root. Cached after the first read.
 *
 * @returns {Object}
 */
web2ai.config = function () {
  if (!web2ai._config) {
    web2ai._config = web2ai.readJsonFile(web2ai.extensionRoot() + "/config/web2ai.config.json");
  }
  return web2ai._config;
};

/**
 * Loads config/font-map.json. Cached after the first read.
 *
 * @returns {Object}
 */
web2ai.fontMap = function () {
  if (!web2ai._fontMap) {
    web2ai._fontMap = web2ai.readJsonFile(web2ai.extensionRoot() + "/config/font-map.json");
  }
  return web2ai._fontMap;
};
