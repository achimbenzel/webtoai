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
  kind: "path" | "text" | "placed" | "group";
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

/** Items and sublayers are inserted at index 0, exactly as Illustrator does. */
function makeContainer(name: string): Record<string, unknown> {
  const items: FakeItem[] = [];
  const layers: Record<string, unknown>[] = [];

  const container: Record<string, unknown> = {
    name,
    __items: items,
    __layers: layers,
    clipped: false,
  };

  const push = (item: FakeItem): FakeItem => {
    items.unshift(item);
    return item;
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

  container["groupItems"] = {
    add(): Record<string, unknown> {
      const group = makeContainer("");
      const item: FakeItem = { ...newItem("group"), children: readContainer(group) };
      items.unshift(item);
      // The group is both an item in its parent and a container in its own
      // right, so the two views are kept in sync through the same object.
      group["__item"] = item;
      return group;
    },
  };

  container["layers"] = {
    add(): Record<string, unknown> {
      const layer = makeContainer("");
      layers.unshift(layer);
      return layer;
    },
    get length(): number {
      return layers.length;
    },
  };

  return container;
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
      textFonts: Object.assign([] as unknown[], {
        getByName(name: string) {
          const known = ["ArialMT", "Arial-BoldMT", "MyriadPro-Regular"];
          if (!known.includes(name)) throw new Error(`font not found: ${name}`);
          return { name, family: name.split("-")[0], style: name.includes("Bold") ? "Bold" : "" };
        },
      }),
      documents: {
        add(colorSpace: string, width: number, height: number): Record<string, unknown> {
          const root = makeContainer("Layer 1");
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
