#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_RELEASE_WORKFLOW = ".github/workflows/release.yml";

function parseArgs(argv) {
  const args = { flags: new Set(), values: new Map() };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.values.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.values.set(key, next);
      index += 1;
    } else {
      args.flags.add(key);
    }
  }

  return args;
}

const cli = parseArgs(process.argv.slice(2));

function cliValue(name) {
  return cli.values.get(name);
}

function cliFlag(name) {
  return cli.flags.has(name);
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const invocation = [command, ...args].join(" ");
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${invocation}${details ? `\n${details}` : ""}`);
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function configuredProxyEnv() {
  const proxyUrl = process.env.QUANTEX_SYNC_PROXY_URL;
  const httpsProxy = process.env.QUANTEX_SYNC_HTTPS_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const httpProxy = process.env.QUANTEX_SYNC_HTTP_PROXY ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const allProxy = process.env.QUANTEX_SYNC_ALL_PROXY ?? process.env.ALL_PROXY ?? process.env.all_proxy;

  if (!proxyUrl && !httpsProxy && !httpProxy && !allProxy) {
    return null;
  }

  return {
    ...(proxyUrl ? { https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl } : {}),
    ...(httpsProxy ? { https_proxy: httpsProxy } : {}),
    ...(httpProxy ? { http_proxy: httpProxy } : {}),
    ...(allProxy ? { all_proxy: allProxy } : {}),
  };
}

function runWithNetworkRetry(command, args = [], options = {}) {
  const first = run(command, args, { ...options, allowFailure: true });
  if (first.status === 0) {
    return first;
  }

  const proxyEnv = configuredProxyEnv();
  if (!proxyEnv) {
    const invocation = [command, ...args].join(" ");
    const output = [first.stderr, first.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(`Command failed: ${invocation}${output ? `\n${output}` : ""}`);
  }

  const second = run(command, args, {
    ...options,
    allowFailure: true,
    env: { ...(options.env ?? {}), ...proxyEnv },
  });
  if (second.status === 0) {
    return second;
  }

  const invocation = [command, ...args].join(" ");
  const output = [first.stderr, first.stdout, second.stderr, second.stdout]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join("\n");
  throw new Error(`Command failed after proxy retry: ${invocation}${output ? `\n${output}` : ""}`);
}

function jsonFromCommand(command, args = [], options = {}) {
  const result = runWithNetworkRetry(command, args, options);
  return JSON.parse(result.stdout);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readPackageJson(ref = null) {
  if (!ref) {
    return readJson("package.json");
  }

  return JSON.parse(run("git", ["show", `${ref}:package.json`]).stdout);
}

function packageManagerName(packageJson) {
  return packageJson.packageManager?.split("@")[0] ?? "npm";
}

function lockfileForPackageManager(packageManager) {
  if (packageManager === "bun") {
    return "bun.lock";
  }
  if (packageManager === "npm") {
    return "package-lock.json";
  }
  if (packageManager === "pnpm") {
    return "pnpm-lock.yaml";
  }
  if (packageManager === "yarn") {
    return "yarn.lock";
  }
  return null;
}

function inferUpstreamPackage(packageJson, aliasPackage) {
  const dependencies = packageJson.dependencies ?? {};
  const configured =
    packageJson.versionSync?.upstreamPackage ??
    packageJson.automation?.versionSync?.upstreamPackage ??
    process.env.QUANTEX_SYNC_UPSTREAM_PACKAGE ??
    cliValue("upstream");

  if (configured) {
    return configured;
  }

  const conventionalName = `${aliasPackage}-cli`;
  if (dependencies[conventionalName]) {
    return conventionalName;
  }

  const dependencyNames = Object.keys(dependencies);
  if (dependencyNames.length === 1) {
    return dependencyNames[0];
  }

  throw new Error(
    "Could not infer upstream package. Set QUANTEX_SYNC_UPSTREAM_PACKAGE or package.json versionSync.upstreamPackage.",
  );
}

function parseGitHubSlug(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (!value) {
    return null;
  }

  const match = value.match(/github\.com[:/]([^/\s]+\/[^/\s.#]+)(?:\.git)?/);
  return match?.[1] ?? null;
}

function repoInfo() {
  return jsonFromCommand("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
}

function readNpmRegistry() {
  const fromCli = cliValue("registry");
  if (fromCli) {
    return fromCli;
  }

  const fromEnv = process.env.QUANTEX_SYNC_REGISTRY ?? process.env.npm_config_registry;
  if (fromEnv) {
    return fromEnv;
  }

  if (!existsSync(".npmrc")) {
    return DEFAULT_REGISTRY;
  }

  for (const line of readFileSync(".npmrc", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("registry=")) {
      return trimmed.slice("registry=".length);
    }
  }

  return DEFAULT_REGISTRY;
}

function ensureTrailingSeparator(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function automationWorktreeRoot() {
  const configured = cliValue("worktree-root") ?? process.env.QUANTEX_SYNC_WORKTREE_ROOT;
  if (configured) {
    return ensureTrailingSeparator(path.resolve(configured));
  }

  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return ensureTrailingSeparator(path.join(codexHome, "worktrees"));
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function configuredSkipVersions(packageJson) {
  const values = [
    ...splitList(packageJson.versionSync?.skipVersions),
    ...splitList(packageJson.automation?.versionSync?.skipVersions),
    ...splitList(process.env.QUANTEX_SYNC_SKIP_VERSIONS),
  ];

  for (const version of values) {
    parseSemver(version);
  }

  return new Set(values);
}

function configuredMinimumUpstreamVersion(packageJson) {
  const value =
    cliValue("minimum-upstream-version") ??
    process.env.QUANTEX_SYNC_MINIMUM_UPSTREAM_VERSION ??
    packageJson.versionSync?.minimumUpstreamVersion ??
    packageJson.automation?.versionSync?.minimumUpstreamVersion;

  if (!value) {
    return null;
  }

  parseSemver(value);
  return value;
}

function buildConfig() {
  const packageJson = readPackageJson();
  const repo = repoInfo();
  const aliasPackage = cliValue("package") ?? process.env.QUANTEX_SYNC_PACKAGE ?? packageJson.name;
  const upstreamPackage = inferUpstreamPackage(packageJson, aliasPackage);
  const defaultBranch = repo.defaultBranchRef?.name;
  const baseBranch = cliValue("base") ?? process.env.QUANTEX_SYNC_BASE_BRANCH ?? defaultBranch;

  if (!aliasPackage) {
    throw new Error("Could not resolve alias package name from package.json.");
  }
  if (!baseBranch) {
    throw new Error("Could not resolve base branch from GitHub metadata.");
  }

  const packageManager = packageManagerName(packageJson);

  return {
    aliasPackage,
    upstreamPackage,
    baseBranch,
    branchPrefix:
      cliValue("branch-prefix") ??
      process.env.QUANTEX_SYNC_BRANCH_PREFIX ??
      `codex/sync-${aliasPackage}-v`,
    registry: readNpmRegistry(),
    releaseWorkflow:
      cliValue("release-workflow") ??
      process.env.QUANTEX_SYNC_RELEASE_WORKFLOW ??
      DEFAULT_RELEASE_WORKFLOW,
    expectedRepo: parseGitHubSlug(packageJson.repository),
    repoSlug: repo.nameWithOwner,
    packageManager,
    lockfile: lockfileForPackageManager(packageManager),
    worktreeRoot: automationWorktreeRoot(),
    skipVersions: configuredSkipVersions(packageJson),
    minimumUpstreamVersion: configuredMinimumUpstreamVersion(packageJson),
  };
}

function npmMetadata(packageName, config) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), `sync-${packageName.replace(/[^a-zA-Z0-9.-]/g, "-")}-`));
  try {
    return jsonFromCommand("npm", [
      "view",
      packageName,
      "--json",
      "--registry",
      config.registry,
      "--cache",
      cacheDir,
    ]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function metadataVersions(metadata) {
  const versions = metadata.versions ?? [];
  if (Array.isArray(versions)) {
    return versions;
  }
  return Object.keys(versions);
}

function parseSemver(version) {
  const normalized = version.trim();
  const withoutBuild = normalized.split("+", 1)[0];
  const match = withoutBuild.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }

  if (leftNumeric) {
    return -1;
  }

  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}

function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);

  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  const leftPre = left.prerelease;
  const rightPre = right.prerelease;

  if (leftPre.length === 0 && rightPre.length === 0) {
    return 0;
  }

  if (leftPre.length === 0) {
    return 1;
  }

  if (rightPre.length === 0) {
    return -1;
  }

  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPre[index] === undefined) {
      return -1;
    }
    if (rightPre[index] === undefined) {
      return 1;
    }

    const compared = compareIdentifier(leftPre[index], rightPre[index]);
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

function isGreater(left, right) {
  return compareSemver(left, right) > 0;
}

function isLessOrEqual(left, right) {
  return compareSemver(left, right) <= 0;
}

function sortedVersions(versions) {
  return [...versions].sort(compareSemver);
}

function assertComparator() {
  const fixture = ["0.0.1", "0.0.1-beta.10", "0.0.1-beta.8", "0.0.1-beta.9"];
  const sorted = sortedVersions(fixture);
  const expected = ["0.0.1-beta.8", "0.0.1-beta.9", "0.0.1-beta.10", "0.0.1"];
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(`SemVer comparator self-test failed: ${JSON.stringify(sorted)}`);
  }

  const checks = [
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0-beta.2"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.1", "1.0.0"],
  ];

  for (const [left, right] of checks) {
    if (compareSemver(left, right) >= 0) {
      throw new Error(`SemVer comparator self-test failed: expected ${left} < ${right}`);
    }
  }
}

function gitStatusShort() {
  return run("git", ["status", "--short"]).stdout.trim();
}

function assertCleanWorktree() {
  const status = gitStatusShort();
  if (status) {
    throw new Error(`Worktree is not clean; refusing to run version sync.\n${status}`);
  }
}

function remoteSyncBranchVersion(branchName) {
  const ref = `origin/${branchName}`;
  const result = run("git", ["show", `${ref}:package.json`], { allowFailure: true });
  if (result.status !== 0) {
    return null;
  }

  return JSON.parse(result.stdout).version;
}

function ensureTagForMain(version, mainCommit, config) {
  const tag = `v${version}`;
  const remoteTag = run("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
    allowFailure: true,
  });

  if (remoteTag.status === 0) {
    run("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const taggedCommit = run("git", ["rev-list", "-n", "1", tag]).stdout.trim();
    if (taggedCommit !== mainCommit) {
      throw new Error(`Remote tag ${tag} points to ${taggedCommit}, not origin/${config.baseBranch} ${mainCommit}.`);
    }

    console.log(`${tag} already exists on origin/${config.baseBranch}; waiting for release workflow/npm publish if needed.`);
    return;
  }

  const localTag = run("git", ["rev-parse", "--verify", "--quiet", tag], { allowFailure: true });
  if (localTag.status === 0) {
    const localTaggedCommit = run("git", ["rev-list", "-n", "1", tag]).stdout.trim();
    if (localTaggedCommit !== mainCommit) {
      throw new Error(`Local tag ${tag} points to ${localTaggedCommit}, not origin/${config.baseBranch} ${mainCommit}.`);
    }
  } else {
    run("git", ["tag", tag, mainCommit]);
  }

  runWithNetworkRetry("git", ["push", "origin", `refs/tags/${tag}`]);
  console.log(`Pushed ${tag} on origin/${config.baseBranch}; release workflow will publish ${config.aliasPackage}@${version}.`);
}

function rewritePackageJson(version, config) {
  const packagePath = path.resolve("package.json");
  const packageJson = readJson(packagePath);
  packageJson.version = version;
  packageJson.dependencies ??= {};
  packageJson.dependencies[config.upstreamPackage] = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function ensureOnlyExpectedFilesChanged(config) {
  const changed = run("git", ["diff", "--name-only", "HEAD"]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const expected = ["package.json", config.lockfile].sort();

  if (JSON.stringify(changed) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected changed files: ${changed.join(", ") || "<none>"}`);
  }
}

