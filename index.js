/**
 * dsh-vmouse — a virtual mouse / keyboard for macOS that never touches the
 * physical cursor and never steals frontmost focus.
 *
 * How it stays out of the user's way:
 *   - Accessibility (AX) element actions are used first: no coordinates, no
 *     pointer, no focus change. This is also the cheapest path in tokens —
 *     the model reads a compact element tree instead of a screenshot.
 *   - When a raw pointer is required, events are delivered with
 *     CGEventPostToPid() to the target process only; the hardware cursor keeps
 *     its position.
 *
 * The native helper is a small Swift binary. It is compiled on first use from
 * the bundled source (needs the Xcode command line tools) and cached under
 * ~/.cache/dsh-vmouse/bin, keyed by source hash.
 */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-vmouse'
export const inject = ['tools']

const HELPER_SRC = fileURLToPath(new URL('./helper/vmouse-helper.swift', import.meta.url))
const CACHE_DIR = join(homedir(), '.cache', 'dsh-vmouse', 'bin')

export function apply(ctx, config = {}) {
  const runtime = createRuntime(ctx, config)

  ctx.effect(() => () => runtime.stop(), 'dsh-vmouse: helper process')

  for (const tool of tools(runtime)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-vmouse: tool ${tool.name}`)
  }

  ctx.logger?.info?.('[dsh-vmouse] virtual mouse ready')
}

// ---------------------------------------------------------------------------
// native helper: compile once, then a single long-lived line-JSON process
// ---------------------------------------------------------------------------

function helperBinary() {
  const source = readFileSync(HELPER_SRC)
  const hash = createHash('sha1').update(source).digest('hex').slice(0, 12)
  const bin = join(CACHE_DIR, `vmouse-helper-${hash}`)
  if (existsSync(bin) && statSync(bin).size > 0) return { bin, fresh: false }
  return { bin, fresh: true }
}

function compile(bin) {
  return new Promise((resolve, reject) => {
    execFile(
      'xcrun',
      ['-sdk', 'macosx', 'swiftc', '-O', '-o', bin, HELPER_SRC],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().slice(-1200)
          reject(new Error(
            'cannot build the macOS helper. Install the Xcode command line tools '
            + '(`xcode-select --install`), then retry. Build output:\n' + detail,
          ))
          return
        }
        resolve()
      },
    )
  })
}

function createRuntime(ctx, config) {
  let child = null
  let pending = Promise.resolve()
  let ready = null
  let dead = false

  async function ensure() {
    if (child && !dead) return
    const { bin, fresh } = helperBinary()
    if (fresh) {
      mkdirSync(join(homedir(), '.cache', 'dsh-vmouse'), { recursive: true })
      mkdirSync(CACHE_DIR, { recursive: true })
      await compile(bin)
    }
    child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    dead = false
    let buffer = ''
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
        try {
          waiter.resolve(JSON.parse(line))
        } catch (error) {
          waiter.reject(new Error('helper returned invalid JSON: ' + line.slice(0, 200)))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => ctx.logger?.warn?.(`[dsh-vmouse] helper stderr: ${String(chunk).trim().slice(0, 400)}`))
    child.on('exit', (code) => {
      dead = true
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`helper exited (code ${code}); it will restart on the next call`))
      }
    })
  }

  const waiters = []

  function request(payload) {
    const run = async () => {
      await ensure()
      return await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
        try {
          child.stdin.write(JSON.stringify(payload) + '\n')
        } catch (error) {
          waiters.pop()
          reject(error)
        }
      })
    }
    const next = pending.then(run, run)
    pending = next.catch(() => {})
    return next
  }

  async function start() {
    if (!ready) {
      ready = request({ cmd: 'ping' }).catch((error) => {
        ready = null
        throw error
      })
    }
    return ready
  }

  return {
    ctx,
    config,
    request,
    start,
    stop() {
      if (child) {
        try { child.kill() } catch {}
        child = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const text = (s) => [{ type: 'text', text: s }]

function fail(message) {
  const error = new Error(message)
  error.isError = true
  return error
}

function renderTree(value) {
  if (!value.ok) return text(`vmouse: ${value.error}: ${value.message || ''}`)
  const head = `snapshot ${value.snapshot} · pid ${value.pid} · window "${value.window || ''}" · ${value.count} nodes`
  const lines = (value.nodes || []).map((n) => {
    let line = `${n.ref} ${n.role}`
    if (n.title) line += ` "${n.title}"`
    if (n.value) line += ` = "${n.value}"`
    if (n.rect) line += ` @${n.rect[0]},${n.rect[1]} ${n.rect[2]}x${n.rect[3]}`
    if (n.actions?.length) line += ` [${n.actions.join(' ')}]`
    if (n.editable) line += ' (editable)'
    if (n.disabled) line += ' (disabled)'
    return line
  })
  return text([head, ...lines].join('\n'))
}

function tools(runtime) {
  const need = (v, name) => {
    if (v === undefined || v === null || v === '') throw fail(`vmouse: "${name}" is required`)
    return v
  }

  /** Shared call path: errors become readable model-facing text. */
  async function call(payload) {
    let result
    try {
      result = await runtime.request(payload)
    } catch (error) {
      throw fail(`vmouse: ${error.message}`)
    }
    if (result.ok === false) {
      const hint = result.hint ? ` — ${result.hint}` : ''
      throw fail(`vmouse: ${result.error}: ${result.message || ''}${hint}`)
    }
    return result
  }

  return [
    {
      name: 'vmouse_ping',
      description: 'Check that the virtual mouse is usable: macOS accessibility permission, helper state, and the physical cursor position. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(
          `helper ${v.helper} ${v.version} · accessibility ${v.axTrusted ? 'granted' : 'NOT granted'}`
          + ` · physical cursor ${v.cursor} · front app pid ${v.frontPid}`,
        ),
      },
      async execute() {
        await runtime.start()
        return await call({ cmd: 'ping' })
      },
    },
    {
      name: 'vmouse_apps',
      description: 'List running applications that have on-screen windows, with their pid and window ids. Call this first to find the pid for the other vmouse tools. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          includeWindows: { type: 'boolean', description: 'Include each app’s window ids and titles. Defaults to true.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(
          (v.apps || []).map((a) => {
            const wins = (a.windows || []).map((w) => `  window ${w.windowId} "${w.title}" @${w.rect[0]},${w.rect[1]} ${w.rect[2]}x${w.rect[3]}`)
            return [`${a.pid} ${a.name}${a.bundle ? ` (${a.bundle})` : ''}`, ...wins].join('\n')
          }).join('\n'),
        ),
      },
      async execute(args) {
        return await call({ cmd: 'apps', windows: args.includeWindows !== false })
      },
    },
    {
      name: 'vmouse_tree',
      description: 'Read the accessibility element tree of a window as compact text and assign element refs (e1, e2, …) for vmouse_click / vmouse_type / vmouse_scroll. Prefer this over screenshots: it is precise and uses far fewer tokens. Read-only. Refs stay valid only for the snapshot that produced them and are dropped after a few newer reads.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id from vmouse_apps.' },
          windowId: { type: 'integer', description: 'Target window id; defaults to the app’s first accessible window.' },
          max: { type: 'integer', description: 'Maximum elements to return, 1–400. Defaults to 120.' },
          filter: { type: 'string', description: 'Only keep elements whose title or value matches this regular expression.' },
          text: { type: 'boolean', description: 'Also include plain text elements so the model can read the window. Defaults to true.' },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderTree(v) },
      async execute(args) {
        return await call({
          cmd: 'tree',
          pid: need(args.pid, 'pid'),
          windowId: args.windowId,
          max: args.max ?? 120,
          filter: args.filter,
          interactiveOnly: args.text !== false,
        })
      },
    },
    {
      name: 'vmouse_click',
      description: 'Click an element or a screen point inside a target app. Accessibility press is used when the element supports it; otherwise a mouse event is delivered to that process only. The user’s physical cursor and frontmost app are never touched.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          ref: { type: 'string', description: 'Element ref from vmouse_tree, e.g. "e12". Use this whenever possible.' },
          x: { type: 'number', description: 'Global screen x, for apps without a usable element tree. Ignored when ref is given.' },
          y: { type: 'number', description: 'Global screen y, paired with x.' },
          clicks: { type: 'integer', description: '1 (default) or 2 for double click.' },
          button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button, defaults to left.' },
          modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifier keys held during the click: cmd, shift, ctrl, opt.' },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(`clicked ${v.ref || `(${v.at.join(',')})`} via ${v.how} · physical cursor untouched`),
      },
      async execute(args) {
        if (args.ref === undefined && (args.x === undefined || args.y === undefined)) {
          throw fail('vmouse: give either ref (from vmouse_tree) or both x and y')
        }
        return await call({
          cmd: 'click',
          pid: need(args.pid, 'pid'),
          ref: args.ref,
          x: args.x,
          y: args.y,
          clicks: args.clicks ?? 1,
          button: args.button ?? 'left',
          modifiers: args.modifiers,
        })
      },
    },
    {
      name: 'vmouse_type',
      description: 'Type text into an element of a target app, or into the app’s focused field. Uses the accessibility value attribute when the element supports it, otherwise delivers Unicode key events to that process. Nothing is typed into the user’s own focused window.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          text: { type: 'string', description: 'Text to enter. CJK and emoji are supported.' },
          ref: { type: 'string', description: 'Element ref from vmouse_tree. Strongly recommended: it pins the destination.' },
        },
        required: ['pid', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(`typed ${v.chars ?? '?'} chars via ${v.how} · physical cursor untouched`),
      },
      async execute(args) {
        return await call({ cmd: 'type', pid: need(args.pid, 'pid'), text: need(args.text, 'text'), ref: args.ref })
      },
    },
    {
      name: 'vmouse_key',
      description: 'Send a keyboard shortcut to a target app, e.g. "cmd+s", "cmd+shift+z", "return", "tab", "esc", "down". Delivered to that process only.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          keys: { type: 'string', description: 'Combination such as "cmd+s" or a single key such as "return".' },
        },
        required: ['pid', 'keys'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(`sent ${v.keys} via ${v.how} · physical cursor untouched`),
      },
      async execute(args) {
        return await call({ cmd: 'key', pid: need(args.pid, 'pid'), keys: need(args.keys, 'keys') })
      },
    },
    {
      name: 'vmouse_scroll',
      description: 'Scroll inside a target app at an element, a point, or the window centre. Delivered to that process only; the physical cursor stays put.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          ref: { type: 'string', description: 'Element ref to scroll over.' },
          x: { type: 'number', description: 'Global screen x to scroll over.' },
          y: { type: 'number', description: 'Global screen y, paired with x.' },
          dy: { type: 'integer', description: 'Vertical delta; positive scrolls down. Defaults to 0.' },
          dx: { type: 'integer', description: 'Horizontal delta; positive scrolls right. Defaults to 0.' },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(`scrolled dy=${v.dy} dx=${v.dx} at ${v.at.join(',')} via ${v.how} · physical cursor untouched`),
      },
      async execute(args) {
        if (args.ref === undefined && (args.x === undefined || args.y === undefined) && !(args.dy || args.dx)) {
          throw fail('vmouse: give ref or x/y, plus dy and/or dx')
        }
        return await call({ cmd: 'scroll', pid: need(args.pid, 'pid'), ref: args.ref, x: args.x, y: args.y, dy: args.dy ?? 0, dx: args.dx ?? 0 })
      },
    },
    {
      name: 'vmouse_shot',
      description: 'Capture one window of a target app to a PNG file (works while it is in the background) and return the path. Open the file with read_image when you need to look at pixels; prefer vmouse_tree for reading UI text.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          windowId: { type: 'integer', description: 'Window id from vmouse_apps; defaults to the app’s first on-screen window.' },
          maxSide: { type: 'integer', description: 'Longest edge in pixels after downscaling, 320–2560. Defaults to 1280.' },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => text(`saved ${v.path} (window ${v.windowId}, ${v.bytes} bytes) — use read_image to view it`),
      },
      async execute(args) {
        const result = await call({
          cmd: 'shot',
          pid: need(args.pid, 'pid'),
          windowId: args.windowId,
          maxSide: args.maxSide ?? 1280,
        })
        const path = join(tmpdir(), `vmouse-shot-${result.windowId}-${Date.now()}.png`)
        const { writeFileSync } = await import('node:fs')
        writeFileSync(path, Buffer.from(result.png, 'base64'))
        return { ok: true, windowId: result.windowId, bytes: result.bytes, path }
      },
    },
  ]
}
