#!/usr/bin/env node
/**
 * Runs the evaluation harness over a folder of labelled attempt bundles.
 *
 *   node tools/evaluate.mjs corpus/
 *
 * Each bundle is a .json file exported from the practice screen ("صدّر هذه المحاولة") with a
 * `labels` block added by a tajweed teacher — see docs/evaluation.md. Bundles carry the ASR
 * output with them, so this needs no model and no network, and runs the same analysis code
 * the app runs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createJiti } from 'jiti'

const target = process.argv[2]
if (!target) {
  console.error('usage: node tools/evaluate.mjs <folder-or-file.json>')
  process.exit(2)
}

if (!existsSync(target)) {
  console.error(`no such file or folder: ${target}`)
  process.exit(2)
}

const paths = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => f.endsWith('.json')).map((f) => join(target, f))
  : [target]

const bundles = []
for (const path of paths) {
  try {
    bundles.push(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    console.error(`skipped ${path}: ${err.message}`)
  }
}

const jiti = createJiti(import.meta.url)
const { evaluateBundles, formatEvaluation } = await jiti.import(resolve('src/lib/evaluation.ts'))
const { isAttemptBundle } = await jiti.import(resolve('src/lib/attemptBundle.ts'))

const usable = bundles.filter(isAttemptBundle)
if (usable.length !== bundles.length) {
  console.error(`${bundles.length - usable.length} file(s) are not attempt bundles and were ignored`)
}

const report = evaluateBundles(usable)
console.log(formatEvaluation(report))
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
