/**
 * A fake Illustrator object model.
 *
 * The renderer cannot be tested against the real application from CI, and the
 * parts most likely to be wrong — coordinate flips, z-order, layer nesting,
 * which item ends up clipping which — are pure structure. So the host runs
 * against this stand-in and the resulting tree is asserted directly.
 *
 * It models what the builder actually touches, and throws on anything it does
 * not know rather than silently absorbing a mistake.
 */

export interface FakeColor {
  kind: "rgb" | "gradient";
  red?: number;
  green?: number;
  blue?: number;
  gradient?: FakeGradient;
  angle?: number;
}

export interface FakeGradientStop {
  color: FakeColor;
  rampPoint: number;
  midPoint: number;
}

export interface FakeGradient {
  name: string;
  type: string;
  gradientStops: FakeGradientStop[] & { add(): FakeGradientStop };
}

export interface FakePathPoint {
  anchor: [number, number];
  leftDirection: [number, number];
  rightDirection: [number, number];
}

/** Anything that can sit inside a layer or a group. */
export interface FakeItem {
  kind: "path" | "text" | "placed" | "group" | "imported";
  name: string;
  top?: number;
  left?: number;
  width?: number;
  height?: number;
  radiusH?: number;
  radiusV?: number;
  filled?: boolean;
  stroked?: boolean;
  fillColor?: FakeColor;
  strokeColor?: FakeColor;
  strokeWidth?: number;
  strokeDashes?: number[];
  opacity?: number;
  blendingMode?: string;
  effects: string[];
  contents?: string;
  pathPoints: FakePathPoint[];
  closed?: boolean;
  file?: string;
  embedded?: boolean;
  /** Groups only. */
  children?: FakeContainer;
  clipped?: boolean;
}

export interface FakeContainer {
  name: string;
  /** Index 0 is topmost, matching Illustrator. */
  items: FakeItem[];
  layers: FakeLayer[];
  clipped?: boolean;
}

export interface FakeLayer extends FakeContainer {
  kind: "layer";
}

export interface FakeDocument {
  name: string;
  width: number;
  height: number;
  colorSpace: string;
  rulerOrigin: [number, number];
  layers: FakeLayer[];
  gradients: FakeGradient[];
}

interface Sandbox {
  [key: string]: unknown;
}

/** The mutable sandbox view of a container; `__items` is the live array. */
type SandboxContainer = Record<string, unknown>;

const ELEMENT_PLACEMENT = {
  PLACEATBEGINNING: "beginning",
  PLACEATEND: "end",
  PLACEBEFORE: "before",
  PLACEAFTER: "after",
  INSIDE: "inside",
} as const;

/** Removes an item from whatever container currently holds it. */
function detach(item: FakeItem): void {
  const from = (item as FakeItem & { __container?: SandboxContainer }).__container;
  if (from === undefined) return;
  const siblings = from["__items"] as FakeItem[];
  const index = siblings.indexOf(item);
  if (index !== -1) siblings.splice(index, 1);
}

/**
 * Gives an item the bits of the PageItem API the builder uses to reparent
 * things: `parent` and `move`. Illustrator's clipping groups are built by
 * moving an existing item into a new group, so this is not optional detail.
 */
function attachItemApi(item: FakeItem, container: SandboxContainer): FakeItem {
  const self = item as FakeItem & {
    __container: SandboxContainer;
    parent: SandboxContainer;
    move(target: SandboxContainer, placement: string): void;
  };
  self.__container = container;
  // Illustrator's `parent` is the Layer or GroupItem, both of which are
  // containers you can add to — `item.parent.groupItems.add()` is how the
  // builder wraps something in a clipping group.
  Object.defineProperty(self, "parent", {
    get: () => self.__container,
    configurable: true,
  });
  self.move = (target, placement) => {
    if (target === undefined || target["__items"] === undefined) {
      throw new Error("move: target is not a container");
    }
    detach(item);
    const siblings = target["__items"] as FakeItem[];
    if (placement === ELEMENT_PLACEMENT.PLACEATEND) siblings.push(item);
    else siblings.unshift(item);
    self.__container = target;
  };
  return item;
}

