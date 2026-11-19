#!/usr/bin/env node
/**
 * dsh-vmouse MCP server (stdio transport).
 *
 * Same native helper as the DSH plugin, exposed over the Model Context Protocol
 * so any MCP client can drive a macOS app with a virtual pointer that never
 * moves the physical cursor.
 *
 * Configure (Claude Desktop / Cursor / any MCP client):
 *   command: node
 *   args:    ["/absolute/path/to/dsh-vmouse/mcp/server.mjs"]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.0'
const HELPER_SRC = fileURLToPath(new URL('../helper/vmouse-helper.swift', import.meta.url))
const CACHE_DIR = join(homedir(), '.cache', 'dsh-vmouse', 'bin')

// --- helper process ---------------------------------------------------------

const waiters = []
let child = null
let buffer = ''
let pending = Promise.resolve()

function helperBinary() {
  const hash = createHash('sha1').update(readFileSync(HELPER_SRC)).digest('hex').slice(0, 12)
  return join(CACHE_DIR, `vmouse-helper-${hash}`)
}

function compile(bin) {
  return new Promise((resolve, reject) => {
    const p = spawn('xcrun', ['-sdk', 'macosx', 'swiftc', '-O', '-o', bin, HELPER_SRC])
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error('cannot build the macOS helper (install Xcode Command Line Tools): ' + err.slice(-800)))))
  })
}

async function ensure() {
  if (child && child.exitCode === null) return
  mkdirSync(CACHE_DIR, { recursive: true })
  const bin = helperBinary()
  if (!existsSync(bin) || statSync(bin).size === 0) await compile(bin)
  child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      const waiter = waiters.shift()
      if (!waiter) continue
      try { waiter.resolve(JSON.parse(line)) } catch { waiter.reject(new Error('invalid helper output')) }
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(`[vmouse] ${String(d).trim()}\n`))
}

function callHelper(payload) {
  const run = async () => {
    await ensure()
    return await new Promise((resolve, reject) => {
      waiters.push({ resolve, reject })
      child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }
  const next = pending.then(run, run)
  pending = next.catch(() => {})
  return next
}

/** Run a helper command; throw a model-readable message on protocol failure. */
async function run(payload) {
  const result = await callHelper(payload)
  if (result.ok === false) {
    throw new Error(`${result.error}: ${result.message || ''}${result.hint ? ` — ${result.hint}` : ''}`)
  }
  return result
}

// --- tool definitions -------------------------------------------------------

