import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The manifest has to be *valid XML*, not merely XML-shaped.
 *
 * A double hyphen inside a comment is illegal per the XML specification, and
 * an ExtendScript-flavoured comment like `<!-- pass --enable-node -->` trips
 * over it immediately: the parser ends the comment early, the rest of the file
 * becomes garbage, and CEP drops the extension with — as ever — no message
 * anywhere. This cost a long debugging session; it does not get to happen
 * twice.
 */

const manifestPath = fileURLToPath(new URL("../CSXS/manifest.xml", import.meta.url));

function readManifest(): string {
  return readFileSync(manifestPath, "utf8");
}

describe("CSXS/manifest.xml", () => {
  it("has no double hyphen inside a comment", () => {
    const offenders: string[] = [];
    for (const match of readManifest().matchAll(/<!--([\s\S]*?)-->/g)) {
      const body = match[1] ?? "";
      if (body.includes("--")) offenders.push(body.trim().slice(0, 90));
    }
    expect(offenders, `illegal "--" inside XML comment(s): ${offenders.join(" | ")}`).toEqual([]);
  });

  it("has no comment before the root element", () => {
    // CEP's manifest reader is stricter than a general XML parser.
    const beforeRoot = readManifest().split("<ExtensionManifest")[0] ?? "";
    expect(beforeRoot.includes("<!--")).toBe(false);
  });

  it("parses as well-formed XML", () => {
    const xml = readManifest();

    // Tag balance is the cheap structural check that a truncated comment breaks.
    const opened = [...xml.matchAll(/<([A-Za-z][\w.-]*)(\s[^>]*?)?(?<!\/)>/g)].map((m) => m[1]);
    const closed = [...xml.matchAll(/<\/([A-Za-z][\w.-]*)>/g)].map((m) => m[1]);
    for (const tag of new Set(closed)) {
      const opens = opened.filter((name) => name === tag).length;
      const closes = closed.filter((name) => name === tag).length;
      expect(opens, `<${tag}> opened ${opens}x but closed ${closes}x`).toBe(closes);
    }

    expect(xml.startsWith("<?xml ")).toBe(true);
    expect(xml.trimEnd().endsWith("</ExtensionManifest>")).toBe(true);
  });

  it("declares the fields CEP checks before it loads anything", () => {
    const xml = readManifest();
    expect(xml).toContain('<RequiredRuntime Name="CSXS" Version="9.0"/>');
    expect(xml).toMatch(/<Host Name="ILST" Version="\[25\.0,99\.9\]"\/>/);
    expect(xml).toContain("<MainPath>./index.html</MainPath>");
    expect(xml).toContain("<ScriptPath>./jsx/host.jsx</ScriptPath>");
  });

  it("is pure ASCII", () => {
    const offenders = [...readManifest()].filter((char) => char.charCodeAt(0) > 127);
    expect(offenders).toEqual([]);
  });
});
