// The dependency boundary, checked by behaviour: the entry loads in a fresh Node
// process whose resolver refuses everything that is not a relative file. The reducer
// has no dependency on the client (or anything else), and no framework.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hook = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) throw new Error('blocked import: ' + specifier)
  return next(specifier, context)
}`)}`
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the entry loads when only relative imports resolve: no react, no @hollis-labs package, no node: builtin', () => {
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hook)})`
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `const m = await import(${JSON.stringify(dist + 'index.js')}); console.log(Object.keys(m).sort().join(','))`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'createReducer,markStalled,messageText,reduce,toolArguments,toolCalls,usageTotal')
})

test('the blocker is real: an entry that imports a package fails to load under it', () => {
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hook)})`
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `await import('node:fs')`], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /blocked import: node:fs/)
})

test('no built file imports anything but a sibling', () => {
  for (const f of readdirSync(dist).filter((n) => n.endsWith('.js'))) {
    for (const m of readFileSync(dist + f, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('./'), `${f} imports ${m[1]}`)
    }
  }
})
