# Quantex

`quantex` is an alias package for [`quantex-cli`](https://www.npmjs.com/package/quantex-cli).

It does not contain an independent implementation. Installing `quantex` installs `quantex-cli`, re-exports its public API, and forwards the `qtx` / `quantex` binaries to the CLI shipped by `quantex-cli`.

This package exists to provide the shorter package name. For full documentation, command reference, and API behavior, see [`quantex-cli`](https://github.com/Drswith/quantex-cli).

## Install

```bash
bun add -g quantex
```

## CLI

```bash
qtx --help
quantex --help
```

## API

```js
export * from 'quantex-cli'
```

## Versioning

`quantex` versions track the corresponding `quantex-cli` versions.

## Release Sync

`quantex-cli` is the source package. After publishing a `quantex-cli` version, trigger this repository with a `repository_dispatch` event:

```json
{
  "event_type": "sync-quantex-cli-release",
  "client_payload": {
    "version": "0.18.0",
    "npm_tag": "latest"
  }
}
```

The `release.yml` workflow updates this package to the same version, pins `dependencies.quantex-cli` to that exact version, updates `bun.lock`, commits the sync, creates `v<version>`, publishes `quantex`, and creates the GitHub release.
