/**
 * Minimal, typed bridge to the CEP host.
 *
 * We deliberately do not vendor Adobe's `CSInterface.js`: it is a thin,
 * untyped wrapper around the `window.__adobe_cep__` object that CEP injects,
 * and we only need a handful of its methods. Implementing it here keeps the
 * panel in TypeScript end to end and keeps the dependency surface at zero.
 *
 * The one rule that matters: **never interpolate payloads into evalScript**.
 * ExtendScript receives a source string, so a scene JSON pasted into it would
 * blow the parser's limits and mangle on any stray quote or line separator.
 * Payloads go through a temp file; only the file path travels over this wire.
 */

/** Envelope produced by `web2ai.safeCall` on the ExtendScript side. */
export type HostEnvelope<T> =
  { ok: true; value: T } | { ok: false; error: string; line: number; fileName: string };

export interface HostEnvironment {
  appName: string;
  appVersion: string;
  appLocale: string;
  appId: string;
  isAppOnline: boolean;
}

/** The subset of `window.__adobe_cep__` that web2ai uses. */
interface AdobeCep {
  evalScript(script: string, callback: (result: string) => void): void;
  getHostEnvironment(): string;
  getSystemPath(pathType: string): string;
  getExtensionId(): string;
  getCurrentApiVersion(): string;
  addEventListener(type: string, listener: (event: CepEvent) => void, obj?: unknown): void;
  removeEventListener(type: string, listener: (event: CepEvent) => void, obj?: unknown): void;
  dispatchEvent(event: string): void;
  closeExtension(): void;
}

export interface CepEvent {
  type: string;
  scope: string;
  appId: string;
  extensionId: string;
  data: string;
}

/** CEP's `SystemPath` enum values, as accepted by `getSystemPath`. */
export const SystemPath = {
  USER_DATA: "userData",
  COMMON_FILES: "commonFiles",
  MY_DOCUMENTS: "myDocuments",
  APPLICATION: "application",
  EXTENSION: "extension",
  HOST_APPLICATION: "hostApplication",
} as const;

export type SystemPathType = (typeof SystemPath)[keyof typeof SystemPath];

function getCep(): AdobeCep | undefined {
  // `__adobe_cep__` is injected by the CEP runtime and has no ambient typing.
  const injected = (globalThis as { __adobe_cep__?: AdobeCep }).__adobe_cep__;
  return injected;
}

/** False when the panel is opened in a plain browser during UI development. */
export function isCepAvailable(): boolean {
  return getCep() !== undefined;
}

function requireCep(): AdobeCep {
  const cep = getCep();
  if (cep === undefined) {
    throw new Error(
      "CEP runtime not available. This page must run inside Illustrator (Window > Extensions > web2ai).",
    );
  }
  return cep;
}

/**
 * Produces an ExtendScript string literal.
 *
 * `JSON.stringify` gets us 99% of the way, but U+2028/U+2029 are legal inside
 * a JSON string and illegal inside an ExtendScript one, so they are escaped
 * explicitly.
 */
export function toExtendScriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Runs raw ExtendScript source and resolves with its raw string result. */
export function evalScriptRaw(source: string): Promise<string> {
  const cep = requireCep();
  return new Promise((resolve) => {
    cep.evalScript(source, (result) => resolve(result));
  });
}

/**
 * Calls `web2ai.<fn>(...)` in the host and unwraps the JSON envelope.
 *
 * Arguments must be primitives — strings, numbers, booleans. Anything larger
 * belongs in a temp file whose path is passed as a string.
 */
export async function callHost<T>(
  fn: string,
  args: ReadonlyArray<string | number | boolean> = [],
): Promise<T> {
  const encoded = args
    .map((arg) => (typeof arg === "string" ? toExtendScriptLiteral(arg) : String(arg)))
    .join(", ");
  const raw = await evalScriptRaw(`web2ai.${fn}(${encoded})`);

  if (raw === "EvalScript error.") {
    throw new Error(
      `Host call web2ai.${fn}() failed to evaluate. The host bundle most likely contains ` +
        `non-ES3 syntax — check dist/host/index.jsx.`,
    );
  }
  if (raw === "undefined" || raw === "") {
    throw new Error(`Host call web2ai.${fn}() returned nothing. Is the host bundle loaded?`);
  }

  let envelope: HostEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as HostEnvelope<T>;
  } catch {
    throw new Error(`Host call web2ai.${fn}() returned non-JSON: ${raw.slice(0, 200)}`);
  }

  if (!envelope.ok) {
    throw new Error(`Host error in web2ai.${fn}(): ${envelope.error} (line ${envelope.line})`);
  }
  return envelope.value;
}

export function hostEnvironment(): HostEnvironment | undefined {
  const cep = getCep();
  if (cep === undefined) return undefined;
  try {
    return JSON.parse(cep.getHostEnvironment()) as HostEnvironment;
  } catch {
    return undefined;
  }
}

export function cepApiVersion(): string {
  const cep = getCep();
  if (cep === undefined) return "n/a";
  try {
    const version = JSON.parse(cep.getCurrentApiVersion()) as {
      major: number;
      minor: number;
      micro: number;
    };
    return `${version.major}.${version.minor}.${version.micro}`;
  } catch {
    return "unknown";
  }
}

/** `getSystemPath` returns a file:// URL; callers want a filesystem path. */
export function systemPath(type: SystemPathType): string {
  const cep = requireCep();
  const raw = cep.getSystemPath(type);
  if (!raw.startsWith("file://")) return raw;
  const decoded = decodeURIComponent(raw.slice("file://".length));
  // Windows paths come back as /C:/Users/... — strip the leading slash.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

export function extensionId(): string {
  const cep = getCep();
  return cep === undefined ? "com.web2ai.cep.panel" : cep.getExtensionId();
}
