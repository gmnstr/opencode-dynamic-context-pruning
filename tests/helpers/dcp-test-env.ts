/**
 * Test-only environment isolation.
 *
 * This module has a side effect and MUST be imported before any module that
 * reads a path from the environment at module scope. `lib/state/persistence.ts`
 * computes `STORAGE_DIR` once, at import time:
 *
 *     const STORAGE_DIR = join(process.env.XDG_DATA_HOME || ..., "opencode", ...)
 *
 * ES module imports are evaluated in source order, so a test file that assigns
 * `process.env.XDG_DATA_HOME` in its own body does so *after* persistence.ts has
 * already captured the real value — which silently points the test suite at the
 * live DCP state directory. Importing this file first fixes the ordering.
 */

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const TEST_DATA_HOME = join(tmpdir(), `opencode-dcp-test-data-${process.pid}`)
export const TEST_CONFIG_HOME = join(tmpdir(), `opencode-dcp-test-config-${process.pid}`)

process.env.XDG_DATA_HOME = TEST_DATA_HOME
process.env.XDG_CONFIG_HOME = TEST_CONFIG_HOME

mkdirSync(TEST_DATA_HOME, { recursive: true })
mkdirSync(TEST_CONFIG_HOME, { recursive: true })
