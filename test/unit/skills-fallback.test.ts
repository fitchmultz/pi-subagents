import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  discoverAvailableSkills,
  resolveSkills,
  resolveSkillsWithFallback,
} from "../../src/agents/skills.ts";

let tempDir = "";

function makeProjectSkill(cwd: string, name: string, body: string): void {
  const skillDir = path.join(cwd, ".pi", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\ndescription: Test description\n---\n\n${body}\n`,
    "utf-8",
  );
}

function makeProjectPackageSkill(
  cwd: string,
  packageName: string,
  name: string,
  body: string,
): void {
  const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
  makePackageSkill(packageRoot, name, body, packageName);
}

function makePackageSkill(
  packageRoot: string,
  name: string,
  body: string,
  packageName = `${name}-pkg`,
): void {
  const skillDir = path.join(packageRoot, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

function runSkillsFresh(source: string): void {
  const moduleUrl = new URL("../../src/agents/skills.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { discoverAvailableSkills, resolveSkills } from ${JSON.stringify(moduleUrl)};
    const tempDir = ${JSON.stringify(tempDir)};
    ${source}
  `,
    ],
    { cwd: tempDir, encoding: "utf-8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

describe("skills filesystem fallback", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-fallback-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not leak npm discovery warnings to stderr", () => {
    const binDir = path.join(tempDir, "bin");
    const fakeNpm = path.join(binDir, "npm");
    const invoked = path.join(tempDir, "npm-invoked");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      fakeNpm,
      `#!/bin/sh\nprintf '%s\\n' "$*" > '${invoked}'\nprintf 'synthetic npm warning\\n' >&2\nprintf '%s\\n' '${tempDir}'\n`,
    );
    fs.chmodSync(fakeNpm, 0o755);

    const moduleUrl = new URL("../../src/agents/skills.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
			import { discoverAvailableSkills } from ${JSON.stringify(moduleUrl)};
			discoverAvailableSkills(process.cwd());
		`,
      ],
      {
        cwd: tempDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          HOME: path.join(tempDir, "home"),
          USERPROFILE: path.join(tempDir, "home"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(invoked, "utf-8"), "root -g\n");
    assert.doesNotMatch(result.stderr, /synthetic npm warning/);
  });

  it("resolves and reads skill content via filesystem fallback", () => {
    makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

    const discovered = discoverAvailableSkills(tempDir).find(
      (skill) => skill.name === "resolve-skill",
    );
    assert.ok(discovered, "expected resolve-skill to be discovered");
    assert.equal(discovered.source, "project");
    assert.equal(discovered.description, "Test description");
    const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.name, "resolve-skill");
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
  });

  it("does not expose pi-subagents as a child-injectable skill", () => {
    makeProjectSkill(tempDir, "pi-subagents", "Parent orchestration only.");
    makeProjectSkill(tempDir, "safe-bash", "Use safe bash.");

    const available = new Set(discoverAvailableSkills(tempDir).map((skill) => skill.name));
    assert.equal(available.has("pi-subagents"), false);
    assert.equal(available.has("safe-bash"), true);

    const { resolved, missing } = resolveSkills(["pi-subagents", "safe-bash"], tempDir);
    assert.deepEqual(missing, ["pi-subagents"]);
    assert.deepEqual(
      resolved.map((skill) => skill.name),
      ["safe-bash"],
    );
  });

  it("prefers project skills over project-package skills with the same name", () => {
    makeProjectPackageSkill(tempDir, "test-skill-package", "shared-skill", "Package version");
    runSkillsFresh(`
      const discovered = discoverAvailableSkills(tempDir).find((skill) => skill.name === "shared-skill");
      assert.ok(discovered, "expected shared-skill to be discovered");
      assert.equal(discovered.source, "project-package");
    `);
    makeProjectSkill(tempDir, "shared-skill", "Project version");

    const { resolved, missing } = resolveSkills(["shared-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Project version/);
  });

  it("discovers skills from project settings packages", () => {
    const packageRoot = path.join(tempDir, ".pi", "packages", "local-skill-pkg");
    makePackageSkill(packageRoot, "settings-package-skill", "Settings package skill.");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["./packages/local-skill-pkg"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(["settings-package-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("discovers skills from the current cwd package", () => {
    makePackageSkill(tempDir, "cwd-package-skill", "Cwd package skill.");

    const { resolved, missing } = resolveSkills(["cwd-package-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
    makeProjectPackageSkill(
      tempDir,
      "installed-skill-package",
      "cwd-package-skill",
      "Installed package wins equal-priority ties.",
    );
    runSkillsFresh(`
      const collision = resolveSkills(["cwd-package-skill"], tempDir);
      assert.deepEqual(collision.missing, []);
      assert.match(collision.resolved[0]?.content ?? "", /Installed package wins equal-priority ties/);
    `);
  });

  it("falls back to the runtime cwd when the execution cwd lacks the skill", () => {
    const nestedDir = path.join(tempDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    makePackageSkill(tempDir, "runtime-fallback-skill", "Runtime fallback skill.");

    const { resolved, missing } = resolveSkillsWithFallback(
      ["runtime-fallback-skill"],
      nestedDir,
      tempDir,
    );
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("discovers user settings package sources and strictly reads declared npm manifests", () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      for (const [source, installedPath] of [
        [{ source: "./user-pkg" }, "user-pkg"],
        ["git:github.com/user/repo.git@main", "git/github.com/user/repo"],
        [{ source: "npm:@scope/skill-package@latest" }, "npm/node_modules/@scope/skill-package"],
      ] as const) {
        const fakeHome = fs.mkdtempSync(path.join(tempDir, "home-"));
        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;
        const userAgentDir = path.join(fakeHome, ".pi", "agent");
        const packageRoot = path.join(userAgentDir, installedPath);
        makePackageSkill(
          packageRoot,
          "user-settings-package-skill",
          "User settings package skill.",
        );
        fs.writeFileSync(
          path.join(userAgentDir, "settings.json"),
          JSON.stringify({ packages: [source] }),
          "utf-8",
        );
        runSkillsFresh(`
          import * as fs from "node:fs";
          import * as path from "node:path";
          const discovered = discoverAvailableSkills(tempDir);
          const skill = discovered.find((entry) => entry.name === "user-settings-package-skill");
          assert.ok(skill);
          assert.equal(skill.source, "user-package");
          fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
          fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{untrusted-project", "utf-8");
          const untrusted = resolveSkills(["user-settings-package-skill"], tempDir, { projectTrusted: false });
          assert.deepEqual(untrusted.missing, []);
          assert.equal(untrusted.resolved[0]?.source, "user-package");
        `);
        if (installedPath.startsWith("npm/")) {
          fs.writeFileSync(path.join(packageRoot, "package.json"), "{bad-json", "utf-8");
          runSkillsFresh(`
            assert.throws(
              () => discoverAvailableSkills(tempDir, { projectTrusted: false }),
              /Failed to read package manifest .*skill-package.*package.json/,
            );
          `);
        }
        fs.rmSync(path.join(tempDir, ".pi"), { recursive: true, force: true });
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
  it("surfaces malformed project settings files instead of silently ignoring them", () => {
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

    assert.throws(
      () => resolveSkills(["missing-skill"], tempDir),
      /Failed to read skills settings file .+\.pi[\\/]settings\.json/,
    );
  });

  it("surfaces malformed explicit settings package manifests instead of silently ignoring them", () => {
    const packageRoot = path.join(tempDir, ".pi", "packages", "broken-package");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), "{bad-json", "utf-8");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["./packages/broken-package"] }, null, 2),
      "utf-8",
    );

    assert.throws(
      () => discoverAvailableSkills(tempDir),
      /Failed to read package manifest .+broken-package[\\/]package\.json/,
    );
  });
});