function tarballs() {
  return new Set(readdirSync(".").filter((name) => name.endsWith(".tgz")));
}

function cleanupNewPackArtifacts(beforePack) {
  for (const name of tarballs()) {
    if (!beforePack.has(name)) {
      rmSync(name, { force: true });
    }
  }
}

function parseReleaseWorkflow(config) {
  if (!existsSync(config.releaseWorkflow)) {
    return;
  }

  const source = readFileSync(config.releaseWorkflow, "utf8");
  try {
    parseYaml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse release workflow YAML (${config.releaseWorkflow}): ${message}`, {
      cause: error,
    });
  }
}

function validateChanges(config) {
  if (config.packageManager !== "bun") {
    throw new Error(`Unsupported package manager for this sync script: ${config.packageManager}`);
  }

  run("bun", ["install"], { stdio: "inherit" });
  run("bun", ["run", "check"], { stdio: "inherit" });
  const beforePack = tarballs();
  run("bun", ["pm", "pack", "--dry-run"], { stdio: "inherit" });
  cleanupNewPackArtifacts(beforePack);
  run("git", ["diff", "--check"]);
  parseReleaseWorkflow(config);
}

function commitAndPushSyncBranch(version, branchName, config) {
  const title = `chore: sync ${config.aliasPackage} alias to ${version}`;

  run("git", ["add", "package.json", config.lockfile]);
  run("git", ["commit", "-m", title]);
  runWithNetworkRetry("git", ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branchName}`]);
  run("git", ["switch", "--detach", `origin/${config.baseBranch}`]);
  console.log(`Pushed sync branch origin/${branchName} for ${config.aliasPackage}@${version}.`);
}

