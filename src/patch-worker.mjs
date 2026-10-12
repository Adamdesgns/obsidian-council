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
  // A trailing space can be the prefix of an unchanged empty context line.
  // Only remove line breaks; trimming whitespace changes the hunk itself.
  patch = patch.replace(/\n+$/, "") + "\n";
  return Buffer.byteLength(patch) <= MAX_PATCH_BYTES ? patch : null;
}

function checkedPath(workspace, path) {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path) || path.includes("\\") || path.includes(":") ||
      path.includes('"') || parts.some(s => !s || s === "." || s === ".." ||
        s.toLowerCase() === ".git" || /^\.env(?:\.|$)/i.test(s) ||
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
  if (typeof patch !== "string" || !patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES || !patch.startsWith("diff --git a/")) throw new Error("patch-format-refused");
  if (/^(?:rename|copy|deleted file mode|old mode|new mode|GIT binary patch|Binary files)\b/m.test(patch)) throw new Error("patch-operation-refused");
  // Parse every line Git will receive. Merely finding the first header/hunk
  // allows a second, traditional (no diff --git) patch to evade inspection.
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let i = 0;
  const paths = new Set();
  const identities = new Set();
  while (i < lines.length) {
    if (paths.size >= MAX_FILES) throw new Error("patch-file-count-refused");
    const header = lines[i++].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!header || header[1] !== header[2]) throw new Error("patch-header-refused");
    const path = header[1];
    checkedPath(workspace, path);
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (identities.has(identity)) throw new Error("patch-duplicate-refused");
    identities.add(identity);
    paths.add(path);
    let newFile = false;
    if (lines[i]?.startsWith("new file mode ")) {
      if (lines[i++] !== "new file mode 100644") throw new Error("patch-mode-refused");
      newFile = true;
    }
    if (lines[i]?.startsWith("index ")) {
      if (!/^index [\da-f]+\.\.[\da-f]+(?: 100(?:644|755))?$/i.test(lines[i++])) throw new Error("patch-mode-refused");
    }
    const old = lines[i++]?.match(/^--- (.+)$/)?.[1];
    const next = lines[i++]?.match(/^\+\+\+ (.+)$/)?.[1];
    if (!old || !next || ![("a/" + path), "/dev/null"].includes(old) || next !== "b/" + path ||
        (newFile && old !== "/dev/null")) throw new Error("patch-hunk-refused");
    let hunks = 0;
    while (lines[i]?.startsWith("@@ ")) {
      const hunk = lines[i++].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
      if (!hunk) throw new Error("patch-hunk-refused");
      let oldLeft = Number(hunk[2] ?? 1), newLeft = Number(hunk[4] ?? 1), markerAllowed = false;
      if (![hunk[1],hunk[3],oldLeft,newLeft].every(n => Number.isSafeInteger(Number(n)))) throw new Error("patch-hunk-refused");
      while (oldLeft > 0 || newLeft > 0) {
        const line = lines[i++];
        if (line === "\\ No newline at end of file" && markerAllowed) { markerAllowed = false; continue; }
        const sign = line?.[0];
        if (![" ", "+", "-"].includes(sign)) throw new Error("patch-hunk-refused");
        if (sign !== "+") oldLeft--;
        if (sign !== "-") newLeft--;
        if (oldLeft < 0 || newLeft < 0) throw new Error("patch-hunk-refused");
        markerAllowed = true;
      }
      if (markerAllowed && lines[i] === "\\ No newline at end of file") i++;
      hunks++;
    }
    if (!hunks) throw new Error("patch-hunk-refused");
    // The next line, if any, must be another fully inspected Git header.
    if (i < lines.length && !lines[i].startsWith("diff --git a/")) throw new Error("patch-format-refused");
  }
  return [...paths];
}

export function applyWorkerPatch(workspace, text) {
  const patch = extractPatch(text);
  if (!patch) return {ok: false, reason: "No bounded unified diff returned."};
  let paths, root;
  try { root = realpathSync(workspace); paths = inspectPatch(root, patch); }
  catch (e) { return {ok: false, reason: String(e.message || e)}; }
  const options = {cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024};
  // Git silently skips root-relative paths when invoked from a repository
  // subdirectory. Prefix the inspected paths with that directory so the exact
  // selected workspace receives the edit, including nested worktrees.
  const location = spawnSync("git", ["rev-parse", "--show-prefix"], options);
  if (location.error) return {ok: false, reason: "Git could not inspect the workspace."};
  const prefix = location.status === 0 ? location.stdout.replace(/\r?\n$/, "") : "";
  const run = args => spawnSync("git", ["apply", ...(prefix ? ["--directory=" + prefix] : []), ...args, "-"], {...options, input: patch});
  const checked = run(["--check", "--whitespace=error"]);
  if (checked.status !== 0) return {ok: false, reason: "Patch did not match the current workspace."};
  // Recheck links after git apply --check and before the write.
  try { for (const path of paths) checkedPath(root, path); }
  catch (e) { return {ok: false, reason: String(e.message || e)}; }
  const applied = run(["--whitespace=error"]);
  if (applied.status !== 0) return {ok: false, reason: "Git could not apply the checked patch."};
  return {ok: true, paths, hashes: Object.fromEntries(paths.map(path => {
    const file = checkedPath(root, path);
    return [path, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }))};
}
