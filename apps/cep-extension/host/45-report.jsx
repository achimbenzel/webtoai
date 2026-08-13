/**
 * web2ai ExtendScript host -- the import report. ES3 ONLY.
 *
 * Milestone 4's central promise: anything skipped or degraded is named, with
 * a count and an example, and nothing is dropped quietly. The report is what
 * makes "it does not support that" a statement the user can check rather than
 * something they have to notice for themselves.
 */

// eslint-disable-next-line no-redeclare
var web2ai = typeof web2ai === "undefined" ? {} : web2ai;

/**
 * Records one degradation.
 *
 * Entries are aggregated by code as they arrive: a page with 400 unsupported
 * filters should produce one report row saying 400, not 400 rows.
 *
 * @param {Object} ctx render context
 * @param {string} level "info" | "warn" | "unsupported"
 * @param {string} code machine-readable, matching docs/LIMITATIONS.md
 * @param {string} nodeName
 * @param {string} detail
 */
web2ai.report = function (ctx, level, code, nodeName, detail) {
  if (!ctx || !ctx.report) {
    return;
  }
  var rows = ctx.report.rows;
  var i;

  for (i = 0; i < rows.length; i += 1) {
    if (rows[i].code === code) {
      rows[i].count += 1;
      if (rows[i].examples.length < 5 && nodeName) {
        rows[i].examples.push(String(nodeName));
      }
      return;
    }
  }

  rows.push({
    level: String(level),
    code: String(code),
    count: 1,
    detail: String(detail || ""),
    examples: nodeName ? [String(nodeName)] : []
  });
};

/**
 * A fresh report.
 *
 * @returns {Object}
 */
web2ai.createReport = function () {
  return {
    rows: [],
    startedAt: new Date().getTime(),
    finishedAt: 0,
    nodesTotal: 0,
    nodesBuilt: 0,
    nodesFailed: 0,
    cancelled: false
  };
};

/**
 * Sorts rows so the report reads usefully: unsupported first, then warnings,
 * then info; within a level, most frequent first.
 *
 * @param {Object} report
 * @returns {Array}
 */
web2ai.sortedReportRows = function (report) {
  var rank = { unsupported: 0, warn: 1, info: 2 };
  var rows = [];
  var i;
  for (i = 0; i < report.rows.length; i += 1) {
    rows.push(report.rows[i]);
  }
  rows.sort(function (a, b) {
    var levelDiff =
      (rank[a.level] === undefined ? 3 : rank[a.level]) -
      (rank[b.level] === undefined ? 3 : rank[b.level]);
    if (levelDiff !== 0) {
      return levelDiff;
    }
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return rows;
};

/**
 * Renders the report as Markdown.
 *
 * @param {Object} report
 * @param {Object} scene the scene it describes
 * @returns {string}
 */
web2ai.reportMarkdown = function (report, scene) {
  var lines = [];
  var rows = web2ai.sortedReportRows(report);
  var substitutions = web2ai.fontSubstitutions();
  var i;

  lines.push("# web2ai import report");
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push("| Page | " + web2ai.escapePipes(scene.source.title || "(untitled)") + " |");
  lines.push("| URL | " + web2ai.escapePipes(scene.source.url) + " |");
  lines.push("| Captured | " + scene.source.capturedAt + " |");
  lines.push("| Imported | " + new Date().toString() + " |");
  lines.push("| Illustrator | " + app.name + " " + app.version + " |");
  lines.push(
    "| Nodes | " +
      report.nodesBuilt +
      " of " +
      report.nodesTotal +
      " built" +
      (report.nodesFailed > 0 ? ", " + report.nodesFailed + " failed" : "") +
      " |"
  );
  if (report.finishedAt > report.startedAt) {
    lines.push(
      "| Duration | " + Math.round((report.finishedAt - report.startedAt) / 100) / 10 + " s |"
    );
  }
  if (report.cancelled) {
    lines.push("| Status | **cancelled by the user** |");
  }
  lines.push("");

  if (rows.length === 0) {
    lines.push("Nothing was degraded. Every node rendered as captured.");
    lines.push("");
  } else {
    lines.push("## What was degraded");
    lines.push("");
    lines.push("| Level | Code | Count | Detail | Examples |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      lines.push(
        "| " +
          row.level +
          " | `" +
          row.code +
          "`" +
          " | " +
          row.count +
          " | " +
          web2ai.escapePipes(row.detail) +
          " | " +
          web2ai.escapePipes(row.examples.join(", ")) +
          " |"
      );
    }
    lines.push("");
  }

  if (substitutions.length > 0) {
    lines.push("## Font substitutions");
    lines.push("");
    lines.push("These fonts were not available and something else was used instead.");
    lines.push("");
    lines.push("| Requested | Used | Reason | Runs |");
    lines.push("| --- | --- | --- | ---: |");
    for (i = 0; i < substitutions.length; i += 1) {
      var sub = substitutions[i];
      lines.push(
        "| " +
          web2ai.escapePipes(sub.requested) +
          " | " +
          web2ai.escapePipes(sub.used) +
          " | " +
          sub.reason +
          " | " +
          sub.count +
          " |"
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Reason codes are documented in `docs/LIMITATIONS.md`.");
  lines.push("");

  return lines.join("\n");
};

/**
 * Markdown tables break on unescaped pipes.
 *
 * @param {string} text
 * @returns {string}
 */
web2ai.escapePipes = function (text) {
  return String(text === undefined || text === null ? "" : text).replace(/\|/g, "\\|");
};

/**
 * The report in the compact shape the panel renders.
 *
 * @param {Object} report
 * @returns {Object}
 */
web2ai.reportSummary = function (report) {
  var rows = web2ai.sortedReportRows(report);
  var unsupported = 0;
  var warnings = 0;
  var i;

  for (i = 0; i < rows.length; i += 1) {
    if (rows[i].level === "unsupported") {
      unsupported += rows[i].count;
    } else if (rows[i].level === "warn") {
      warnings += rows[i].count;
    }
  }

  return {
    rows: rows,
    fontSubstitutions: web2ai.fontSubstitutions(),
    nodesTotal: report.nodesTotal,
    nodesBuilt: report.nodesBuilt,
    nodesFailed: report.nodesFailed,
    unsupported: unsupported,
    warnings: warnings,
    cancelled: report.cancelled,
    durationMs: (report.finishedAt || new Date().getTime()) - report.startedAt
  };
};
