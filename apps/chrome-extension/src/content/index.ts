import { CaptureEnvError, createCaptureEnv } from "./env.ts";
import { MSG, type RunCaptureMessage, type WalkResponse } from "../shared/messages.ts";
import { dropPrunedNodes, walk } from "../lib/walker.ts";

/**
 * Content script: the only place that touches the live page.
 *
 * It is injected on demand by the service worker rather than declared for
 * `<all_urls>`, so nothing runs on pages the user never captures.
 */

declare global {
  interface Window {
    __web2aiContentReady?: boolean;
  }
}

/** Injecting twice must not register two listeners. */
if (window.__web2aiContentReady !== true) {
  window.__web2aiContentReady = true;
  registerListener();
}

function registerListener(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRunCapture(message)) return false;

    runCapture(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WalkResponse);
      });

    // Keeps the message channel open for the async response.
    return true;
  });
}

function isRunCapture(message: unknown): message is RunCaptureMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === MSG.RUN_CAPTURE
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function runCapture(message: RunCaptureMessage): Promise<WalkResponse> {
  const { options } = message;

  // A full-page capture reads `position: fixed` and `sticky` elements at
  // whatever offset the page happens to be scrolled to. Scrolling to the top
  // first is what places them once, where they belong, instead of floating in
  // the middle of the artboard.
  const previousScroll = { x: window.scrollX, y: window.scrollY };
  const mustRestore = options.fullPage && (previousScroll.x !== 0 || previousScroll.y !== 0);
  if (mustRestore) {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
    await nextFrame();
  }

  try {
    const env = createCaptureEnv({
      rootSelector: options.rootSelector,
      capturedAt: new Date().toISOString(),
    });

    const result = walk(env, options);
    result.scene.root = dropPrunedNodes(result.scene.root);

    // Schema validation deliberately happens in the service worker rather than
    // here: it needs the resolved assets to validate the payload that actually
    // ships, and keeping zod out of the injected bundle saves ~250 kB on every
    // page the user captures.
    return {
      ok: true,
      scene: result.scene,
      assetRequests: result.assetRequests,
      log: result.log.summary(),
    };
  } catch (error) {
    if (error instanceof CaptureEnvError) return { ok: false, error: error.message };
    throw error;
  } finally {
    if (mustRestore) {
      window.scrollTo({
        top: previousScroll.y,
        left: previousScroll.x,
        behavior: "instant" as ScrollBehavior,
      });
    }
  }
}