/** Items and sublayers are inserted at index 0, exactly as Illustrator does. */
function makeContainer(name: string, files: Record<string, string> = {}): SandboxContainer {
  const items: FakeItem[] = [];
  const layers: SandboxContainer[] = [];

  const container: SandboxContainer = {
    name,
    __items: items,
    __layers: layers,
    clipped: false,
  };
  container["__self"] = container;

  const push = (item: FakeItem): FakeItem => {
    items.unshift(item);
    return attachItemApi(item, container);
  };

  const newItem = (kind: FakeItem["kind"]): FakeItem => {
    const item: FakeItem = { kind, name: "", effects: [], pathPoints: [] };
    // Live effects are applied by XML string; recording them is how the tests
    // check that a drop shadow was actually requested.
    (item as FakeItem & { applyEffect(xml: string): void }).applyEffect = (xml) => {
      item.effects.push(xml);
    };
    return item;
  };

  container["pathItems"] = {
    rectangle(top: number, left: number, width: number, height: number): FakeItem {
      return push({ ...newItem("path"), top, left, width, height });
    },
    roundedRectangle(
      top: number,
      left: number,
      width: number,
      height: number,
      radiusH: number,
      radiusV: number,
    ): FakeItem {
      return push({ ...newItem("path"), top, left, width, height, radiusH, radiusV });
    },
    add(): FakeItem {
      const item = push(newItem("path"));
      const self = item as FakeItem & {
        setEntirePath(points: Array<[number, number]>): void;
      };
      self.setEntirePath = (points) => {
        item.pathPoints = points.map((anchor) => ({
          anchor,
          leftDirection: anchor,
          rightDirection: anchor,
        }));
      };
      return item;
    },
  };

  container["textFrames"] = {
    pointText(position: [number, number]): FakeItem {
      const frame = push({ ...newItem("text"), left: position[0], top: position[1] });
      return decorateText(frame);
    },
    areaText(path: FakeItem): FakeItem {
      const frame = push({ ...newItem("text"), left: path.left, top: path.top });
      return decorateText(frame);
    },
  };

  container["placedItems"] = {
    add(): FakeItem {
      const item = push(newItem("placed"));
      const self = item as FakeItem & { embed(): void };
      self.embed = () => {
        item.embedded = true;
      };
      return item;
    },
  };

  const addGroup = (kind: FakeItem["kind"]): SandboxContainer => {
    const group = makeContainer("", files);
    const item: FakeItem = { ...newItem(kind), children: readContainer(group) };
    items.unshift(item);
    attachItemApi(item, container);
    // A GroupItem is both an item in its parent and a container in its own
    // right. Illustrator has one object for both; the fake has two, so the
    // properties the builder sets on a group are forwarded to the item view.
    group["__item"] = item;
    linkGroup(group, item);
    return group;
  };

  container["groupItems"] = {
    add: (): SandboxContainer => addGroup("group"),
    /**
     * Imports vector art. The real call parses the file; the fake reads the
     * SVG's declared size so that object-fit has an intrinsic ratio to work
     * with, which is the whole point of the code under test.
     */
    createFromFile(file: { fsName: string }): SandboxContainer {
      const path = String(file?.fsName ?? "");
      const source = files[path];
      if (source === undefined) throw new Error(`createFromFile: no such file: ${path}`);
      if (!/\.svg$/i.test(path)) throw new Error(`createFromFile: not vector art: ${path}`);

      const group = addGroup("imported");
      const item = group["__item"] as FakeItem;
      item.file = path;
      const width = /\bwidth="([\d.]+)"/.exec(source);
      const height = /\bheight="([\d.]+)"/.exec(source);
      item.width = width === null ? 0 : Number(width[1]);
      item.height = height === null ? 0 : Number(height[1]);
      return group;
    },
  };

  container["layers"] = {
    add(): SandboxContainer {
      const layer = makeContainer("", files);
      layers.unshift(layer);
      return layer;
    },
    get length(): number {
      return layers.length;
    },
  };

  return container;
}

