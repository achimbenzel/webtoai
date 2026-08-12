import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildJsonSchema } from "./json-schema.ts";

const out = fileURLToPath(new URL("../ui-scene.schema.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`, "utf8");
console.log(`wrote ${out}`);
