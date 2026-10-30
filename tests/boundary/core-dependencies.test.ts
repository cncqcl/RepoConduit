import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return files.flat();
}

test("core source has no provider SDK, URL, model ID, or adapter imports", async () => {
  const files = await sourceFiles(path.resolve("src/core"));
  assert.ok(files.length > 0, "core source must exist");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /(?:from\s*["']|import\s*\(["'])(?:@openai\/|openai|@anthropic\/|\.\.\/\.\.\/adapters\/)/i, file);
    assert.doesNotMatch(source, /https?:\/\//i, file);
    assert.doesNotMatch(source, /\b(?:gpt|claude)-[\w.-]+\b/i, file);
  }
});
