// Smoke test for dsh-vmouse without a DSH runtime: mounts the plugin against a
// minimal ctx shim, then drives a throwaway Cocoa test target and asserts that
// the physical cursor and the frontmost app are untouched.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const root = here('../')

// --- 1. mount the plugin ----------------------------------------------------

const registered = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => { try { dispose?.() } catch {} }
  },
  tools: { register(tool) { registered.push(tool); return () => {} } },
  logger: { info() {}, warn() {}, error() {} },
  get(key) { return key === 'tools' ? this.tools : undefined },
}

const plugin = await import(root + 'index.js')
plugin.apply(ctx, {})

assert.equal(registered.length, 8, 'expected 8 tools')
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
for (const name of ['vmouse_ping', 'vmouse_apps', 'vmouse_tree', 'vmouse_click',
  'vmouse_type', 'vmouse_key', 'vmouse_scroll', 'vmouse_shot']) {
  assert.ok(byName[name], `missing tool ${name}`)
  assert.ok(typeof byName[name].execute === 'function', `${name} has no execute`)
  assert.ok(byName[name].output?.render, `${name} has no output.render`)
}
console.log('✓ 8 tools registered')

// --- 2. start the throwaway target app -------------------------------------

const targetSrc = root + 'test/TestTarget.swift'
const targetBin = '/tmp/vmouse-test-target'
await new Promise((resolve, reject) => {
  const p = spawn('xcrun', ['-sdk', 'macosx', 'swiftc', '-O', '-o', targetBin, targetSrc])
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('test target build failed'))))
})
rmSync('/tmp/vmouse-test-click.txt', { force: true })
const target = spawn(targetBin, [], { stdio: ['ignore', 'ignore', 'inherit'] })
await new Promise((r) => setTimeout(r, 1200))
const pid = target.pid
assert.ok(pid, 'test target has no pid')

// --- 3. read state, act, verify --------------------------------------------

const ping0 = await byName.vmouse_ping.execute({})
assert.equal(ping0.axTrusted, true, 'accessibility permission is not granted')
console.log(`✓ ping: accessibility granted, cursor at ${ping0.cursor}`)

const apps = await byName.vmouse_apps.execute({})
const targetApp = apps.apps.find((a) => a.pid === pid)
assert.ok(targetApp, 'test target not listed by vmouse_apps')
assert.ok(targetApp.windows.length > 0, 'test target has no window')
console.log(`✓ apps: found "${targetApp.name}" pid ${pid}, window ${targetApp.windows[0].windowId}`)

const tree = await byName.vmouse_tree.execute({ pid })
const button = tree.nodes.find((n) => n.role === 'button' && n.title === 'ClickMe')
const field = tree.nodes.find((n) => n.role === 'textfield')
assert.ok(button, 'ClickMe button missing from tree')
assert.ok(field, 'textfield missing from tree')
const rendered = byName.vmouse_tree.output.render({}, tree)
assert.match(rendered[0].text, /snapshot .* · pid \d+/)
console.log(`✓ tree: ${tree.count} nodes, rendered ${rendered[0].text.length} chars`)

const clicked = await byName.vmouse_click.execute({ pid, ref: button.ref })
assert.equal(clicked.ok, true)
assert.equal(existsSync('/tmp/vmouse-test-click.txt'), true, 'button action never fired')
console.log(`✓ click: ${clicked.how} on ${button.ref}, button handler fired`)

const typed = await byName.vmouse_type.execute({ pid, ref: field.ref, text: '后台输入 ABC' })
const after = await byName.vmouse_tree.execute({ pid })
const value = after.nodes.find((n) => n.role === 'textfield')?.value
assert.equal(value, '后台输入 ABC', `typed value mismatch: ${value}`)
console.log(`✓ type: ${typed.how}, value read back as "${value}"`)

const shot = await byName.vmouse_shot.execute({ pid, maxSide: 320 })
assert.equal(existsSync(shot.path), true)
assert.ok(readFileSync(shot.path).length > 1000)
console.log(`✓ shot: ${shot.path} (${shot.bytes} bytes)`)

const ping1 = await byName.vmouse_ping.execute({})
assert.equal(ping1.cursor, ping0.cursor, 'the physical cursor moved!')
assert.equal(ping1.frontPid, ping0.frontPid, 'the frontmost app changed!')
console.log('✓ physical cursor unmoved, frontmost app unchanged')

// --- 4. clean up ------------------------------------------------------------

target.kill()
rmSync(shot.path, { force: true })
console.log('\nvmouse smoke test passed')
process.exit(0)
