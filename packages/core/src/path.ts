/** Repository-relative data paths only; never credentials or Git internals. */
export function repoPath(path: string): string {
  const normalized = path.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || segments.some((s) => s === ".." || s === ".git" || /^\.env(?:\.|$)/.test(s)) || /[\x00-\x1f:]/.test(normalized)) {
    throw new Error("Expected a safe repository-relative path");
  }
  return normalized;
}
