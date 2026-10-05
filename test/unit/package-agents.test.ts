import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

test("configured package profiles are read-only fallbacks, trust gated and rediscovered", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ps-profiles-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "user");
  const project = join(root, "project");
  const nested = join(project, "src");
  const profiles = join(root, "package", "profiles");
  for (const dir of [
    agentDir,
    join(agentDir, "agents"),
    join(project, ".pi", "agents"),
    nested,
    profiles,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const profile = (description: string) =>
    `---\nname: scoped-specialist\ndescription: ${description}\ntools: read\nsystemPromptMode: replace\n---\nPackage specialist instructions.\n`;
  writeFileSync(join(profiles, "specialist.md"), profile("package"));
  writeFileSync(
    join(root, "package", "package.json"),
    JSON.stringify({ name: "@example/profiles", subagents: { agents: ["profiles"] } }),
  );
  const settings = JSON.stringify({ packages: [join(root, "package")] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(join(agentDir, "settings.json"), settings);
    const selected = () =>
      discoverAgents(nested, "both", { projectTrusted: true }).agents.find(
        (a) => a.name === "scoped-specialist",
      );
    assert.equal(selected()?.description, "package");
    assert.equal(selected()?.source, "package");
    assert.equal(selected()?.systemPromptMode, "replace");
    assert.deepEqual(selected()?.tools, ["read"]);
    writeFileSync(join(agentDir, "agents", "specialist.md"), profile("user"));
    assert.equal(selected()?.description, "user");
    writeFileSync(join(project, ".pi", "agents", "specialist.md"), profile("project"));
    assert.equal(selected()?.description, "project");
    assert.equal(
      discoverAgents(nested, "both", { projectTrusted: false }).agents.find(
        (a) => a.name === "scoped-specialist",
      )?.description,
      "user",
    );
    assert.equal(discoverAgentsAll(nested).package.length, 1);
    rmSync(join(agentDir, "agents", "specialist.md"));
    writeFileSync(join(agentDir, "settings.json"), "{}");
    writeFileSync(join(project, ".pi", "settings.json"), settings);
    assert.equal(
      discoverAgents(nested, "user").agents.some((a) => a.name === "scoped-specialist"),
      false,
    );
    assert.equal(
      discoverAgents(nested, "project", { projectTrusted: false }).agents.some(
        (a) => a.name === "scoped-specialist",
      ),
      false,
    );
    rmSync(join(project, ".pi", "agents", "specialist.md"));
    assert.equal(selected()?.description, "package");
    writeFileSync(join(project, ".pi", "settings.json"), "{}");
    assert.equal(selected(), undefined, "Removing a declaration must not leave stale profiles");
    await t.test(
      "distinct configured roots with the same manifest name retain their unique profiles",
      () => {
        const second = join(root, "second-package");
        mkdirSync(join(second, "profiles"), { recursive: true });
        writeFileSync(
          join(second, "package.json"),
          JSON.stringify({ name: "@example/profiles", subagents: { agents: ["profiles"] } }),
        );
        writeFileSync(
          join(second, "profiles", "second.md"),
          profile("second package").replace("name: scoped-specialist", "name: second-specialist"),
        );
        writeFileSync(
          join(agentDir, "settings.json"),
          JSON.stringify({ packages: [join(root, "package"), second] }),
        );
        assert.deepEqual(
          discoverAgents(nested, "both")
            .agents.filter((a) => a.source === "package")
            .map((a) => a.name)
            .sort(),
          ["scoped-specialist", "second-specialist"],
        );
        writeFileSync(join(agentDir, "settings.json"), settings);
        writeFileSync(
          join(project, ".pi", "settings.json"),
          JSON.stringify({ packages: [second] }),
        );
        assert.deepEqual(
          discoverAgentsAll(nested)
            .package.map((a) => a.name)
            .sort(),
          ["scoped-specialist", "second-specialist"],
          "Distinct local identities must survive across scopes too",
        );
        writeFileSync(join(project, ".pi", "settings.json"), "{}");
      },
    );
    await t.test("malformed packaged profiles have diagnostics that clear after repair", () => {
      writeFileSync(join(agentDir, "settings.json"), settings);
      const malformed = join(profiles, "malformed.md");
      writeFileSync(malformed, "---\nname: broken-specialist\n---\nMissing description.\n");
      assert.deepEqual(discoverAgentsAll(nested).agentDiagnostics, [
        {
          source: "package",
          filePath: malformed,
          error: "frontmatter must include name and description",
        },
      ]);
      writeFileSync(join(project, ".pi", "settings.json"), settings);
      const shared = discoverAgentsAll(nested);
      assert.equal(
        shared.package.length,
        1,
        "The same local package in both scopes must load once",
      );
      assert.equal(
        shared.agentDiagnostics.length,
        1,
        "The same malformed package profile must be reported once",
      );
      writeFileSync(join(project, ".pi", "settings.json"), "{}");
      writeFileSync(
        malformed,
        profile("repaired").replace("name: scoped-specialist", "name: repaired-specialist"),
      );
      const repaired = discoverAgentsAll(nested);
      assert.deepEqual(repaired.agentDiagnostics, []);
      assert.ok(repaired.package.some((a) => a.name === "repaired-specialist"));
      rmSync(malformed);
    });
    await t.test(
      "project npm and Git identities shadow user versions, except resource deltas",
      () => {
        const cases = [
          {
            userSource: "npm:@example/shared-profiles@2.0.0",
            projectSource: "npm:@example/shared-profiles@1.0.0",
            userRoot: join(agentDir, "npm", "node_modules", "@example", "shared-profiles"),
            projectRoot: join(project, ".pi", "npm", "node_modules", "@example", "shared-profiles"),
          },
          {
            userSource: "git:github.com/example/shared-profiles@new",
            projectSource: "git:git@github.com:example/shared-profiles.git@old",
            userRoot: join(agentDir, "git", "github.com", "example", "shared-profiles"),
            projectRoot: join(project, ".pi", "git", "github.com", "example", "shared-profiles"),
          },
          {
            userSource: "https://github.com/example/shared-profiles.git#new",
            projectSource: "ssh://git@github.com/example/shared-profiles.git@old",
            userRoot: join(agentDir, "git", "github.com", "example", "shared-profiles"),
            projectRoot: join(project, ".pi", "git", "github.com", "example", "shared-profiles"),
          },
          {
            userSource: "git:HTTPS://github.com/example/shared-profiles.git#new",
            projectSource: "git:SSH://git@github.com/example/shared-profiles.git@old",
            userRoot: join(agentDir, "git", "github.com", "example", "shared-profiles"),
            projectRoot: join(project, ".pi", "git", "github.com", "example", "shared-profiles"),
          },
        ];
        for (const row of cases) {
          for (const [base, side] of [
            [row.userRoot, "user"],
            [row.projectRoot, "project"],
          ] as const) {
            mkdirSync(join(base, "profiles"), { recursive: true });
            writeFileSync(
              join(base, "package.json"),
              JSON.stringify({
                name: "@example/shared-profiles",
                subagents: { agents: ["profiles"] },
              }),
            );
            writeFileSync(join(base, "profiles", "shared.md"), profile(`${side} version`));
            writeFileSync(
              join(base, "profiles", "unique.md"),
              profile(`${side} only`).replace("name: scoped-specialist", `name: ${side}-only`),
            );
          }
          writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: [row.userSource] }),
          );
          writeFileSync(
            join(project, ".pi", "settings.json"),
            JSON.stringify({ packages: [row.projectSource] }),
          );
          const names = (scope: "user" | "project" | "both" = "both", projectTrusted = true) =>
            discoverAgents(nested, scope, { projectTrusted })
              .agents.filter((a) => a.source === "package")
              .map((a) => a.name)
              .sort();
          assert.deepEqual(names(), ["project-only", "scoped-specialist"], row.projectSource);
          assert.equal(selected()?.description, "project version");
          assert.equal(discoverAgentsAll(nested).package.length, 2);
          assert.deepEqual(names("user"), ["scoped-specialist", "user-only"]);
          assert.deepEqual(names("project"), ["project-only", "scoped-specialist"]);
          assert.deepEqual(names("both", false), ["scoped-specialist", "user-only"]);
          writeFileSync(
            join(project, ".pi", "settings.json"),
            JSON.stringify({
              packages: [
                { source: row.projectSource, autoload: false, skills: ["+selected-skill"] },
              ],
            }),
          );
          assert.deepEqual(
            names(),
            ["scoped-specialist", "user-only"],
            "A native resource delta must not replace global package profiles",
          );
          assert.equal(selected()?.description, "user version");
          assert.equal(discoverAgentsAll(nested).package.length, 2);
        }
        writeFileSync(join(project, ".pi", "settings.json"), "{}");
      },
    );
    await t.test(
      "local declarations in native stores remain distinct from remote identities",
      () => {
        const cases = [
          {
            userRoot: join(agentDir, "npm", "node_modules", "@example", "shared-profiles"),
            projectRoot: join(project, ".pi", "npm", "node_modules", "@example", "shared-profiles"),
            projectSource: "npm:@example/shared-profiles@1.0.0",
          },
          {
            userRoot: join(agentDir, "git", "github.com", "example", "shared-profiles"),
            projectRoot: join(project, ".pi", "git", "github.com", "example", "shared-profiles"),
            projectSource: "git:github.com/example/shared-profiles@old",
          },
          {
            userRoot: join(agentDir, "git:local"),
            projectRoot: join(project, ".pi", "git:local"),
            userSource: "git:local",
            projectSource: "git:local",
          },
        ];
        for (const row of cases) {
          for (const [base, name] of [
            [row.userRoot, "local-user"],
            [row.projectRoot, "project-only"],
          ] as const) {
            rmSync(base, { recursive: true, force: true });
            mkdirSync(join(base, "profiles"), { recursive: true });
            writeFileSync(
              join(base, "package.json"),
              JSON.stringify({
                name: "@example/shared-profiles",
                subagents: { agents: ["profiles"] },
              }),
            );
            writeFileSync(
              join(base, "profiles", "unique.md"),
              profile(name).replace("name: scoped-specialist", `name: ${name}`),
            );
          }
          writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: [row.userSource ?? row.userRoot] }),
          );
          writeFileSync(
            join(project, ".pi", "settings.json"),
            JSON.stringify({ packages: [row.projectSource] }),
          );
          assert.deepEqual(
            discoverAgentsAll(nested)
              .package.map((a) => a.name)
              .sort(),
            ["local-user", "project-only"],
            row.projectSource,
          );
          assert.deepEqual(
            discoverAgents(nested, "both")
              .agents.filter((a) => a.source === "package")
              .map((a) => a.name)
              .sort(),
            ["local-user", "project-only"],
          );
        }
        writeFileSync(join(project, ".pi", "settings.json"), "{}");
      },
    );
    writeFileSync(
      join(root, "package", "package.json"),
      JSON.stringify({ name: "@example/profiles", subagents: { agents: ["../user"] } }),
    );
    writeFileSync(join(agentDir, "settings.json"), settings);
    assert.throws(selected, /package.*agents.*relative/i);
  } finally {
    if (saved === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = saved;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
