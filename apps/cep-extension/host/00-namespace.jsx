/**
 * web2ai ExtendScript host -- namespace bootstrap.
 *
 * ============================ ES3 ONLY ============================
 * ExtendScript is ES3. A single ES5+ token anywhere in this bundle makes the
 * *whole* script fail to parse, silently, with "EvalScript error.".
 * Forbidden: let, const, arrow functions, native JSON (json2.js supplies it),
 * Array.prototype.forEach/map/filter/indexOf, String.prototype.trim,
 * Object.keys, trailing commas, getters/setters, try/catch destructuring.
 * The eslint config in the repo root enforces ecmaVersion: 3 on this folder.
 * ==================================================================
 *
 * The build concatenates host/lib/json2.js and the host/*.jsx sources (in
 * filename order) into dist/host/index.jsx. There is deliberately no
 * #include / //@include: concatenation is deterministic and does not depend
 * on the ExtendScript preprocessor resolving relative paths at runtime.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

web2ai.VERSION = "0.1.0";
web2ai.SCHEMA_VERSION = 1;

/**
 * Wraps a host entry point so that CEP never receives the opaque string
 * "EvalScript error." -- every failure comes back as structured JSON.
 *
 * @param {function} fn
 * @returns {string} JSON: {ok:true, value:*} or {ok:false, error:string, line:number}
 */
web2ai.safeCall = function (fn) {
  var payload;
  try {
    payload = { ok: true, value: fn() };
  } catch (e) {
    payload = {
      ok: false,
      error: e && e.message ? String(e.message) : String(e),
      line: e && e.line ? e.line : -1,
      fileName: e && e.fileName ? String(e.fileName) : ""
    };
  }
  return JSON.stringify(payload);
};

/**
 * ES3 has no Array.prototype.indexOf.
 * @param {Array} list
 * @param {*} value
 * @returns {number}
 */
web2ai.indexOf = function (list, value) {
  var i;
  for (i = 0; i < list.length; i += 1) {
    if (list[i] === value) {
      return i;
    }
  }
  return -1;
};

/**
 * ES3 has no String.prototype.trim.
 * @param {string} text
 * @returns {string}
 */
web2ai.trim = function (text) {
  return String(text).replace(/^\s+/, "").replace(/\s+$/, "");
};
