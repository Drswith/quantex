<div align="center">

# Quantex

[![npm version](https://img.shields.io/npm/v/quantex?color=0b7285&label=npm)](https://www.npmjs.com/package/quantex)
[![npm downloads](https://img.shields.io/npm/dm/quantex?color=364fc7)](https://www.npmjs.com/package/quantex)
[![CI](https://github.com/Drswith/quantex/actions/workflows/ci.yml/badge.svg)](https://github.com/Drswith/quantex/actions/workflows/ci.yml)
[![Release](https://github.com/Drswith/quantex/actions/workflows/release.yml/badge.svg)](https://github.com/Drswith/quantex/actions/workflows/release.yml)
[![License](https://img.shields.io/github/license/Drswith/quantex?color=2f9e44)](./LICENSE)
[![Node](https://img.shields.io/node/v/quantex?color=5c7cfa)](https://www.npmjs.com/package/quantex)
[![Bun](https://img.shields.io/badge/package%20manager-bun-f472b6)](https://bun.sh/)

Alias package for [`quantex-cli`](https://www.npmjs.com/package/quantex-cli).

</div>

`quantex` exists to provide the shorter package name for [`quantex-cli`](https://github.com/Drswith/quantex-cli). It does not contain an independent implementation.

Installing `quantex` installs `quantex-cli`, re-exports its public API, and forwards the `qtx` / `quantex` binaries to the CLI shipped by `quantex-cli`.

For full documentation, command reference, and API behavior, see [`quantex-cli`](https://github.com/Drswith/quantex-cli).

## Install

```bash
bun add -g quantex
```

## CLI

```bash
qtx --help
quantex --help
```

Both commands are forwarded to the `quantex-cli` binary.

## API

```js
export * from 'quantex-cli'
```

## Versioning

`quantex` versions track the corresponding `quantex-cli` versions, and `dependencies.quantex-cli` is pinned to the exact same version.

## Release Sync

`quantex-cli` is the source package. After publishing a `quantex-cli` version, trigger this repository with a `repository_dispatch` event.

```json
{
  "event_type": "sync-quantex-cli-release",
  "client_payload": {
    "version": "0.18.0",
    "npm_tag": "latest"
  }
}
```

The `release.yml` workflow updates this package to the same version, updates `bun.lock`, commits the sync, creates `v<version>`, publishes `quantex`, and creates the GitHub release.
