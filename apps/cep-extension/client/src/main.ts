import { callHost, cepApiVersion, hostEnvironment, isCepAvailable } from "./cep/bridge.ts";

/** Shape returned by `web2ai.hello()` in host/90-entrypoints.jsx. */
interface HostHello {
  host: string;
  version: string;
  schemaVersion: number;
  app: string;
  appVersion: string;
  locale: string;
  engine: string;
  extensionRoot: string;
  jsonAvailable: boolean;
  configLoaded: boolean;
  configError: string;
  renderMaxLayerDepth: number;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing element #${id}`);
  return found as T;
}

function setLead(node: HTMLElement, text: string, tone: "ok" | "warn" | "err" | "none"): void {
  node.textContent = text;
  node.classList.remove("card__lead--ok", "card__lead--warn", "card__lead--err");
  if (tone !== "none") node.classList.add(`card__lead--${tone}`);
}

function renderKeyValues(target: HTMLElement, entries: ReadonlyArray<[string, string]>): void {
  target.replaceChildren();
  for (const [key, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.append(dt, dd);
  }
}

async function refreshHost(): Promise<void> {
  const greeting = el("host-greeting");
  const info = el("host-info");

  if (!isCepAvailable()) {
    setLead(
      greeting,
      "Running outside Illustrator -- CEP APIs unavailable. Open the panel via Window > Extensions > web2ai.",
      "warn",
    );
    renderKeyValues(info, [["CEP", "not detected"]]);
    return;
  }

  const env = hostEnvironment();
  try {
    const hello = await callHost<HostHello>("hello");
    setLead(greeting, `Hello from ${hello.app} ${hello.appVersion}.`, "ok");
    renderKeyValues(info, [
      ["Host bundle", `v${hello.version} (ui-scene@${hello.schemaVersion})`],
      ["CEP API", cepApiVersion()],
      ["ExtendScript", `${hello.engine} / ${hello.locale}`],
      ["json2.js", hello.jsonAvailable ? "loaded" : "MISSING"],
      [
        "Config",
        hello.configLoaded
          ? `loaded (maxLayerDepth ${hello.renderMaxLayerDepth})`
          : `failed: ${hello.configError}`,
      ],
      ["Extension root", hello.extensionRoot],
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLead(greeting, message, "err");
    renderKeyValues(info, [
      ["App", env === undefined ? "unknown" : `${env.appName} ${env.appVersion}`],
      ["CEP API", cepApiVersion()],
    ]);
  }
}

function main(): void {
  el("panel-version").textContent = `v${__WEB2AI_VERSION__}`;
  el<HTMLButtonElement>("refresh").addEventListener("click", () => {
    void refreshHost();
  });
  void refreshHost();
}

main();
