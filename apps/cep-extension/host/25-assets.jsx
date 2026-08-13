/**
 * web2ai ExtendScript host -- asset extraction. ES3 ONLY.
 *
 * Scene assets arrive as data: URLs or as inline SVG source. Illustrator's
 * placedItems need a file on disk, so every asset is written to a temp folder
 * before it is placed. Decoding base64 by hand is the price of not having Node
 * available in the panel.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

var WEB2AI_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes base64 to a binary string, one character per byte.
 *
 * ExtendScript has no atob. Written against a lookup table rather than
 * indexOf-per-character because a 5 MB screenshot is ~7 MB of base64, and the
 * naive version takes minutes on that.
 *
 * @param {string} input base64, with or without padding and whitespace
 * @returns {string} binary string
 */
web2ai.base64Decode = function (input) {
  var lookup = {};
  var i;
  for (i = 0; i < WEB2AI_B64.length; i += 1) {
    lookup[WEB2AI_B64.charAt(i)] = i;
  }

  var clean = String(input).replace(/[^A-Za-z0-9+\/=]/g, "");
  var out = [];
  var chunk = [];

  for (i = 0; i < clean.length; i += 4) {
    var c0 = lookup[clean.charAt(i)];
    var c1 = lookup[clean.charAt(i + 1)];
    var c2 = lookup[clean.charAt(i + 2)];
    var c3 = lookup[clean.charAt(i + 3)];

    if (c0 === undefined || c1 === undefined) {
      break;
    }

    chunk.push(String.fromCharCode((c0 << 2) | (c1 >> 4)));
    if (c2 !== undefined) {
      chunk.push(String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2)));
    }
    if (c3 !== undefined) {
      chunk.push(String.fromCharCode(((c2 & 3) << 6) | c3));
    }

    // Joining in blocks keeps the string concatenation from going quadratic.
    if (chunk.length >= 4096) {
      out.push(chunk.join(""));
      chunk = [];
    }
  }

  out.push(chunk.join(""));
  return out.join("");
};

/**
 * Splits a data: URL into its mime type and payload.
 *
 * @param {string} dataUrl
 * @returns {Object|null} {mime, base64, data}
 */
web2ai.parseDataUrl = function (dataUrl) {
  var text = String(dataUrl || "");
  if (text.substring(0, 5) !== "data:") {
    return null;
  }
  var comma = text.indexOf(","); // es3-ok: String.indexOf
  if (comma === -1) {
    return null;
  }
  var header = text.substring(5, comma);
  var payload = text.substring(comma + 1);
  var isBase64 = header.substring(header.length - 7) === ";base64";
  var mime = isBase64 ? header.substring(0, header.length - 7) : header;

  return { mime: mime || "application/octet-stream", base64: isBase64, data: payload };
};

/**
 * File extension for a mime type. Illustrator places by extension, so a .png
 * called .bin will not open.
 *
 * @param {string} mime
 * @returns {string} including the dot
 */
web2ai.extensionForMime = function (mime) {
  switch (String(mime || "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/bmp":
      return ".bmp";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
};

/**
 * Writes bytes to disk.
 *
 * @param {string} path
 * @param {string} binary one character per byte
 * @returns {string} the path written
 */
web2ai.writeBinaryFile = function (path, binary) {
  var file = new File(path);
  file.encoding = "BINARY";
  if (!file.open("w")) {
    throw new Error("Cannot open file for writing: " + path);
  }
  try {
    file.write(binary);
  } finally {
    file.close();
  }
  return file.fsName;
};

/**
 * Whether an asset holds vector art.
 *
 * The scene's `kind` is authoritative, but a raster asset whose bytes happen to
 * be SVG (a `.svg` behind a URL the capture side never sniffed) still has to
 * take the vector route, or Illustrator is handed an SVG through the raster API
 * and silently places nothing.
 *
 * @param {Object} asset scene Asset
 * @param {string} mime mime type read from the data: URL, if any
 * @returns {boolean}
 */
web2ai.isVectorAsset = function (asset, mime) {
  if (asset.kind === "svg") {
    return true;
  }
  var declared = String(mime || asset.mime || "").toLowerCase();
  return declared.substring(0, 13) === "image/svg+xml";
};

/**
 * Materialises one scene asset as a file.
 *
 * @param {Object} asset scene Asset
 * @param {string} folder absolute path of the temp folder
 * @returns {Object} {ok, path, reason, kind, width, height}
 */
web2ai.extractAsset = function (asset, folder) {
  var size = { width: asset.width || 0, height: asset.height || 0 };

  if (asset.error) {
    return { ok: false, path: "", reason: asset.error, kind: "", width: 0, height: 0 };
  }

  // Inline SVG: text, straight to disk.
  if (asset.kind === "svg" && asset.svg) {
    var svgPath = folder + "/" + asset.id + ".svg";
    web2ai.writeTextFile(svgPath, asset.svg);
    return {
      ok: true,
      path: svgPath,
      reason: "",
      kind: "svg",
      width: size.width,
      height: size.height
    };
  }

  if (asset.dataUrl) {
    var parsed = web2ai.parseDataUrl(asset.dataUrl);
    if (parsed === null) {
      return {
        ok: false,
        path: "",
        reason: "asset-dataurl-unparsable",
        kind: "",
        width: 0,
        height: 0
      };
    }
    var vector = web2ai.isVectorAsset(asset, parsed.mime);
    var path = folder + "/" + asset.id + web2ai.extensionForMime(parsed.mime || asset.mime);
    if (parsed.base64) {
      web2ai.writeBinaryFile(path, web2ai.base64Decode(parsed.data));
    } else {
      web2ai.writeTextFile(path, decodeURIComponent(parsed.data));
    }
    return {
      ok: true,
      path: path,
      reason: "",
      kind: vector ? "svg" : "raster",
      width: size.width,
      height: size.height
    };
  }

  // No bytes: the capture side could not embed it. The node keeps its frame
  // and the report says why.
  return { ok: false, path: "", reason: "asset-not-embedded", kind: "", width: 0, height: 0 };
};

/**
 * Extracts every asset of a scene, once, into the temp folder.
 *
 * @param {Object} scene
 * @param {string} folder
 * @returns {Object} assetId -> {ok, path, reason}
 */
web2ai.extractAssets = function (scene, folder) {
  var byId = {};
  var i;
  for (i = 0; i < scene.assets.length; i += 1) {
    var asset = scene.assets[i];
    try {
      byId[asset.id] = web2ai.extractAsset(asset, folder);
    } catch (e) {
      byId[asset.id] = {
        ok: false,
        path: "",
        reason: "asset-write-failed: " + (e.message ? e.message : String(e))
      };
    }
  }
  return byId;
};
