import type { DomElementLike } from "./dom.ts";
import { tagNameOf } from "./dom.ts";

/**
 * FNV-1a, 32 bit. Small, dependency-free and deterministic — which is all
 * `SceneNode.id` needs. Ids must be stable across captures of the same page so
 * that re-imports can be diffed.
 */
export function hash32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic node id from the element's position in the tree.
 *
 * The path alone would collide across pages, so the tag chain goes in too;
 * `path` is the sequence of child indices from the capture root.
 */
export function nodeId(path: readonly number[], tagChain: string): string {
  return `n${hash32(`${path.join("/")}|${tagChain}`)}`;
}

const CLASS_LIMIT = 2;
const NAME_LIMIT = 64;

/**
 * Builds the human-readable name that becomes the Illustrator layer name:
 * `div#header.nav.is-sticky`.
 *
 * Illustrator layer names are the main thing a designer navigates by, so this
 * favours recognisability over completeness: the id plus the first couple of
 * classes, truncated.
 */
export function nodeName(element: DomElementLike): string {
  const tag = tagNameOf(element);
  const id = element.getAttribute("id");
  const classAttribute = element.getAttribute("class") ?? "";

  const classes = classAttribute
    .split(/\s+/)
    .filter((token) => token.length > 0)
    // Utility-first CSS produces dozens of tiny classes; they make terrible
    // layer names, so prefer longer, more descriptive ones.
    .slice(0, CLASS_LIMIT);

  let name = tag;
  if (id !== null && id.length > 0) name += `#${id}`;
  for (const className of classes) name += `.${className}`;

  return name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1)}…` : name;
}

/** Name for a pseudo-element node, e.g. `div.badge::before`. */
export function pseudoName(parentName: string, pseudo: string): string {
  return `${parentName}${pseudo}`;
}

/**
 * Makes sibling names unique so the layer palette does not show ten identical
 * `li.item` entries. Mutates nothing; returns the deduplicated list.
 */
export function deduplicateNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });
}
