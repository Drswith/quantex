---
name: sync-quantex-cli-releases
description: Sync and serially publish matching quantex alias package versions for each non-deprecated quantex-cli release via PR → CI → merge → tag. Use when quantex-cli has new versions, the alias package lags behind, or the user asks to plan/sync/backfill/publish corresponding quantex versions.
---

# Sync quantex-cli Releases

将本仓库（`quantex`）的版本与 `dependencies.quantex-cli` 对齐到 npm 上已发布的 `quantex-cli` 目标版本，经 PR 合入 `main` 后，在 `main` 上打 `v<version>` 标签触发 Release 工作流发布。

本仓库**没有**版本同步脚本；以下步骤由 Agent 按命令与规则手工执行。

## 仓库与约束

| 项 | 值 |
|---|---|
| 别名包 | `quantex`（本仓库） |
| 上游包 | `quantex-cli` |
| 默认基线分支 | `main` |
| 包管理器 | Bun（`packageManager`: `bun@1.3.11`） |
| 允许改动的文件（同步 PR） | 仅 `package.json`、`bun.lock` |
| npm registry | `https://registry.npmjs.org` |

**不变量：** `package.json` 的 `version` 必须与 `dependencies.quantex-cli` **完全相同**（精确 pin，不用 `^` / `~`）。

## Hard rules

1. **仅补发未标记成 deprecated 的版本**
2. **不要发布有问题的 1.0.0 版本**（即使将来取消 deprecate，也默认跳过，除非用户明确要求）
3. **全局串行**：同一时间只推进**一个**「下一目标版本」；上一个 PR 合入且（如需）npm 可见后，再处理下一个
4. **走 PR → CI → merge → tag → Release**，不要直接推 `main`，也不要本地 `npm publish`
5. 每个版本同时更新 `package.json` 的 `version` 与 `dependencies.quantex-cli`

## 模式

根据用户意图二选一或三选一；**未说明时先做 Plan**。默认定时 / 自动任务 = **Plan +（条件满足时）Sync**；**不要**在未明确要求时打 `v*` 标签。

| 模式 | 何时 |
|---|---|
| Plan | 只读盘点；默认入口 |
| Sync | Plan 已确认目标版本，且无冲突 open 同步 PR |
| Release | 用户明确要求，或目标版本已在 `main`、npm 尚未发布时补打标签 |

### Plan（只读）

1. `git fetch --prune --tags origin`
2. 读取 `origin/main` 上的 `package.json`：
   ```bash
   git show origin/main:package.json
   ```
   记下 `mainVersion`（`version`）与 `mainDep`（`dependencies.quantex-cli`）。若二者不一致，**停止**并报告（main 已损坏，需人工修复）。
3. 查询 npm：
   ```bash
   npm view quantex-cli version --registry=https://registry.npmjs.org/
   npm view quantex-cli versions --json --registry=https://registry.npmjs.org/
   npm view quantex version --registry=https://registry.npmjs.org/
   npm view quantex versions --json --registry=https://registry.npmjs.org/
   ```
4. 在 `quantex-cli` 已发布、且 **semver 大于** `mainVersion` 的集合中，按 semver 升序找**第一个**同时满足：
   - 不是 `1.0.0`（默认永久跳过，除非用户明确要求）
   - `quantex` 上**尚未**发布该版本
   - 该版本**未** deprecated：
     ```bash
     npm view "quantex-cli@$VERSION" deprecated --registry=https://registry.npmjs.org/
     ```
     有非空输出 → 跳过；无输出 → 可同步
   - 用户未明确要求跳过的版本
5. 「已追上」判定：若没有满足步骤 4 的版本，报告「已追上最高可用非 deprecated 上游版本」，**不要**把已 deprecated 的 `quantex-cli@latest`（例如 `1.0.0`）当成必须追平的目标。
6. 列出结论：
   - `quantex-cli` 最高可用（非 deprecated、非 1.0.0）= …
   - `quantex-cli@latest` = …（若与上不同，注明原因）
   - `origin/main` = …
   - 下一个建议同步版本 = … 或「已追上」
   - 已跳过的中间版本（已在 `quantex` 发布 / deprecated / 1.0.0）
7. 检查 open 同步 PR（**全局串行，不只查同版本**）：
   ```bash
   gh pr list --state open --base main --json number,title,url,headRefName
   ```
   匹配标题：`chore: sync quantex alias to <version>`
   - 若已有 open PR 的目标版本 **等于** 建议版本 → **复用**，不要新建
   - 若已有 open PR 的目标版本 **小于** 建议版本 → **等待/复用较低版本 PR**，不要开更高版本
   - 若已有 open PR 的目标版本 **大于** 建议版本 → 报告冲突，优先处理较低正确版本
   - 若 open PR 目标版本已在 `main` 或已在 npm 上 → 建议关闭为过期 PR，不要据此跳过真正的下一版本

### Sync（改版本并开 PR）

**前置：** 工作区干净；已在 Plan 中确认目标版本；无冲突 open 同步 PR（见上）。

