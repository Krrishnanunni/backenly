// Preloaded with `node --require` in front of a launcher. Replaces the `aws`
// binary with canned responses and records every call, so a launcher's full
// AWS conversation can be compared without credentials or network.
//
//   SHIM_SCENARIO  JSON: { "<service> <operation>": response | { __throw } | { __sequence: [...] } }
//   SHIM_LOG       file that receives one JSON line per aws call

const cp = require('node:child_process')
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')

const scenario = JSON.parse(process.env.SHIM_SCENARIO || '{}')
const LOG = process.env.SHIM_LOG
const original = cp.execFileSync
const seen = {}

cp.execFileSync = function execFileSyncShim(file, args, options) {
  if (file !== 'aws') return original.apply(this, arguments)
  fs.appendFileSync(LOG, JSON.stringify({ args }) + '\n')

  const op = `${args[0]} ${args[1]}`
  seen[op] = (seen[op] || 0) + 1
  let response = scenario[op]
  if (response && Array.isArray(response.__sequence)) {
    const seq = response.__sequence
    response = seq[Math.min(seen[op], seq.length) - 1]
  }
  if (response && typeof response.__throw === 'string') throw new Error(response.__throw)
  if (response === undefined || response === null) {
    return options && options.stdio === 'inherit' ? null : ''
  }
  return JSON.stringify(response)
}

// ESM named imports of builtins are snapshotted; this refreshes them.
syncBuiltinESMExports()