function removeStaleCleanDetachedWorktrees(mainCommit, config) {
  const output = run("git", ["worktree", "list", "--porcelain"]).stdout;
  const currentWorktree = path.resolve(run("git", ["rev-parse", "--show-toplevel"]).stdout.trim());
  const worktrees = [];
  let current = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current.path) {
    worktrees.push(current);
  }

  for (const worktree of worktrees) {
    const worktreePath = worktree.path ? path.resolve(worktree.path) : null;
    if (
      worktree.detached &&
      worktree.head === mainCommit &&
      worktreePath &&
      worktreePath !== currentWorktree &&
      worktreePath.startsWith(config.worktreeRoot)
    ) {
      const statusResult = run("git", ["-C", worktreePath, "status", "--short"], { allowFailure: true });
      if (statusResult.status !== 0) {
        console.warn(`Skipped stale worktree cleanup for unreadable path: ${worktreePath}`);
        continue;
      }

      const status = statusResult.stdout.trim();
      if (!status) {
        const removeResult = run("git", ["worktree", "remove", worktreePath], { allowFailure: true });
        if (removeResult.status === 0) {
          console.log(`Removed stale detached automation worktree: ${worktreePath}`);
        } else {
          const output = [removeResult.stderr, removeResult.stdout]
            .map((value) => value?.trim())
            .filter(Boolean)
            .join("\n");
          console.warn(`Skipped stale worktree cleanup for ${worktreePath}: ${output}`);
        }
      }
    }
  }
}

