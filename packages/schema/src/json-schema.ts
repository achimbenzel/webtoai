/**
 * JSON Schema projection of ui-scene@1.
 *
 * The zod schemas in `validator.ts` are authoritative; this module derives a
 * JSON Schema from them so that non-TypeScript consumers (the ExtendScript
 * host's fixtures, editors, external tooling) can validate scenes too.
 * `pnpm schema:emit` writes the result to `packages/schema/ui-scene.schema.json`.
 */
import { z } from "zod";
import { sceneSchema } from "./validator.ts";
import { SCHEMA_ID, SCHEMA_VERSION } from "./constants.ts";

export function buildJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(sceneSchema, { io: "input", target: "draft-2020-12" });
  return {
    $id: `https://github.com/web2ai/schema/${SCHEMA_ID}-${SCHEMA_VERSION}.json`,
    title: `${SCHEMA_ID}@${SCHEMA_VERSION}`,
    description:
      "Intermediate format produced by the web2ai Chrome extension and consumed by the web2ai Illustrator CEP extension.",
    ...schema,
  };
}
