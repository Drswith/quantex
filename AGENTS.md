# AGENTS.md

## Cursor Cloud specific instructions

This is the `quantex` npm alias package — a thin wrapper that re-exports `quantex-cli` and forwards its CLI binaries (`qtx` / `quantex`).

### Prerequisites

- **Bun 1.3.11** — declared in `packageManager` field; used for all install/test/pack operations.
- **Node.js >= 20** — declared in `engines`.

### Key commands (from `package.json`)

| Task | Command |
|---|---|
| Install deps | `bun install --frozen-lockfile` |
| Lint / check | `bun run check` |
| Test | `bun run test` |
| Pack dry-run | `bun pm pack --dry-run` |
| Run CLI | `node cli.mjs --help` |

### Non-obvious notes

- `bun run test` simply runs `bun run check` — there is no separate test suite beyond syntax checks and a dynamic import verification.
- `.npmrc` sets `ignore-scripts=true`, so post-install scripts from dependencies are intentionally suppressed.
- The CI workflow (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run check`, and `bun pm pack --dry-run` — replicate all three locally to match CI.
- No database, Docker, or external services are needed.