function selectNextVersion(upstreamMetadata, aliasMetadata, mainVersion, config) {
  const upstreamVersions = metadataVersions(upstreamMetadata);
  const aliasVersions = new Set(metadataVersions(aliasMetadata));
  const upstreamLatest = upstreamMetadata["dist-tags"]?.latest ?? sortedVersions(upstreamVersions).at(-1);

  if (!upstreamLatest) {
    throw new Error(`Could not resolve ${config.upstreamPackage} latest version from npm metadata.`);
  }

  const upstreamAhead = sortedVersions(upstreamVersions)
    .filter((version) => isLessOrEqual(version, upstreamLatest))
    .filter((version) => isGreater(version, mainVersion));
  const minimumUpstreamVersion = config.minimumUpstreamVersion;
  const isBelowMinimum = (version) =>
    minimumUpstreamVersion ? compareSemver(version, minimumUpstreamVersion) < 0 : false;
  const candidates = upstreamAhead
    .filter((version) => !isBelowMinimum(version))
    .filter((version) => !config.skipVersions.has(version))
    .filter((version) => !aliasVersions.has(version));

  return {
    nextVersion: candidates[0] ?? null,
    upstreamLatest,
    skippedBelowMinimum: upstreamAhead.filter((version) => isBelowMinimum(version) && !aliasVersions.has(version)),
    skippedConfigured: upstreamAhead.filter((version) => config.skipVersions.has(version)),
    skippedAlreadyPublished: upstreamAhead.filter((version) => aliasVersions.has(version)),
  };
}

function selfTest() {
  assertComparator();
  parseReleaseWorkflow({ releaseWorkflow: DEFAULT_RELEASE_WORKFLOW });
  console.log("SemVer comparator self-test passed.");
  console.log("Release workflow YAML parse self-test passed.");
}

function assertExpectedRepo(config) {
  if (!config.expectedRepo) {
    return;
  }

  if (config.repoSlug !== config.expectedRepo) {
    throw new Error(`Refusing to sync ${config.expectedRepo} from ${config.repoSlug}.`);
  }
}

