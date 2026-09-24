/**
 * File-operation bookkeeping for compaction summaries: the read/modified
 * lists, and their grouped prefix-folded tree rendering (ported from OMP's
 * pi-utils `formatGroupedPaths`).
 */

const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;

/** True for `scheme://…` entries that have no meaningful directory structure. */
export function isUrlSchemePath(path: string): boolean {
  return URL_SCHEME_RE.test(path);
}

/** File operations extracted from the archived messages. */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Details stored in the compaction entry for file tracking. */
export interface CompactionFileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

export function computeFileLists(fileOps: FileOperations): CompactionFileDetails {
  const modified = new Set([...fileOps.edited, ...fileOps.written].filter((file) => !isUrlSchemePath(file)));
  const readFiles = [...fileOps.read].filter((file) => !isUrlSchemePath(file) && !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

// ============================================================================
// Grouped path tree (pi-utils port)
// ============================================================================

interface PathTreeNode {
  files: Array<{ name: string; key: string }>;
  fileNames: Set<string>;
  subdirs: Array<{ name: string; node: PathTreeNode }>;
  dirIndex: Map<string, PathTreeNode>;
}

interface GroupedTreeEvent {
  kind: "dir" | "file";
  depth: number;
  name: string;
  key: string;
}

function createNode(): PathTreeNode {
  return { files: [], fileNames: new Set(), subdirs: [], dirIndex: new Map() };
}

function addFile(node: PathTreeNode, name: string, key: string): void {
  if (node.fileNames.has(name)) return;
  node.fileNames.add(name);
  node.files.push({ name, key });
}

function buildPathTree(entries: Array<{ path: string; isDir: boolean; key: string }>): PathTreeNode {
  const root = createNode();
  for (const { path: rawPath, isDir, key } of entries) {
    const normalized = rawPath.replace(/\\/g, "/");
    if (URL_SCHEME_RE.test(normalized)) {
      addFile(root, normalized, key);
      continue;
    }
    const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    if (trimmed.length === 0) continue;
    const segments = trimmed.split("/");
    // Absolute paths carry a leading empty segment; drop it so they fold like
    // relative paths (no fake `# /` root header).
    const segs = segments[0] === "" ? segments.slice(1) : segments;
    if (segs.length === 0) continue;
    const dirCount = isDir ? segs.length : segs.length - 1;
    let node = root;
    for (let i = 0; i < dirCount; i++) {
      const segment = segs[i]!;
      let child = node.dirIndex.get(segment);
      if (!child) {
        child = createNode();
        node.dirIndex.set(segment, child);
        node.subdirs.push({ name: segment, node: child });
      }
      node = child;
    }
    if (!isDir) {
      // A file directly at the root keeps its full path as its line name.
      const name = node === root ? normalized : segs[segs.length - 1]!;
      addFile(node, name, key);
    }
  }
  return root;
}

function* walkPathTree(node: PathTreeNode, depth = 0): Generator<GroupedTreeEvent> {
  for (const file of node.files) {
    yield { kind: "file", depth, name: file.name, key: file.key };
  }
  for (const subdir of node.subdirs) {
    let dirNode = subdir.node;
    const parts = [subdir.name];
    while (dirNode.files.length === 0 && dirNode.subdirs.length === 1) {
      const only = dirNode.subdirs[0]!;
      parts.push(only.name);
      dirNode = only.node;
    }
    yield { kind: "dir", depth, name: parts.join("/"), key: "" };
    yield* walkPathTree(dirNode, depth + 1);
  }
}

/**
 * Render a flat path list as a grouped, prefix-folded directory tree.
 * Single-child directory chains fold into one header (`# a/b/c/`), each level
 * adds one `#`, and files are listed bare under the deepest directory header
 * that owns them. Absolute paths fold without a root header, and a file
 * directly at the root is listed by its full path.
 */
export function formatGroupedPaths(paths: readonly string[], annotate?: (path: string) => string): string {
  if (paths.length === 0) return "";
  const tree = buildPathTree(paths.map((entry) => ({ path: entry, isDir: entry.endsWith("/"), key: entry })));
  const lines: string[] = [];
  for (const event of walkPathTree(tree)) {
    if (event.kind === "dir") {
      lines.push(`${"#".repeat(event.depth + 1)} ${event.name}/`);
    } else {
      lines.push(annotate ? `${event.name}${annotate(event.key)}` : event.name);
    }
  }
  return lines.join("\n");
}

// ============================================================================
// File-operation summary rendering
// ============================================================================

const FILE_OPERATION_SUMMARY_LIMIT = 20;

/** Strip legacy/combined file tags so re-compaction self-heals old summaries. */
export function stripFileOperationTags(summary: string): string {
  return summary
    .replace(/<files>[\s\S]*?<\/files>\s*/g, "")
    .replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
    .trimEnd();
}

export function formatFileList(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
  if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
  const mode = new Map<string, "Read" | "Write" | "RW">();
  for (const file of readFiles) mode.set(file, "Read");
  for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
  const all = [...mode.keys()].sort();
  let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), (path) => ` (${mode.get(path)})`);
  if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
    files += `\n[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`;
  }
  return files;
}

/** Format file operations as one `<files>` tag (grouped tree + R/W marker). */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
  const files = formatFileList(readFiles, modifiedFiles, readSet);
  return files.length > 0 ? `<files>\n${files}\n</files>` : "";
}

/** Replace (or append) the `<files>` section of a summary. */
export function upsertFileOperations(
  summary: string,
  readFiles: string[],
  modifiedFiles: string[],
  readSet?: ReadonlySet<string>,
): string {
  const baseSummary = stripFileOperationTags(summary);
  const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
  if (!fileOperations) return baseSummary;
  if (!baseSummary) return fileOperations;
  return `${baseSummary}\n\n${fileOperations}`;
}
