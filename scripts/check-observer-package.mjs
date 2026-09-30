import { copyFile, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, ".github/extensions/agentcorp-observer");
const viewer = join(extension, "viewer");
const html = await readFile(join(viewer, "observe.html"), "utf8");
const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
if (!references.some(path => path.endsWith(".js")) || !references.some(path => path.endsWith(".css"))) {
  throw new Error("Observer HTML has no bundled JavaScript or CSS.");
}
const files = new Set(["observe.html"]);
for (const reference of references) {
  const relative = reference.slice(1);
  const content = await readFile(join(viewer, relative));
  files.add(relative);
  if (relative.endsWith(".js")) {
    for (const match of content.toString().matchAll(/(?:from\s*|import\s*\()\s*["']\.\/([^"']+)["']/g)) {
      const dependency = `assets/${match[1]}`;
      await readFile(join(viewer, dependency));
      files.add(dependency);
    }
  }
}
const assets = await readdir(join(viewer, "assets"));
if (assets.length !== files.size - 1 || assets.some(name => !files.has(`assets/${name}`))) {
  throw new Error("Viewer package includes missing or unrelated assets.");
}
await copyFile(join(root, "LICENSE"), join(extension, "LICENSE"));
await copyFile(join(root, "THIRD_PARTY_NOTICES.txt"), join(extension, "THIRD_PARTY_NOTICES.txt"));
const bytes = (await Promise.all([...files].map(async path => (await stat(join(viewer, path))).size)))
  .reduce((sum, size) => sum + size, 0);
console.log(`Packaged observer viewer: ${files.size} files, ${bytes} bytes of HTML/assets.`);