function reportPlanConfig(config) {
  console.log(
    [
      `Package: ${config.aliasPackage}`,
      `Upstream: ${config.upstreamPackage}`,
      `Base: origin/${config.baseBranch}`,
      `Branch prefix: ${config.branchPrefix}`,
      `Registry: ${config.registry}`,
      ...(config.minimumUpstreamVersion ? [`Minimum upstream version: ${config.minimumUpstreamVersion}`] : []),
    ].join("\n"),
  );
}

function main() {
  if (cliFlag("self-test")) {
    selfTest();
    return;
  }

  const planOnly = cliFlag("plan");
  const config = buildConfig();

  assertComparator();
  assertExpectedRepo(config);
  if (!config.lockfile) {
    throw new Error(`Unsupported package manager lockfile inference: ${config.packageManager}`);
  }
  run("git", ["fetch", "--prune", "--tags", "origin"]);

  const mainRef = `origin/${config.baseBranch}`;
  const mainCommit = run("git", ["rev-parse", mainRef]).stdout.trim();
  const originPackage = readPackageJson(mainRef);
  const mainVersion = originPackage.version;
  const mainDependency = originPackage.dependencies?.[config.upstreamPackage];

  if (mainDependency !== mainVersion) {
    throw new Error(
      `${mainRef} has package version ${mainVersion} but ${config.upstreamPackage} dependency ${mainDependency}.`,
    );
  }

  if (planOnly) {
    reportPlanConfig(config);
  }

  const upstreamMetadata = npmMetadata(config.upstreamPackage, config);
  const aliasMetadata = npmMetadata(config.aliasPackage, config);
  const upstreamVersions = new Set(metadataVersions(upstreamMetadata));
  const aliasVersions = new Set(metadataVersions(aliasMetadata));

  if (upstreamVersions.has(mainVersion) && !aliasVersions.has(mainVersion)) {
    if (planOnly) {
      console.log(`Would ensure tag v${mainVersion} on ${mainRef} ${mainCommit}.`);
      return;
    }
    ensureTagForMain(mainVersion, mainCommit, config);
    removeStaleCleanDetachedWorktrees(mainCommit, config);
    return;
  }

  const { nextVersion, upstreamLatest, skippedAlreadyPublished, skippedConfigured, skippedBelowMinimum } = selectNextVersion(
    upstreamMetadata,
    aliasMetadata,
    mainVersion,
    config,
  );

  console.log(`${config.upstreamPackage}@latest is ${upstreamLatest}; ${mainRef} is ${mainVersion}.`);

  if (skippedAlreadyPublished.length > 0) {
    console.log(
      `Skipping already published ${config.aliasPackage} versions ahead of ${mainRef}: ${skippedAlreadyPublished.join(", ")}`,
    );
  }

  if (skippedBelowMinimum.length > 0) {
    console.log(
      `Skipping ${config.upstreamPackage} versions below minimum ${config.minimumUpstreamVersion}: ${skippedBelowMinimum.join(", ")}`,
    );
  }

  if (skippedConfigured.length > 0) {
    console.log(`Skipping configured ${config.upstreamPackage} versions: ${skippedConfigured.join(", ")}`);
  }

  if (!nextVersion) {
    console.log(`${config.aliasPackage} is caught up through ${upstreamLatest}.`);
    removeStaleCleanDetachedWorktrees(mainCommit, config);
    return;
  }

  const branchName = `${config.branchPrefix}${nextVersion}`;
  const remoteVersion = remoteSyncBranchVersion(branchName);
  if (remoteVersion === nextVersion) {
    if (planOnly) {
      console.log(`Sync branch origin/${branchName} already at ${nextVersion}.`);
      return;
    }
    console.log(`Sync branch origin/${branchName} already at ${nextVersion}; nothing to do.`);
    removeStaleCleanDetachedWorktrees(mainCommit, config);
    return;
  }

  if (planOnly) {
    console.log(`Would push ${branchName} to sync ${config.aliasPackage}@${nextVersion}.`);
    return;
  }

  assertCleanWorktree();
  run("git", ["switch", "--detach", mainRef]);
  rewritePackageJson(nextVersion, config);
  validateChanges(config);
  ensureOnlyExpectedFilesChanged(config);
  commitAndPushSyncBranch(nextVersion, branchName, config);
  removeStaleCleanDetachedWorktrees(mainCommit, config);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
