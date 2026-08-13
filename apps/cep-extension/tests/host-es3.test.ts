import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";

/**
 * The single most expensive mistake in this project is shipping an ES5+ token
 * in the ExtendScript host: ExtendScript's parser gives up on the *whole*
 * bundle and `evalScript` answers with the string "EvalScript error." and
 * nothing else. Parsing every host source at `ecmaVersion: 3` turns that
 * silent, hard-to-locate runtime failure into a named test failure.
 */

const hostDir = fileURLToPath(new URL("../host", import.meta.url));

function hostSources(): string[] {
  return readdirSync(hostDir)
    .filter((name) => name.endsWith(".jsx"))
    .sort();
}

describe("ExtendScript host is ES3", () => {
  it("has host sources to check", () => {
    expect(hostSources().length).toBeGreaterThan(0);
  });

  it.each(hostSources())("%s parses as ES3", (name) => {
    const source = readFileSync(join(hostDir, name), "utf8");
    expect(() => parse(source, { ecmaVersion: 3, sourceType: "script" })).not.toThrow();
  });

  it("json2.js parses as ES3", () => {
    const source = readFileSync(join(hostDir, "lib", "json2.js"), "utf8");
    expect(() => parse(source, { ecmaVersion: 3, sourceType: "script" })).not.toThrow();
  });

  it("the concatenated bundle parses as ES3", () => {
    // Checking the sources one by one is not the same as checking what ships:
    // concatenation is where a file that does not end cleanly can run into the
    // next one. This asserts the artefact, assembled exactly as the build does.
    const bundle = [
      readFileSync(join(hostDir, "lib", "json2.js"), "utf8"),
      ...hostSources().map((name) => readFileSync(join(hostDir, name), "utf8")),
    ].join("\n\n");

    expect(() => parse(bundle, { ecmaVersion: 3, sourceType: "script" })).not.toThrow();
    // The namespace has to survive concatenation, or every host call answers
    // "web2ai is undefined" with nothing to say about why.
    expect(bundle).toContain("web2ai.hello =");
    expect(bundle).toContain("web2ai.openScene =");
  });

  it.each(hostSources())("%s is pure ASCII", (name) => {
    // ExtendScript reads .jsx as ASCII unless told otherwise. A stray em dash
    // in a comment is enough to mis-decode, and a single decode error takes
    // the whole bundle down — the same failure mode as an ES5 token.
    const source = readFileSync(join(hostDir, name), "utf8");
    const offenders = [...source].filter((char) => char.charCodeAt(0) > 127);
    expect(offenders, `non-ASCII characters: ${[...new Set(offenders)].join(" ")}`).toEqual([]);
  });

  it("contains no ES5+ constructs that acorn's ES3 mode still accepts", () => {
    // acorn's ES3 mode catches syntax, not library surface. These are the
    // built-ins ExtendScript lacks; grep for them explicitly.
    const banned: ReadonlyArray<[RegExp, string]> = [
      [/\.forEach\s*\(/, "Array.prototype.forEach"],
      [/\.map\s*\(\s*function/, "Array.prototype.map"],
      [/\.filter\s*\(\s*function/, "Array.prototype.filter"],
      // String.prototype.indexOf is ES3 and fine; the array one is not. They
      // are indistinguishable by regex, so a line that legitimately uses the
      // string form marks itself with `es3-ok`.
      [/\.indexOf\s*\(/, "Array.prototype.indexOf (use web2ai.indexOf)"],
      [/\.trim\s*\(\s*\)/, "String.prototype.trim (use web2ai.trim)"],
      [/Object\.keys\s*\(/, "Object.keys"],
      [/Array\.isArray\s*\(/, "Array.isArray"],
    ];

    for (const name of hostSources()) {
      const lines = readFileSync(join(hostDir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        // The marker is written as a comment, which sits on the line above.
        const previous = lines[index - 1] ?? "";
        if (line.includes("es3-ok") || previous.includes("es3-ok")) return;
        for (const [pattern, label] of banned) {
          expect(pattern.test(line), `${name}:${index + 1} uses ${label}\n  ${line.trim()}`).toBe(
            false,
          );
        }
      });
    }
  });
});
