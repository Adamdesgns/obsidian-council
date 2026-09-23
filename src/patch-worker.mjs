// Cursor and Grok author a text patch with read-only tools. Council alone
// applies that patch after validating every target inside the approved root.
import {createHash} from "node:crypto";
import {lstatSync, readFileSync, realpathSync} from "node:fs";
import {resolve, sep} from "node:path";
import {spawnSync} from "node:child_process";

const MAX_PATCH_BYTES = 128 * 1024;
const MAX_FILES = 24;

export function extractPatch(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("diff --git a/");
  if (start < 0) return null;
  let patch = text.slice(start).replace(/\r\n/g, "\n");
  const end = patch.search(/^END PATCH\s*$/m);
  if (end >= 0) patch = patch.slice(0, end);
  const fence = patch.search(/^\`\`\`\s*$/m);
  if (fence >= 0) patch = patch.slice(0, fence);
  patch = patch.trimEnd() + "\n";
  return Buffer.byteLength(patch) <= MAX_PATCH_BYTES ? patch : null;
}

function checkedPath(workspace, path) {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") ||
      path.includes('"') || parts.some(s => !s || s === "." || s === ".." ||
        s.toLowerCase() === ".git" || s.toLowerCase() === ".env" ||
        /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new Error("patch-path-refused");
  }
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error("patch-path-refused");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("patch-symlink-refused"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return target;
}

export function inspectPatch(workspace, patch) {
  if (!patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES || !patch.startsWith("diff --git a/")) throw new Error("patch-format-refused");
  if (/^(?:rename|copy|deleted file mode|old mode|new mode|GIT binary patch|Binary files)\b/m.test(patch)) throw new Error("patch-operation-refused");
  const blocks = patch.split(/(?=^diff --git a\/)/m).filter(Boolean);
  if (!blocks.length || blocks.length > MAX_FILES) throw new Error("patch-file-count-refused");
  const paths = new Set();
  for (const block of blocks) {
    const header = block.match(/^diff --git a\/(.+) b\/(.+)$/m);
    if (!header || header[1] !== header[2]) throw new Error("patch-header-refused");
    const path = header[1];
    checkedPath(workspace, path);
    if (paths.has(path)) throw new Error("patch-duplicate-refused");
    paths.add(path);
    const old = block.match(/^--- (.+)$/m)?.[1];
    const next = block.match(/^\+\+\+ (.+)$/m)?.[1];
    if (!old || !next || ![("a/" + path), "/dev/null"].includes(old) || next !== "b/" + path ||
        !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block)) throw new Error("patch-hunk-refused");
    if (/^new file mode /m.test(block) && !/^new file mode 100644$/m.test(block)) throw new Error("patch-mode-refused");
  }
  return [...paths];
}

export function applyWorkerPatch(workspace, text) {
  const patch = extractPatch(text);
  if (!patch) return {ok: false, reason: "No bounded unified diff returned."};
  let paths;
  try { paths = inspectPatch(workspace, patch); }
  catch (e) { return {ok: false, reason: String(e.message || e)}; }
  const run = args => spawnSync("git", ["apply", ...args, "-"], {
    cwd: workspace, input: patch, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
  });
  const checked = run(["--check", "--whitespace=error"]);
  if (checked.status !== 0) return {ok: false, reason: "Patch did not match the current workspace."};
  // Recheck links after git apply --check and before the write.
  try { for (const path of paths) checkedPath(workspace, path); }
  catch (e) { return {ok: false, reason: String(e.message || e)}; }
  const applied = run(["--whitespace=error"]);
  if (applied.status !== 0) return {ok: false, reason: "Git could not apply the checked patch."};
  return {ok: true, paths, hashes: Object.fromEntries(paths.map(path => {
    const file = checkedPath(workspace, path);
    return [path, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }))};
}
