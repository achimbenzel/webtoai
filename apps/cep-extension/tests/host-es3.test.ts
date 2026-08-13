import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS build tooling, shared with scripts/build.mjs.
import { checkExtendScriptSource, hasUnescapedSlashInCharClass } from "../scripts/es3-checks.mjs";

/**
 * The single most expensive class of mistake in this project is shipping
 * something ExtendScript's parser rejects. It gives up on the *whole* bundle,
 * `web2ai` is never defined, and every panel call answers "web2ai is
 * undefined" — with no file, no line, and nothing pointing at the cause.
 *
 * `scripts/es3-checks.mjs` holds the actual rules and is shared with the build,
 * so a source that passes here cannot fail there.
 */

interface Problem {
  line: number;
  message: string;
  label: string;
}

const check = checkExtendScriptSource as (source: string, label?: string) => Problem[];
const slashInClass = hasUnescapedSlashInCharClass as (literal: string) => boolean;

const hostDir = fileURLToPath(new URL("../host", import.meta.url));

function hostSources(): string[] {
  return readdirSync(hostDir)
    .filter((name) => name.endsWith(".jsx"))
    .sort();
}

function describeProblems(problems: Problem[]): string {
  return problems.map((p) => `${p.label}:${p.line} ${p.message}`).join("\n");
}

describe("ExtendScript host sources", () => {
  it("has host sources to check", () => {
    expect(hostSources().length).toBeGreaterThan(0);
  });

  it.each(hostSources())("%s is valid ExtendScript", (name) => {
    const problems = check(readFileSync(join(hostDir, name), "utf8"), name);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it("json2.js is valid ExtendScript", () => {
    const problems = check(readFileSync(join(hostDir, "lib", "json2.js"), "utf8"), "json2.js");
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it("the concatenated bundle is valid ExtendScript", () => {
    // Checking the sources one by one is not the same as checking what ships.
    // The bundle is the artefact Illustrator parses, so the bundle is asserted.
    const bundle = [
      readFileSync(join(hostDir, "lib", "json2.js"), "utf8"),
      ...hostSources().map((name) => readFileSync(join(hostDir, name), "utf8")),
    ].join("\n\n");

    const problems = check(bundle, "bundle");
    expect(problems, describeProblems(problems)).toEqual([]);
    expect(bundle).toContain("web2ai.hello =");
    expect(bundle).toContain("web2ai.openScene =");
  });

  it("uses no library methods ExtendScript lacks", () => {
    // acorn validates syntax, not the standard library. These exist in ES5 and
    // not in ExtendScript, so they fail at runtime rather than at parse time.
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

describe("the ExtendScript checker itself", () => {
  it("catches an unescaped slash inside a character class", () => {
    // This exact literal took down the whole host bundle, and acorn's ES3 mode
    // accepts it happily: ExtendScript ends the regex at the inner slash and
    // then reports "Expected: )" on a line that looks perfectly fine.
    expect(slashInClass(String.raw`/[\\/]+$/`)).toBe(true);
    const problems = check(String.raw`var x = "a".replace(/[\\/]+$/, "");`);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("unescaped");
  });

  it("accepts the escaped form", () => {
    expect(slashInClass(String.raw`/[\\\/]+$/`)).toBe(false);
    expect(check(String.raw`var x = "a".replace(/[\\\/]+$/, "");`)).toEqual([]);
  });

  it("does not mistake a closing delimiter for the bug", () => {
    expect(slashInClass(String.raw`/^abc$/`)).toBe(false);
    expect(slashInClass(String.raw`/a\/b/`)).toBe(false);
    expect(slashInClass(String.raw`/[abc]/g`)).toBe(false);
  });

  it("catches reserved words used as property names", () => {
    // ES5 legalised these; ES3 and ExtendScript did not.
    expect(check(`var o = {}; o.default = 1;`)).toHaveLength(1);
    expect(check(`var o = { class: 1 };`)).toHaveLength(1);
    expect(check(`var o = {}; o.delete = 1;`)).toHaveLength(1);
    expect(check(`var o = { "class": 1 };`)).toEqual([]);
    expect(check(`var o = {}; o["default"] = 1;`)).toEqual([]);
  });

  it("catches non-ASCII and non-ES3 syntax", () => {
    expect(check(`var s = "—";`)).toHaveLength(1);
    expect(check(`const x = 1;`)[0]?.message).toContain("not valid ES3");
    expect(check(`var o = { a: 1, };`)[0]?.message).toContain("not valid ES3");
  });
});
