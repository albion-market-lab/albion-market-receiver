import { writeFile } from "node:fs/promises";

const SOURCE_COMMIT = "1a469e53de028c5f85cdd80505f10cbd0a2515cf";
const sourceUrl = `https://raw.githubusercontent.com/ao-data/ao-bin-dumps/${SOURCE_COMMIT}/formatted/items.txt`;
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Item mapping download failed: HTTP ${response.status}`);

const entries = [];
for (const line of (await response.text()).split("\n")) {
  const match = /^\s*(\d+):\s+(\S+)\s+:/.exec(line);
  if (match) entries.push([Number(match[1]), match[2]]);
}
if (entries.length < 10_000) throw new Error(`Unexpected item mapping size: ${entries.length}`);

const body = `// Generated from ao-data/ao-bin-dumps ${SOURCE_COMMIT}; do not edit manually.\n`
  + `export const ALBION_ITEM_MAP_SOURCE = ${JSON.stringify(sourceUrl)};\n`
  + `export const ALBION_ITEM_IDS: Readonly<Record<number, string>> = ${JSON.stringify(Object.fromEntries(entries), null, 2)};\n`;
await writeFile(new URL("../src/albion-item-map.ts", import.meta.url), body);