1. 从最新 `origin/main` 开分支（不要基于过期本地 `main`）：
   ```bash
   git fetch origin main
   git switch -c "sync/quantex-cli-<version>" origin/main
   ```
2. 编辑 `package.json`：
   - `version` → 目标版本
   - `dependencies.quantex-cli` → 同一目标版本
3. 安装并校验（与 CI 一致）：
   ```bash
   bun install
   bun run check
   bun pm pack --dry-run
   ```
4. 确认**仅有** `package.json` 与 `bun.lock` 相对 `origin/main` 有 diff：
   ```bash
   git diff --name-only origin/main
   ```
5. 提交并推送，创建 **ready** PR（除非用户要求 draft）：
   - **标题：** `chore: sync quantex alias to <version>`
   - **基线：** `main`
   - **正文：** 写明上游 `quantex-cli@<version>`、main 原版本、变更文件；并注明合入后需在 merge commit 上打 `v<version>` 触发 Release
6. **本步骤不要**推送 `v*` 标签

### Release（打标签，通常在 PR 合并后）

Release 工作流（`.github/workflows/release.yml`）**仅**在推送 `v*` 标签时发布 npm。

**仅当**用户明确要求，或确认：`origin/main` 已含目标版本，且 `quantex@<version>` **尚未**出现在 npm：

1. 解析 main 上该版本对应的 commit：
   ```bash
   git fetch origin main
   git rev-parse origin/main
   git show origin/main:package.json
   ```
   确认 `version` 等于目标版本。
2. 若本地/远端尚无标签 `v<version>`，在**该 commit** 上创建并推送：
   ```bash
   git tag "v<version>" <main-commit-sha>
   git push origin "v<version>"
   ```
3. 若标签已存在且指向正确 commit，无需重复推送。
4. 确认 GitHub Actions `Release` 成功，并检查：
   ```bash
   npm view "quantex@<version>" version --registry=https://registry.npmjs.org/
   ```

**说明：** 若 `quantex-cli` 已发布某版本而 `main` 仍是旧版本，但 `quantex` 上**已有**该版本（历史漏合并等），不要为「追 main」再开同步 PR；只需在正确 commit 上补打缺失的 `v<version>` 标签（若标签也未打）。

## 禁止事项

- 不要并行开两个同步 PR（即使目标版本不同）；同一时间只允许一条「下一版本」同步链路
- 不要发布 `1.0.0`；不要补发已 deprecated 的 `quantex-cli` 版本
- 不要在脏工作区改 `package.json` / 跑 `bun install`
- 同步 PR 中不要改 `cli.mjs`、`index.mjs`、工作流、README、skill 等无关文件
- 不要在本仓库实现或恢复同步脚本（如 `scripts/sync-versions.mjs`、`.sync-release.sh`、`automation:sync*`）
- 不要本地 `npm publish`；不要直接推 `main` 绕过 PR/CI
- 不要在 Sync PR 流程里推送 `v*` 标签（标签在 main 合并后单独处理，除非用户明确要求仅打标签）
- 不要在上一个版本的同步 PR 未合入前开下一个更高版本

## 故障对照

| 现象 | 处理 |
|---|---|
| `main` 上 version ≠ quantex-cli 依赖 | 停止；先修 main |
| 目标版本已在 npm 上作为 `quantex` | 跳过该版本，选下一个未发布的上游版本 |
| 已有 open 同步 PR（任意版本） | 按 Plan 第 7 步复用/等待/报告冲突，不要盲目新建 |
| open 同步 PR 已过期（版本已在 main/npm） | 建议关闭；再按差集选真正的下一版本 |
| `bun run check` / `bun pm pack --dry-run` 失败 | 修复后重跑，不要提交半成品 |
| `git diff` 含 `package.json`、`bun.lock` 以外文件 | 回滚多余改动 |
| 标签已存在但指向错误 commit | 不要强推覆盖；报告 maintainer 手工处理 |
| `gh` 不可用 | Plan 仍可用 npm/git；Sync/PR 步骤需提示用户安装或代开 PR |
| npm 网站仍显示已 unpublish 版本 | registry 404 即成功；网页可能有 CDN 缓存 |

## 参考命令速查

```bash
# Plan
git fetch --prune --tags origin
git show origin/main:package.json
npm view quantex-cli version --registry=https://registry.npmjs.org/
npm view quantex version --registry=https://registry.npmjs.org/
npm view "quantex-cli@$VERSION" deprecated --registry=https://registry.npmjs.org/
gh pr list --state open --base main --json number,title,url,headRefName

# Sync
git switch -c "sync/quantex-cli-<version>" origin/main
bun install && bun run check && bun pm pack --dry-run
git diff --name-only origin/main

# Release（main 已含版本且 npm 未发布）
git tag "v<version>" <commit>
git push origin "v<version>"
```

## 相关文档

- `README.md` — Versioning / Release
- `AGENTS.md` — 本地 CI 等价命令
- `.github/workflows/release.yml` — 发布逻辑
- `.github/workflows/ci.yml` — PR 校验
