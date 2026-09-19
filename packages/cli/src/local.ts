import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { repoPath, type RepoReader } from "../../core/src/index.js";

/** Files can be symlinks inside the repository, never outside it. */
export function localRepo(root: string): RepoReader {
  const realRoot = realpathSync(root);
  const path = (p: string) => {
    const real = realpathSync(resolve(realRoot, repoPath(p)));
    const rel = relative(realRoot, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Repository path escapes project root");
    return real;
  };
  return {
    async read(p) {
      try {
        const file = path(p);
        if (statSync(file).size > 2_000_000) throw new Error(`File exceeds 2 MB: ${p}`);
        return readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async list(dir) {
      try {
        return readdirSync(path(dir)).map((name) => ({ name, type: statSync(path(`${dir}/${name}`)).isDirectory() ? "dir" as const : "file" as const }));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    async files() { return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort(); },
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/**
 * A ref as a commit SHA, or an error that says what to pass instead. The default base is
 * `origin/main`, which a fresh repository or one without a remote does not have, and git's own
 * "fatal: Needed a single revision" does not tell anyone that.
 */
export function commitOf(root: string, ref: string, flag = "--base"): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    const remote = /^([^/]+)\//.exec(ref)?.[1];
    let remotes: string[] = [];
    try { remotes = git(root, ["remote"]).split("\n").filter(Boolean); } catch {}
    const hint = remote && !remotes.includes(remote)
      ? ` This repository has no \`${remote}\` remote; pass ${flag} with a local branch, such as ${flag} main.`
      : remote ? ` Run \`git fetch ${remote}\`, or pass ${flag} with a local branch.` : "";
    throw new Error(`${flag} ${ref} is not a commit in this repository.${hint}`);
  }
}

export function branchDiff(root: string, base: string, staged = false): string {
  if (staged) return git(root, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"]);
  const sha = commitOf(root, base);
  const mergeBase = git(root, ["merge-base", sha, "HEAD"]).trim();
  return git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", mergeBase, "--"]);
}

/** Trusted policy snapshot for Actions. Never copies files over a PR checkout. */
export function gitRepo(root: string, ref: string, flag = "--head"): RepoReader {
  const sha = commitOf(root, ref, flag);
  const entries = git(root, ["ls-tree", "-rz", sha]).split("\0").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t");
    return { mode: meta!.split(" ")[0], path: path! };
  });
  return {
    async read(path) {
      path = repoPath(path);
      const entry = entries.find((e) => e.path === path);
      if (!entry) return null;
      if (entry.mode === "120000") throw new Error(`Policy symlink is not supported: ${path}`);
      return git(root, ["show", `${sha}:${path}`]);
    },
    async files() { return entries.map((e) => e.path); },
    async list(dir) {
      const prefix = `${repoPath(dir)}/`;
      const children = new Map<string, "file" | "dir">();
      for (const e of entries) {
        if (!e.path.startsWith(prefix)) continue;
        const tail = e.path.slice(prefix.length);
        children.set(tail.split("/")[0]!, tail.includes("/") ? "dir" : "file");
      }
      return [...children].map(([name, type]) => ({ name, type }));
    },
  };
}