/** Properties the builder sets on a group, forwarded to its item view. */
function linkGroup(group: SandboxContainer, item: FakeItem): void {
  const forwarded = [
    "name",
    "clipped",
    "opacity",
    "blendingMode",
    "width",
    "height",
    "top",
    "left",
  ] as const;
  for (const key of forwarded) {
    Object.defineProperty(group, key, {
      get: () => (item as unknown as Record<string, unknown>)[key],
      set: (value: unknown) => {
        (item as unknown as Record<string, unknown>)[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(group, "parent", {
    get: () => (item as unknown as { parent: SandboxContainer }).parent,
    configurable: true,
  });
  Object.defineProperty(group, "move", {
    get: () => (item as unknown as { move: unknown }).move,
    configurable: true,
  });
}

function decorateText(frame: FakeItem): FakeItem {
  const attributes = {
    characterAttributes: {} as Record<string, unknown>,
    paragraphAttributes: {} as Record<string, unknown>,
  };
  const self = frame as FakeItem & Record<string, unknown>;
  self["textRange"] = attributes;
  self["characters"] = new Proxy([] as unknown[], {
    get(target, property) {
      if (property === "length") return String(frame.contents ?? "").length;
      return { characterAttributes: {} };
    },
  });
  return frame;
}

/** Converts the mutable sandbox container into a plain snapshot. */
function readContainer(container: Record<string, unknown>): FakeContainer {
  return {
    get name() {
      return String(container["name"]);
    },
    get items() {
      return container["__items"] as FakeItem[];
    },
    get layers() {
      return (container["__layers"] as Array<Record<string, unknown>>).map(
        (layer) => ({ kind: "layer", ...readContainer(layer) }) as FakeLayer,
      );
    },
    get clipped() {
      return container["clipped"] as boolean;
    },
  } as FakeContainer;
}

export interface FakeFont {
  name: string;
  family: string;
  style: string;
}

/**
 * A plausible set of installed fonts.
 *
 * Deliberately includes a family with the full weight ladder (Inter), one with
 * only two cuts (Arial), and one whose family name has a space and a condensed
 * sibling (Helvetica Neue) — the three shapes that break a naive matcher.
 */
export const INSTALLED_FONTS: FakeFont[] = [
  { name: "ArialMT", family: "Arial", style: "Regular" },
  { name: "Arial-BoldMT", family: "Arial", style: "Bold" },
  { name: "Arial-ItalicMT", family: "Arial", style: "Italic" },
  { name: "Arial-BoldItalicMT", family: "Arial", style: "Bold Italic" },
  { name: "MyriadPro-Regular", family: "Myriad Pro", style: "Regular" },
  { name: "Inter-Thin", family: "Inter", style: "Thin" },
  { name: "Inter-ExtraLight", family: "Inter", style: "ExtraLight" },
  { name: "Inter-Light", family: "Inter", style: "Light" },
  { name: "Inter-Regular", family: "Inter", style: "Regular" },
  { name: "Inter-Medium", family: "Inter", style: "Medium" },
  { name: "Inter-SemiBold", family: "Inter", style: "SemiBold" },
  { name: "Inter-Bold", family: "Inter", style: "Bold" },
  { name: "Inter-ExtraBold", family: "Inter", style: "ExtraBold" },
  { name: "Inter-Black", family: "Inter", style: "Black" },
  { name: "Inter-MediumItalic", family: "Inter", style: "Medium Italic" },
  { name: "Inter-BoldItalic", family: "Inter", style: "Bold Italic" },
  { name: "HelveticaNeue", family: "Helvetica Neue", style: "Regular" },
  { name: "HelveticaNeue-Bold", family: "Helvetica Neue", style: "Bold" },
  { name: "HelveticaNeue-CondensedBold", family: "Helvetica Neue", style: "Condensed Bold" },
];

export interface FakeIllustrator {
  sandbox: Sandbox;
  document(): FakeDocument | undefined;
}

/**
 * Builds the globals an ExtendScript host expects.
 *
 * @param files Backing store for the fake filesystem; also receives writes.
 */
export function createIllustratorSandbox(files: Record<string, string>): FakeIllustrator {
  let currentDoc: Record<string, unknown> | undefined;

  class FakeFile {
    readonly fsName: string;
    encoding = "UTF-8";

    constructor(path: string) {
      this.fsName = String(path);
    }
    get exists(): boolean {
      return this.fsName in files;
    }
    get parent(): { exists: boolean; create(): boolean; fsName: string } {
      return { exists: true, create: () => true, fsName: this.fsName.replace(/[/\\][^/\\]*$/, "") };
    }
    open(): boolean {
      return true;
    }
    read(): string {
      return files[this.fsName] ?? "";
    }
    write(text: string): boolean {
      files[this.fsName] = (files[this.fsName] ?? "") + text;
      return true;
    }
    close(): boolean {
      return true;
    }
  }

  class FakeFolder {
    readonly fsName: string;
    static temp = { fsName: "/tmp" };
    static desktop = { fsName: "/desktop" };
    constructor(path: string) {
      this.fsName = String(path);
    }
    get exists(): boolean {
      return true;
    }
    create(): boolean {
      return true;
    }
  }

  const gradients: FakeGradient[] = [];

  const sandbox: Sandbox = {
    File: FakeFile,
    Folder: FakeFolder,
    $: { locale: "en_US", engineName: "transient", os: "Windows", writeln: () => {} },

    RGBColor: class {
      kind = "rgb" as const;
      red = 0;
      green = 0;
      blue = 0;
    },
    GradientColor: class {
      kind = "gradient" as const;
      gradient: FakeGradient | undefined;
      angle = 0;
    },

    DocumentColorSpace: { RGB: "RGB", CMYK: "CMYK" },
    UserInteractionLevel: { DONTDISPLAYALERTS: "none", DISPLAYALERTS: "all" },
    GradientType: { LINEAR: "linear", RADIAL: "radial" },
    Justification: { LEFT: "left", RIGHT: "right", CENTER: "center", FULLJUSTIFY: "justify" },
    StrokeCap: { ROUNDENDCAP: "round", BUTTENDCAP: "butt" },
    ElementPlacement: ELEMENT_PLACEMENT,
    BlendModes: {
      NORMAL: "normal",
      MULTIPLY: "multiply",
      SCREEN: "screen",
      OVERLAY: "overlay",
      DARKEN: "darken",
      LIGHTEN: "lighten",
      COLORDODGE: "colordodge",
      COLORBURN: "colorburn",
      HARDLIGHT: "hardlight",
      SOFTLIGHT: "softlight",
      DIFFERENCE: "difference",
      EXCLUSION: "exclusion",
      HUE: "hue",
      SATURATIONBLEND: "saturation",
      COLORBLEND: "color",
      LUMINOSITY: "luminosity",
    },

    app: {
      name: "Adobe Illustrator",
      version: "29.6.1",
      userInteractionLevel: "all",
      textFonts: Object.assign(INSTALLED_FONTS.slice(), {
        getByName(name: string) {
          const font = INSTALLED_FONTS.find((candidate) => candidate.name === name);
          if (font === undefined) throw new Error(`font not found: ${name}`);
          return font;
        },
      }),
      documents: {
        add(colorSpace: string, width: number, height: number): Record<string, unknown> {
          const root = makeContainer("Layer 1", files);
          const doc: Record<string, unknown> = {
            name: `Untitled-${gradients.length + 1}`,
            width,
            height,
            colorSpace,
            rulerOrigin: [0, 0],
            __rootLayer: root,
            layers: Object.assign([root], { length: 1 }),
            gradients: {
              add(): FakeGradient {
                const stops: FakeGradientStop[] = [
                  { color: { kind: "rgb" }, rampPoint: 0, midPoint: 50 },
                  { color: { kind: "rgb" }, rampPoint: 100, midPoint: 50 },
                ];
                const gradient = {
                  name: "",
                  type: "linear",
                  gradientStops: Object.assign(stops, {
                    add(): FakeGradientStop {
                      const stop = {
                        color: { kind: "rgb" as const },
                        rampPoint: 100,
                        midPoint: 50,
                      };
                      stops.push(stop);
                      return stop;
                    },
                  }),
                } as FakeGradient;
                gradients.push(gradient);
                return gradient;
              },
            },
          };
          currentDoc = doc;
          return doc;
        },
      },
    },
  };

  return {
    sandbox,
    document(): FakeDocument | undefined {
      if (currentDoc === undefined) return undefined;
      const root = currentDoc["__rootLayer"] as Record<string, unknown>;
      return {
        name: String(currentDoc["name"]),
        width: currentDoc["width"] as number,
        height: currentDoc["height"] as number,
        colorSpace: String(currentDoc["colorSpace"]),
        rulerOrigin: currentDoc["rulerOrigin"] as [number, number],
        layers: [{ kind: "layer", ...readContainer(root) } as FakeLayer],
        gradients,
      };
    },
  };
}

/** Every item in a container tree, depth first. */
export function allItems(container: FakeContainer): FakeItem[] {
  const out: FakeItem[] = [];
  for (const item of container.items) {
    out.push(item);
    if (item.children) out.push(...allItems(item.children));
  }
  for (const layer of container.layers) out.push(...allItems(layer));
  return out;
}

/** Every layer in a tree, depth first, excluding the root. */
export function allLayers(container: FakeContainer): FakeLayer[] {
  const out: FakeLayer[] = [];
  for (const layer of container.layers) {
    out.push(layer);
    out.push(...allLayers(layer));
  }
  return out;
}
