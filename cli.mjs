#!/usr/bin/env node

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('quantex-cli/package.json')
const cliPath = join(dirname(packageJsonPath), 'dist', 'cli.mjs')

await import(pathToFileURL(cliPath).href)
