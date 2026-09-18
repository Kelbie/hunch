import { repoPath } from "./path.js";
import type { RepoReader } from "./load/index.js";
import { type Lock, sha256 } from "./lock.js";
import type { Config, SkillSource } from "./schema.js";

/** One document the compiler turns into rules. */
export interface SourceDoc {
  id: string;
  kind: "skill" | "agents-md" | "doc";
  origin: string;
  commit?: string;
  path: string;
  scope: string;
  /** SKILL.md plus its references/*.md, or AGENTS.md with @includes inlined. */
  text: string;
}

/** Where `npx skills add` installs project skills (cross-agent first). */
export const INSTALLED_SKILL_DIRS = [".agents/skills", ".claude/skills"];

const MAX_DOC_CHARS = 400_000;

export interface RemoteFetcher {
  /** Resolves a ref (branch/tag/sha, default branch when omitted) to a commit sha. */
  commit(repo: string, ref?: string): Promise<string>;
  /** All file paths in the repo at `commit`. */
  tree(repo: string, commit: string): Promise<string[]>;
  read(repo: string, commit: string, path: string): Promise<string>;
}

/** Public GitHub, unauthenticated or with GITHUB_TOKEN. */
export function githubFetcher(token = process.env.GITHUB_TOKEN): RemoteFetcher {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "hunch" };
  if (token) headers.authorization = `Bearer ${token}`;
  const api = async <T>(url: string): Promise<T> => {
    const res = await fetch(`https://api.github.com${url}`, { headers });
    if (!res.ok) throw new Error(`GitHub ${url}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  };
  return {
    async commit(repo, ref) {
      const r = ref ?? (await api<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
      return (await api<{ sha: string }>(`/repos/${repo}/commits/${encodeURIComponent(r)}`)).sha;
    },
    async tree(repo, commit) {
      const t = await api<{ tree: { path: string; type: string }[]; truncated?: boolean }>(`/repos/${repo}/git/trees/${commit}?recursive=1`);
      if (t.truncated) throw new Error("Remote skill tree is truncated; select a smaller source repository");
      return t.tree.filter((e) => e.type === "blob").map((e) => e.path);
    },
    async read(repo, commit, path) {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`fetch ${repo}/${path}@${commit}: ${res.status}`);
      return res.text();
    },
  };
}

type ParsedSource =
  | { type: "local"; path: string; glob: boolean }
  | { type: "remote"; repo: string; ref?: string; path?: string; skill?: string };

/**
 * Accepts the same source spellings as `npx skills add`:
 *   "./skills/*"  "./skills/seo"                       local
 *   "owner/repo"  { repo: "owner/repo", skill: "seo" }  GitHub shorthand
 *   "https://github.com/owner/repo[/tree/<ref>/<path>]" GitHub URL
 */
export function parseSkillSource(src: SkillSource): ParsedSource {
  if (typeof src !== "string") return { type: "remote", repo: src.repo, ref: src.ref, skill: src.skill };
  const url = src.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/);
  if (url) return { type: "remote", repo: url[1]!, ref: url[2], path: url[3] };
  if (/^[\w.-]+\/[\w.-]+$/.test(src) && !src.startsWith(".")) return { type: "remote", repo: src };
  const path = repoPath(src.replace(/\/$/, ""));
  return path.endsWith("/*") ? { type: "local", path: path.slice(0, -2), glob: true } : { type: "local", path, glob: false };
}

const frontmatterName = (md: string) => md.match(/^---\s*\n[\s\S]*?^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();

/** Collects every document that should be compiled, in a stable order. */
export async function collectSources(config: Config, repo: RepoReader, remote: RemoteFetcher = githubFetcher()): Promise<SourceDoc[]> {
  const docs: SourceDoc[] = [];
  const seenSkills = new Set<string>();
  const addSkill = (doc: SourceDoc) => {
    if (seenSkills.has(doc.id)) {
      if (config.skills.length) throw new Error(`Duplicate skill name: ${doc.id}. Select unique skill names.`);
      return;
    }
    seenSkills.add(doc.id);
    docs.push(doc);
  };

  const sources: SkillSource[] = config.skills.length ? config.skills : INSTALLED_SKILL_DIRS.map((d) => `./${d}/*`);
  const allFiles = await repo.files();

  for (const src of sources) {
    const p = parseSkillSource(src);
    if (p.type === "local") {
      const dirs = p.glob ? (await repo.list(p.path)).filter((e) => e.type === "dir").map((e) => `${p.path}/${e.name}`) : [p.path];
      for (const dir of dirs) {
        const skillMd = await repo.read(`${dir}/SKILL.md`);
        if (skillMd == null) {
          if (!p.glob) throw new Error(`Skill not found: ${dir}/SKILL.md`);
          continue;
        }
        const refs = (await walkMarkdown(repo, dir)).filter((p) => !p.endsWith("/SKILL.md")).sort();
        const parts = [skillMd];
        for (const r of refs) parts.push(`\n\n<!-- ${r.slice(dir.length + 1)} -->\n${(await repo.read(r)) ?? ""}`);
        const name = frontmatterName(skillMd) ?? dir.split("/").at(-1)!;
        addSkill({ id: `skill/${name}`, kind: "skill", origin: `./${dir}`, path: `${dir}/SKILL.md`, scope: "", text: cap(parts.join("")) });
      }
    } else {
      const commit = await remote.commit(p.repo, p.ref);
      const tree = await remote.tree(p.repo, commit);
      const base = p.path ? `${p.path.replace(/\/$/, "")}/` : "";
      const skillFiles = tree.filter((f) => f.startsWith(base) && (f === `${base}SKILL.md` || f.endsWith("/SKILL.md")));
      for (const file of skillFiles) {
        const dir = file === "SKILL.md" ? "" : file.slice(0, -"/SKILL.md".length);
        const prefix = dir ? `${dir}/` : "";
        const md = await remote.read(p.repo, commit, file);
        const name = frontmatterName(md) ?? (dir.split("/").at(-1) || p.repo.split("/")[1]!);
        if (p.skill && p.skill !== name && p.skill !== dir.split("/").at(-1)) continue;
        const refs = tree.filter((f) => f.startsWith(prefix) && f !== file && f.endsWith(".md") && !f.endsWith("/SKILL.md")).sort();
        const parts = [md];
        for (const r of refs) parts.push(`\n\n<!-- ${r.slice(prefix.length)} -->\n${await remote.read(p.repo, commit, r)}`);
        addSkill({ id: `skill/${name}`, kind: "skill", origin: p.repo, commit, path: file, scope: "", text: cap(parts.join("")) });
      }
      if (p.skill && !docs.some((d) => d.origin === p.repo && d.id === `skill/${p.skill}`))
        throw new Error(`skill "${p.skill}" not found in ${p.repo}@${commit.slice(0, 7)}`);
    }
  }

  if (config.agentsMd) {
    const agentFiles = allFiles.filter((f) => f === "AGENTS.md" || f.endsWith("/AGENTS.md")).sort();
    for (const f of agentFiles) {
      const scope = f === "AGENTS.md" ? "" : f.slice(0, -"/AGENTS.md".length);
      const applicable = agentFiles.filter((parent) => parent === "AGENTS.md" || f === parent || f.startsWith(parent.slice(0, -"AGENTS.md".length))).sort((a, b) => a.split("/").length - b.split("/").length);
      const text = (await Promise.all(applicable.map(async (parent) => `\n# Guidance from ${parent}\n${await inlineIncludes(repo, parent)}`))).join("\n");
      if (text.length > 40_000) throw new Error(`Effective AGENTS guidance for ${f} exceeds 40 KB; shorten it before compilation`);
      docs.push({ id: `agents-md/${scope || "root"}`, kind: "agents-md", origin: `./${f}`, path: f, scope, text: cap(text) });
    }
  }

  for (const d of config.docs) {
    const path = d.replace(/^\.\//, "");
    const text = await repo.read(path);
    if (text == null) throw new Error(`docs: ${d} not found`);
    docs.push({ id: `doc/${path.replace(/\.md$/i, "")}`, kind: "doc", origin: `./${path}`, path, scope: "", text: cap(text) });
  }
  return docs;
}

/** Recursive listing via `list` (follows installed-skill symlinks, unlike `files()`). */
async function walkMarkdown(repo: RepoReader, dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) throw new Error("Skill directory nesting exceeds 4 levels");
  const out: string[] = [];
  for (const e of await repo.list(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.type === "dir") out.push(...(await walkMarkdown(repo, p, depth + 1)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Inlines `@path` lines (the CLAUDE.md → `@AGENTS.md` import convention), one level deep. */
async function inlineIncludes(repo: RepoReader, file: string): Promise<string> {
  const text = (await repo.read(file)) ?? "";
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^@(\S+\.md)\s*$/);
    const included = m ? await repo.read(`${dir}${m[1]}`) : null;
    if (m && included === null) throw new Error(`Missing guidance include in ${file}: ${m[1]}`);
    out.push(included ?? line);
  }
  return out.join("\n");
}

const cap = (s: string) => {
  if (s.length > MAX_DOC_CHARS) throw new Error("Guidance exceeds 400 KB; select a smaller skill or document");
  return s;
};

export const hashDoc = (d: SourceDoc) => sha256(`${d.kind}\n${d.origin}\n${d.commit ?? ""}\n${d.path}\n${d.scope}\n${d.text}`);

/**
 * Compares the lock with the current sources. Remote skills are pinned by
 * commit, so only local skills, AGENTS.md and docs can drift. Returns ids that
 * are new, changed or gone.
 */
export async function staleSources(lock: Lock | null, config: Config, repo: RepoReader): Promise<string[]> {
  const localOnly = { ...config, skills: config.skills.filter((s) => parseSkillSource(s).type === "local") };
  if (config.skills.length && !localOnly.skills.length) localOnly.skills = ["./.hunch-no-local-skills/*"];
  const docs = await collectSources(localOnly, repo, noRemote);
  const byId = new Map((lock?.sources ?? []).map((s) => [s.id, s]));
  const stale: string[] = [];
  if (lock && (!lock.selectionHash && config.skills.some((s) => parseSkillSource(s).type === "remote") || lock.selectionHash && lock.selectionHash !== await selectionHash(config))) stale.push("guidance selection");
  const remoteSources = config.skills.map(parseSkillSource).filter((s) => s.type === "remote");
  for (const source of remoteSources) {
    if (!lock?.sources.some((s) => s.commit && s.origin === source.repo && (!source.skill || s.id === `skill/${source.skill}`) && (!source.path || s.path.startsWith(`${source.path}/`)) && (!source.ref || !/^[a-f0-9]{40}$/.test(source.ref) || s.commit === source.ref))) stale.push(`remote/${source.repo}`);
  }
  for (const source of lock?.sources ?? []) {
    if (source.commit && !remoteSources.some((s) => s.repo === source.origin && (!s.skill || source.id === `skill/${s.skill}`))) stale.push(source.id);
  }
  for (const d of docs) {
    if (byId.get(d.id)?.hash !== (await hashDoc(d))) stale.push(d.id);
    byId.delete(d.id);
  }
  for (const [id, s] of byId) if (!s.commit) stale.push(id);
  return stale;
}

const noRemote: RemoteFetcher = {
  commit: () => Promise.reject(new Error("remote fetch disabled")),
  tree: () => Promise.reject(new Error("remote fetch disabled")),
  read: () => Promise.reject(new Error("remote fetch disabled")),
};

export const selectionHash = (config: Config) => sha256(JSON.stringify({ skills: config.skills, agentsMd: config.agentsMd, docs: config.docs }));
