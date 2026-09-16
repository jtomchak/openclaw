import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/build-and-restart-mac-gateway.sh";
const wrapperSource = "scripts/lib/run-current-gateway-release.sh";

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function runGit(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function runReleaseFixture(scenario: "success" | "install-failure") {
  const root = mkdtempSync(join(tmpdir(), "openclaw-build-restart-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const releaseRoot = join(root, "runtime-builds");
  const stateFile = join(root, "service-state");
  const oldEntry = join(repo, "dist", "index.js");
  const home = join(root, "home");
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(repo, "scripts", "build-and-restart-mac-gateway.sh"),
    readFileSync(scriptPath),
  );
  writeFileSync(
    join(repo, "scripts", "lib", "run-current-gateway-release.sh"),
    readFileSync(wrapperSource),
  );
  chmodSync(join(repo, "scripts", "build-and-restart-mac-gateway.sh"), 0o755);
  chmodSync(join(repo, "scripts", "lib", "run-current-gateway-release.sh"), 0o755);
  writeFileSync(join(repo, "package.json"), '{"packageManager":"pnpm@11.15.1"}\n');
  writeFileSync(join(home, "Library", "LaunchAgents", "ai.openclaw.gateway.plist"), "fixture\n");
  writeFileSync(
    oldEntry,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "gateway" && args[1] === "install") {
  const wrapper = args[args.indexOf("--wrapper") + 1];
  fs.writeFileSync(${JSON.stringify(stateFile)}, "300|" + wrapper + "\\n");
}
`,
  );
  writeFileSync(
    join(root, "candidate-index.js"),
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "validate") process.exit(0);
if (args[0] === "gateway" && args[1] === "install") {
  const wrapper = args[args.indexOf("--wrapper") + 1];
  fs.writeFileSync(${JSON.stringify(stateFile)}, "200|" + wrapper + "\\n");
  if (process.env.SCENARIO === "install-failure") process.exit(42);
}
`,
  );
  writeExecutable(join(bin, "uname"), `printf 'Darwin\\n'`);
  writeExecutable(
    join(bin, "plutil"),
    `printf '%s\\n' ${JSON.stringify(JSON.stringify(["/usr/bin/node", oldEntry, "gateway", "--port", "18789"]))}`,
  );
  writeExecutable(
    join(bin, "launchctl"),
    `if [[ -f "$FIXTURE/service-state" ]]; then
  IFS='|' read -r pid wrapper < "$FIXTURE/service-state"
  printf 'pid = %s\\n%s\\n' "$pid" "$wrapper"
else
  printf 'pid = 100\\n%s\\n' ${JSON.stringify(oldEntry)}
fi`,
  );
  writeExecutable(join(bin, "curl"), `printf '{"ready":true,"failing":[]}\\n'`);
  writeExecutable(join(bin, "lsof"), "exit 0");
  writeExecutable(
    join(bin, "corepack"),
    `[[ "$1 $2 $4" == "enable --install-directory pnpm" ]]
ln -s "$FIXTURE/bin/selected-pnpm" "$3/pnpm"`,
  );
  writeExecutable(
    join(bin, "selected-pnpm"),
    `case "$1" in
  install) exit 0 ;;
  build)
    grep -F '"releaseMarker":"dirty"' package.json >/dev/null
    [[ "$(<release-marker.txt)" == staged-new-source ]]
    mkdir -p dist
    cp "$FIXTURE/candidate-index.js" dist/index.js
    commit="$(git rev-parse HEAD)"
    printf '{"commit":"%s"}\\n' "$commit" > dist/build-info.json
    ;;
  *) exit 90 ;;
esac`,
  );
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.name", "OpenClaw Test"]);
  runGit(repo, ["config", "user.email", "test@openclaw.invalid"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-qm", "fixture"]);
  writeFileSync(
    join(repo, "package.json"),
    '{"packageManager":"pnpm@11.15.1","releaseMarker":"dirty"}\n',
  );
  writeFileSync(join(repo, "release-marker.txt"), "staged-new-source\n");
  runGit(repo, ["add", "release-marker.txt"]);

  const result = spawnSync(
    "/bin/bash",
    [join(repo, "scripts", "build-and-restart-mac-gateway.sh"), "--release-root", releaseRoot],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        FIXTURE: root,
        SCENARIO: scenario,
      },
    },
  );
  return { oldTarget: repo, releaseRoot, result, root, stateFile };
}

describe("build-and-restart macOS Gateway release workflow", () => {
  it("documents the immutable build and rollback contract", () => {
    const result = spawnSync("/bin/bash", [scriptPath, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("immutable release worktree");
    expect(result.stdout).toContain("roll back to the previous release");
    expect(result.stdout).toContain("refuses untracked files");
  });

  it("runs the release selected by the current symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-wrapper-"));
    const bin = join(root, "bin");
    const release = join(root, "releases", "candidate");
    const fakeNode = join(root, "fake-node");
    const output = join(root, "invocation");
    mkdirSync(join(release, "dist"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(release, "dist", "index.js"), "// fixture\n");
    writeFileSync(fakeNode, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(output)}\n`);
    chmodSync(fakeNode, 0o755);
    const wrapper = join(bin, "openclaw-gateway-release");
    writeFileSync(wrapper, readFileSync(wrapperSource));
    chmodSync(wrapper, 0o755);
    symlinkSync(release, join(root, "current"));

    try {
      const result = spawnSync("/bin/bash", [wrapper, "gateway", "--port", "18789"], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_RELEASE_NODE: fakeNode },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8").trim().split("\n")).toEqual([
        join(root, "current", "dist", "index.js"),
        "gateway",
        "--port",
        "18789",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails before exec when the selected release is incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-wrapper-missing-"));
    const bin = join(root, "bin");
    const release = join(root, "releases", "candidate");
    mkdirSync(release, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "openclaw-gateway-release");
    writeFileSync(wrapper, readFileSync(wrapperSource));
    chmodSync(wrapper, 0o755);
    symlinkSync(release, join(root, "current"));

    try {
      const result = spawnSync("/bin/bash", [wrapper, "gateway"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release entry is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["success", "install-failure"] as const)(
    "activates an immutable release and handles %s",
    (scenario) => {
      const fixture = runReleaseFixture(scenario);
      try {
        expect(fixture.result.status, fixture.result.stdout + fixture.result.stderr).toBe(
          scenario === "success" ? 0 : 1,
        );
        expect(existsSync(join(fixture.releaseRoot, "bin", "openclaw-gateway-release"))).toBe(true);
        const selected = realpathSync(join(fixture.releaseRoot, "current"));
        if (scenario === "success") {
          expect(selected).toContain(join(fixture.releaseRoot, "releases"));
          expect(readFileSync(fixture.stateFile, "utf8")).toContain("200|");
          expect(fixture.result.stdout).toContain("OK release=");
        } else {
          expect(selected).toBe(fixture.oldTarget);
          expect(readFileSync(fixture.stateFile, "utf8")).toContain("300|");
          expect(fixture.result.stdout).toContain("rollback ready:");
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
