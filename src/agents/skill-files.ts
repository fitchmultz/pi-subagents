import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalNpmRoot } from "./skill-search-paths.ts";
import type {
  SkillSource,
  SkillSearchPath,
  CachedSkillEntry,
  ResolvedSkill,
} from "./skill-types.ts";

const skillCache = new Map<string, { mtime: number; skill: ResolvedSkill }>();
const MAX_CACHE_SIZE = 50;

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return normalized;
  }
  const end = normalized.indexOf("\n---", 3);
  return end === -1 ? normalized : normalized.slice(end + 4).trim();
}

function isWithinPath(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inferSource(
  filePath: string,
  cwd: string,
  agentDir: string,
  hint?: SkillSource,
): SkillSource {
  if (hint !== undefined) {
    return hint;
  }
  const roots: { path: string; source: SkillSource }[] = [
    { path: path.resolve(cwd, ".pi", "npm", "node_modules"), source: "project-package" },
    { path: path.resolve(cwd, ".pi", "skills"), source: "project" },
    { path: path.resolve(cwd, ".agents"), source: "project" },
    { path: path.resolve(cwd, ".pi"), source: "project-settings" },
    { path: path.resolve(agentDir, "npm", "node_modules"), source: "user-package" },
    { path: path.resolve(agentDir, "skills"), source: "user" },
    { path: path.resolve(os.homedir(), ".agents"), source: "user" },
    { path: path.resolve(agentDir), source: "user-settings" },
  ];
  const matched = roots.find((root) => isWithinPath(filePath, root.path));
  if (matched !== undefined) {
    return matched.source;
  }
  const globalRoot = getGlobalNpmRoot();
  return globalRoot !== null && globalRoot.length > 0 && isWithinPath(filePath, globalRoot)
    ? "user-package"
    : "unknown";
}

function description(filePath: string): string | undefined {
  try {
    const normalized = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) {
      return undefined;
    }
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) {
      return undefined;
    }
    return normalized
      .slice(3, end)
      .trim()
      .match(/^description:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "");
  } catch {
    // Descriptions are optional metadata; failure does not hide an otherwise readable skill.
    return undefined;
  }
}

function childSkills(dir: string): { name: string; filePath: string }[] {
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return children.flatMap((child) => {
    if (child.name.startsWith(".")) {
      return [];
    }
    const childPath = path.join(dir, child.name);
    if (child.isDirectory() || child.isSymbolicLink()) {
      return [{ name: child.name, filePath: path.join(childPath, "SKILL.md") }];
    }
    return child.isFile() && child.name.toLowerCase().endsWith(".md")
      ? [{ name: path.basename(child.name, path.extname(child.name)), filePath: childPath }]
      : [];
  });
}

function pathSkills(skillPath: string): { name: string; filePath: string }[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    const fileName = path.basename(skillPath);
    if (!fileName.toLowerCase().endsWith(".md")) {
      return [];
    }
    const name =
      fileName.toLowerCase() === "skill.md"
        ? path.basename(path.dirname(skillPath))
        : path.basename(fileName, path.extname(fileName));
    return [{ name, filePath: skillPath }];
  }
  return stat.isDirectory()
    ? [
        { name: path.basename(skillPath), filePath: path.join(skillPath, "SKILL.md") },
        ...childSkills(skillPath),
      ]
    : [];
}

export function collectFilesystemSkills(
  cwd: string,
  agentDir: string,
  skillPaths: readonly SkillSearchPath[],
): CachedSkillEntry[] {
  const entries: CachedSkillEntry[] = [];
  const seen = new Set<string>();
  for (const skillPath of skillPaths) {
    for (const entry of pathSkills(skillPath.path)) {
      const filePath = path.resolve(entry.filePath);
      if (seen.has(filePath) || !fs.existsSync(filePath)) {
        continue;
      }
      seen.add(filePath);
      entries.push({
        name: entry.name,
        filePath,
        source: inferSource(filePath, cwd, agentDir, skillPath.source),
        description: description(filePath),
        order: entries.length,
      });
    }
  }
  return entries;
}

export function readSkill(
  skillName: string,
  skillPath: string,
  source: SkillSource,
): ResolvedSkill | undefined {
  try {
    const stat = fs.statSync(skillPath);
    const cached = skillCache.get(skillPath);
    if (cached !== undefined && cached.mtime === stat.mtimeMs) {
      return cached.skill;
    }
    const skill = {
      name: skillName,
      path: skillPath,
      content: stripFrontmatter(fs.readFileSync(skillPath, "utf-8")),
      source,
    };
    skillCache.set(skillPath, { mtime: stat.mtimeMs, skill });
    if (skillCache.size > MAX_CACHE_SIZE) {
      const firstKey = skillCache.keys().next().value;
      if (firstKey !== undefined && firstKey.length > 0) {
        skillCache.delete(firstKey);
      }
    }
    return skill;
  } catch {
    // Resolution surfaces unreadable files as missing rather than failing the invocation.
    return undefined;
  }
}