const tools = [
  {
    name: 'vmouse_ping',
    description: 'Check macOS accessibility permission, helper state, and the physical cursor position. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const v = await run({ cmd: 'ping' })
      return `helper ${v.helper} ${v.version} · accessibility ${v.axTrusted ? 'granted' : 'NOT granted'} · physical cursor ${v.cursor} · front app pid ${v.frontPid}`
    },
  },
  {
    name: 'vmouse_apps',
    description: 'List running applications that have on-screen windows, with pid and window ids. Call this first. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { includeWindows: { type: 'boolean', description: 'Include window ids and titles. Defaults to true.' } },
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'apps', windows: args.includeWindows !== false })
      return (v.apps || []).map((a) => {
        const wins = (a.windows || []).map((w) => `  window ${w.windowId} "${w.title}" @${w.rect[0]},${w.rect[1]} ${w.rect[2]}x${w.rect[3]}`)
        return [`${a.pid} ${a.name}${a.bundle ? ` (${a.bundle})` : ''}`, ...wins].join('\n')
      }).join('\n')
    },
  },
  {
    name: 'vmouse_tree',
    description: 'Read a window’s accessibility element tree as compact text and assign refs (e1, e2…) for click/type/scroll. Cheaper and more precise than a screenshot. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        windowId: { type: 'integer', description: 'Window id; defaults to the first accessible window.' },
        max: { type: 'integer', description: 'Maximum elements, 1-400. Defaults to 120.' },
        filter: { type: 'string', description: 'Only keep elements whose title or value matches this regex.' },
        text: { type: 'boolean', description: 'Include plain text elements so the window can be read. Defaults to true.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'tree', pid: args.pid, windowId: args.windowId, max: args.max ?? 120, filter: args.filter, interactiveOnly: args.text !== false })
      const head = `snapshot ${v.snapshot} · pid ${v.pid} · window "${v.window || ''}" · ${v.count} nodes`
      const lines = (v.nodes || []).map((n) => {
        let line = `${n.ref} ${n.role}`
        if (n.title) line += ` "${n.title}"`
        if (n.value) line += ` = "${n.value}"`
        if (n.rect) line += ` @${n.rect[0]},${n.rect[1]} ${n.rect[2]}x${n.rect[3]}`
        if (n.actions?.length) line += ` [${n.actions.join(' ')}]`
        if (n.editable) line += ' (editable)'
        if (n.disabled) line += ' (disabled)'
        return line
      })
      return [head, ...lines].join('\n')
    },
  },
  {
    name: 'vmouse_click',
    description: 'Click an element (preferred) or screen point in a target app. The physical cursor and frontmost app are never touched.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        ref: { type: 'string', description: 'Element ref from vmouse_tree.' },
        x: { type: 'number', description: 'Global screen x, for apps without a usable tree.' },
        y: { type: 'number', description: 'Global screen y, paired with x.' },
        clicks: { type: 'integer', description: '1 (default) or 2 for double click.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button, defaults to left.' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'cmd, shift, ctrl, opt.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    async run(args) {
      if (args.ref === undefined && (args.x === undefined || args.y === undefined)) throw new Error('give ref or both x and y')
      const v = await run({ cmd: 'click', pid: args.pid, ref: args.ref, x: args.x, y: args.y, clicks: args.clicks ?? 1, button: args.button ?? 'left', modifiers: args.modifiers })
      return `clicked ${v.ref || `(${v.at.join(',')})`} via ${v.how} · physical cursor untouched`
    },
  },
  {
    name: 'vmouse_type',
    description: 'Type text into an element of a target app. Uses the accessibility value when supported, otherwise Unicode key events, delivered to that process only.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        text: { type: 'string', description: 'Text to enter; CJK and emoji supported.' },
        ref: { type: 'string', description: 'Element ref from vmouse_tree. Strongly recommended.' },
      },
      required: ['pid', 'text'],
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'type', pid: args.pid, text: args.text, ref: args.ref })
      return `typed ${v.chars ?? '?'} chars via ${v.how} · physical cursor untouched`
    },
  },
  {
    name: 'vmouse_key',
    description: 'Send a keyboard shortcut to a target app, e.g. "cmd+s", "return", "tab", "esc", "down".',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        keys: { type: 'string', description: 'Combination such as "cmd+s".' },
      },
      required: ['pid', 'keys'],
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'key', pid: args.pid, keys: args.keys })
      return `sent ${v.keys} via ${v.how} · physical cursor untouched`
    },
  },
  {
    name: 'vmouse_scroll',
    description: 'Scroll inside a target app at an element, point, or the window centre. Delivered to that process only.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        ref: { type: 'string', description: 'Element ref to scroll over.' },
        x: { type: 'number', description: 'Global screen x.' },
        y: { type: 'number', description: 'Global screen y.' },
        dy: { type: 'integer', description: 'Vertical delta; positive scrolls down.' },
        dx: { type: 'integer', description: 'Horizontal delta; positive scrolls right.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'scroll', pid: args.pid, ref: args.ref, x: args.x, y: args.y, dy: args.dy ?? 0, dx: args.dx ?? 0 })
      return `scrolled dy=${v.dy} dx=${v.dx} at ${v.at.join(',')} via ${v.how} · physical cursor untouched`
    },
  },
  {
    name: 'vmouse_shot',
    description: 'Capture one window of a target app to a PNG (works in the background) and describe it. Prefer vmouse_tree for text.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: 'Target process id.' },
        windowId: { type: 'integer', description: 'Window id from vmouse_apps.' },
        maxSide: { type: 'integer', description: 'Longest edge after downscaling, 320-2560. Defaults to 1280.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    async run(args) {
      const v = await run({ cmd: 'shot', pid: args.pid, windowId: args.windowId, maxSide: args.maxSide ?? 1280 })
      const path = join(tmpdir(), `vmouse-shot-${v.windowId}-${Date.now()}.png`)
      writeFileSync(path, Buffer.from(v.png, 'base64'))
      return { text: `saved ${path} (window ${v.windowId}, ${v.bytes} bytes)`, path, png: v.png }
    },
  },
]

const byName = new Map(tools.map((t) => [t.name, t]))

// --- JSON-RPC stdio loop ----------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

let inflight = 0

async function handle(message) {
  inflight += 1
  try {
  const { id, method, params } = message
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-vmouse', version: VERSION },
        })
        return
      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })
        return
      case 'tools/call': {
        const tool = byName.get(params?.name)
        if (!tool) return replyError(id, -32602, `unknown tool ${params?.name}`)
        try {
          const out = await tool.run(params?.arguments ?? {})
          if (out && typeof out === 'object' && out.png) {
            reply(id, {
              content: [
                { type: 'text', text: out.text },
                { type: 'image', data: out.png, mimeType: 'image/png' },
              ],
            })
          } else {
            reply(id, { content: [{ type: 'text', text: String(out) }] })
          }
        } catch (error) {
          reply(id, { content: [{ type: 'text', text: `vmouse: ${error.message}` }], isError: true })
        }
        return
      }
      default:
        if (id !== undefined) replyError(id, -32601, `unsupported method ${method}`)
    }
  } catch (error) {
    if (id !== undefined) replyError(id, -32603, String(error.message || error))
  }
  } finally {
    inflight -= 1
  }
}

if (process.argv.includes('--selftest')) {
  run({ cmd: 'ping' }).then((v) => {
    process.stdout.write(JSON.stringify(v) + '\n')
    process.exit(0)
  }).catch((error) => {
    process.stdout.write('error: ' + error.message + '\n')
    process.exit(1)
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    let idx
    while ((idx = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, idx)
      input = input.slice(idx + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      void handle(message)
    }
  })
  // Let in-flight tool calls finish before the stream closes.
  process.stdin.on('end', () => {
    const wait = () => (inflight ? setTimeout(wait, 40) : process.exit(0))
    wait()
  })
}
