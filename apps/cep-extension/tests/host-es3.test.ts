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

  it("contains no ES5+ constructs that acorn's ES3 mode still accepts", () => {
    // acorn's ES3 mode catches syntax, not library surface. These are the
    // built-ins ExtendScript lacks; grep for them explicitly.
    const banned: ReadonlyArray<[RegExp, string]> = [
      [/\.forEach\s*\(/, "Array.prototype.forEach"],
      [/\.map\s*\(\s*function/, "Array.prototype.map"],
      [/\.filter\s*\(\s*function/, "Array.prototype.filter"],
      [/\.indexOf\s*\(/, "Array.prototype.indexOf (use web2ai.indexOf)"],
      [/\.trim\s*\(\s*\)/, "String.prototype.trim (use web2ai.trim)"],
      [/Object\.keys\s*\(/, "Object.keys"],
      [/Array\.isArray\s*\(/, "Array.isArray"],
      [/\bJSON\.parse\s*\(/, ""], // allowed: json2.js provides JSON
    ];

    for (const name of hostSources()) {
      const source = readFileSync(join(hostDir, name), "utf8");
      for (const [pattern, label] of banned) {
        if (label === "") continue;
        expect(pattern.test(source), `${name} uses ${label}`).toBe(false);
      }
    }
  });
});
