/**
 * ExtendScript source checks.
 *
 * Parsing with acorn at `ecmaVersion: 3` is necessary but *not sufficient*.
 * ExtendScript's parser is older and stricter than acorn's ES3 mode, and the
 * gaps are not academic — each one below cost a debugging session, because a
 * parse error in the host bundle surfaces only as "web2ai is undefined" three
 * layers away, with no file, no line and no message.
 *
 * Shared by the build (which refuses to emit a bundle that fails) and by
 * tests/host-es3.test.ts (which checks the sources individually).
 */
import { parse, tokenizer } from "acorn";

/**
 * ES3 reserved and future-reserved words.
 *
 * ES5 legalised these as unquoted property names; ES3 did not, and neither
 * does ExtendScript. `node.default` or `{ class: 1 }` is a syntax error there
 * while acorn's ES3 mode accepts both.
 */
const RESERVED = new Set([
  // Keywords
  "break",
  "case",
  "catch",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  // Future reserved words (ES3)
  "abstract",
  "boolean",
  "byte",
  "char",
  "class",
  "const",
  "debugger",
  "double",
  "enum",
  "export",
  "extends",
  "final",
  "float",
  "goto",
  "implements",
  "import",
  "int",
  "interface",
  "long",
  "native",
  "package",
  "private",
  "protected",
  "public",
  "short",
  "static",
  "super",
  "synchronized",
  "throws",
  "transient",
  "volatile",
  // Literals
  "null",
  "true",
  "false",
]);

/**
 * True when a regex literal contains an unescaped `/` inside a character class.
 *
 * `/[\\/]+$/` is valid modern JavaScript: inside `[...]` the slash needs no
 * escape. ExtendScript disagrees — it ends the literal at the first unescaped
 * slash regardless of context, then chokes on the remainder with a message as
 * unhelpful as "Expected: )". Writing `/[\\\/]+$/` works everywhere.
 *
 * @param {string} literal The literal including delimiters and flags.
 */
export function hasUnescapedSlashInCharClass(literal) {
  let inClass = false;
  let escaped = false;

  for (let i = 1; i < literal.length; i += 1) {
    const char = literal[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "]") {
      inClass = false;
      continue;
    }
    if (char === "/") {
      // Inside a class this is the bug; outside it is the closing delimiter.
      return inClass;
    }
  }
  return false;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** Walks every node of an acorn AST. */
function walk(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    walk(node[key], visit);
  }
}

/**
 * Checks one ExtendScript source file.
 *
 * @param {string} source
 * @param {string} label Used in messages; usually the file name.
 * @returns {Array<{line: number, message: string}>} empty when the source is sound
 */
export function checkExtendScriptSource(source, label = "source") {
  const problems = [];

  // 1. It has to be ES3 at all.
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 3, sourceType: "script" });
  } catch (error) {
    return [{ line: error.loc?.line ?? 0, message: `not valid ES3: ${error.message}` }];
  }

  // 2. Regex literals ExtendScript would terminate early.
  for (const token of tokenizer(source, { ecmaVersion: 3 })) {
    if (token.type.label !== "regexp") continue;
    const literal = source.slice(token.start, token.end);
    if (hasUnescapedSlashInCharClass(literal)) {
      problems.push({
        line: lineOf(source, token.start),
        message:
          `regex ${literal} has an unescaped "/" inside a character class. ` +
          `ExtendScript ends the literal there. Write it as \\/ instead.`,
      });
    }
  }

  // 3. Reserved words used as unquoted property names.
  walk(ast, (node) => {
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property?.type === "Identifier"
    ) {
      if (RESERVED.has(node.property.name)) {
        problems.push({
          line: lineOf(source, node.property.start),
          message: `".${node.property.name}" uses a reserved word as a property name; ExtendScript rejects it. Use ["${node.property.name}"].`,
        });
      }
    }
    if (node.type === "Property" && !node.computed && node.key?.type === "Identifier") {
      if (RESERVED.has(node.key.name)) {
        problems.push({
          line: lineOf(source, node.key.start),
          message: `object key "${node.key.name}" is a reserved word; ExtendScript rejects it. Quote it as "${node.key.name}".`,
        });
      }
    }
  });

  // 4. Non-ASCII: ExtendScript reads .jsx as ASCII unless told otherwise.
  const nonAscii = [...source].filter((char) => char.charCodeAt(0) > 127);
  if (nonAscii.length > 0) {
    problems.push({
      line: 0,
      message: `${nonAscii.length} non-ASCII character(s): ${[...new Set(nonAscii)].slice(0, 8).join(" ")}`,
    });
  }

  return problems.map((problem) => ({ ...problem, label }));
}

/** Formats problems for a thrown build error. */
export function formatProblems(problems) {
  return problems
    .map((problem) => `  ${problem.label}:${problem.line}  ${problem.message}`)
    .join("\n");
}
