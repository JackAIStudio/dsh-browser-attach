/**
 * dsh-browser-attach · Host plugin
 *
 * Registers browser_* tools that talk to the local browserctl daemon
 * (one persistent CDP connection to the user's real Chrome).
 */
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-browser-attach'
export const inject = []

const DAEMON_HOST = '127.0.0.1'
const DAEMON_PORT = 9223
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browserctl.mjs')

function spawnDaemon() {
  try {
    const child = spawn(process.execPath, [CLI, 'daemon'], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    })
    child.unref()
  } catch {}
}

function callDaemon(argv, timeoutMs) {
  return new Promise((res, rej) => {
    const sock = net.connect(DAEMON_PORT, DAEMON_HOST)
    let buf = ''
    const t = setTimeout(() => {
      sock.destroy()
      rej(new Error('browserctl daemon not responding'))
    }, timeoutMs)
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, argv }) + '\n'))
    sock.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const r = JSON.parse(line)
          clearTimeout(t)
          sock.destroy()
          res(r)
          return
        } catch {}
      }
    })
    sock.on('error', (e) => {
      clearTimeout(t)
      rej(e)
    })
  })
}

async function runCtl(argv) {
  let r
  try {
    r = await callDaemon(argv, 4000)
  } catch {
    spawnDaemon()
    r = await callDaemon(argv, 8000)
  }
  const out = String(r.out || '')
  if (r.code !== 0) {
    const err = new Error(out || `browserctl exited ${r.code}`)
    err.output = out
    throw err
  }
  return out
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: { text: { type: 'string' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value && value.text != null ? value.text : value) }]
    },
  }
}

function def(name, description, parameters, toArgv) {
  return {
    name,
    description,
    parameters,
    output: textOutput(),
    async execute(args) {
      const argv = toArgv(args && typeof args === 'object' ? args : {})
      const text = await runCtl(argv)
      return { text }
    },
  }
}

function pushFlag(argv, flag, value) {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

const TOOLS = [
  def(
    'browser_doctor',
    'Check whether the user\'s real Chrome is reachable over CDP (attach mode, existing login state). Returns Chrome version and open tabs. Use this first if browser tools fail.',
    { type: 'object', properties: {} },
    () => ['doctor'],
  ),
  def(
    'browser_tabs',
    'List open page tabs in the user\'s real Chrome (title, url, targetId).',
    { type: 'object', properties: {} },
    () => ['tabs'],
  ),
  def(
    'browser_open',
    'Open a URL in a new tab of the user\'s real Chrome. The tab appears on their screen. Reuses existing login cookies.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        activate: { type: 'boolean', description: 'Bring the new tab to the front' },
      },
      required: ['url'],
    },
    (a) => {
      const argv = ['open', String(a.url)]
      if (a.activate) argv.push('--activate')
      return argv
    },
  ),
  def(
    'browser_read',
    'Read the current (or matched) tab. format=text (default, cheap): innerText. format=both: text + screenshot path. format=visual: screenshot only. Use --url substring to pick a tab.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Tab URL substring to select' },
        selector: { type: 'string', description: 'Optional CSS selector; read only that element' },
        max: { type: 'integer', description: 'Max innerText characters (default 6000)' },
        format: {
          type: 'string',
          enum: ['text', 'both', 'visual'],
          description: 'text (default) | both | visual',
        },
      },
    },
    (a) => {
      // handled specially below
      return ['read']
    },
  ),
  def(
    'browser_shot',
    'Screenshot the current (or matched) tab. Saves a PNG under ./browser-shots and returns the path. Use format=visual via browser_read if you also need text.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Tab URL substring to select' },
        selector: { type: 'string', description: 'Optional CSS selector to crop to an element' },
        full: { type: 'boolean', description: 'Capture beyond the viewport (full page)' },
        out: { type: 'string', description: 'Optional output PNG path' },
      },
    },
    (a) => {
      const argv = ['shot']
      pushFlag(argv, '--url', a.url)
      pushFlag(argv, '--sel', a.selector)
      if (a.full) argv.push('--full')
      pushFlag(argv, '--out', a.out)
      return argv
    },
  ),
  def(
    'browser_snapshot',
    'Accessibility tree of the current (or matched) tab, with [ref] numbers for clicking. Prefer this before browser_click when CSS is unknown.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Tab URL substring to select' },
      },
    },
    (a) => {
      const argv = ['snapshot']
      pushFlag(argv, '--url', a.url)
      return argv
    },
  ),
  def(
    'browser_click',
    'Click an element in the user\'s Chrome. by=css (default) uses a CSS selector; by=text matches visible button/link text; by=ref uses a [ref] from browser_snapshot. Confirm with the user before publish/delete/pay clicks.',
    {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector, visible text, or snapshot ref number' },
        by: { type: 'string', enum: ['css', 'text', 'ref'], description: 'How to interpret target (default css)' },
        url: { type: 'string', description: 'Tab URL substring to select' },
      },
      required: ['target'],
    },
    (a) => {
      const by = a.by || 'css'
      const spec = by === 'ref' ? '@' + String(a.target).replace(/^@/, '') : String(a.target)
      const argv = ['click', spec]
      if (by === 'text') argv.push('--text')
      pushFlag(argv, '--url', a.url)
      return argv
    },
  ),
  def(
    'browser_type',
    'Type into an input/textarea (React-safe native setter). Do not type passwords, payment info, or OTP codes — ask the user to type those themselves.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to insert' },
        selector: { type: 'string', description: 'CSS selector of the input (default: first input/textarea)' },
        url: { type: 'string', description: 'Tab URL substring to select' },
      },
      required: ['text'],
    },
    (a) => {
      const argv = ['type', String(a.text)]
      pushFlag(argv, '--sel', a.selector)
      pushFlag(argv, '--url', a.url)
      return argv
    },
  ),
  def(
    'browser_eval',
    'Evaluate JavaScript in the page and return the value. Read-only by default; confirm before mutations.',
    {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression' },
        url: { type: 'string', description: 'Tab URL substring to select' },
      },
      required: ['expression'],
    },
    (a) => {
      const argv = ['eval', String(a.expression)]
      pushFlag(argv, '--url', a.url)
      return argv
    },
  ),
  def(
    'browser_wait',
    'Wait until the tab is ready (document.complete) and optionally until a CSS selector exists. Call after open/click navigations.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Tab URL substring to select' },
        selector: { type: 'string', description: 'Wait until this CSS selector exists' },
        timeout: { type: 'integer', description: 'Timeout in ms (default 20000)' },
      },
    },
    (a) => {
      const argv = ['wait']
      pushFlag(argv, '--url', a.url)
      pushFlag(argv, '--sel', a.selector)
      pushFlag(argv, '--timeout', a.timeout)
      return argv
    },
  ),
  def(
    'browser_activate',
    'Bring a tab to the front (user will see it). Identify by targetId or URL substring.',
    {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'targetId or URL substring' },
      },
      required: ['target'],
    },
    (a) => ['activate', String(a.target)],
  ),
  def(
    'browser_close',
    'Close a tab. Identify by targetId or URL substring. Confirm before closing tabs the user did not ask to close.',
    {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'targetId or URL substring' },
      },
      required: ['target'],
    },
    (a) => ['close', String(a.target)],
  ),
]

// browser_read is special: format=both/visual needs a screenshot too.
TOOLS[3] = {
  name: 'browser_read',
  description: 'Read the current (or matched) tab. format=text (default, cheap): innerText. format=both: text + screenshot path. format=visual: screenshot only. Attach mode: uses the user\'s real Chrome login state.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Tab URL substring to select' },
      selector: { type: 'string', description: 'Optional CSS selector; read only that element' },
      max: { type: 'integer', description: 'Max innerText characters (default 6000)' },
      format: {
        type: 'string',
        enum: ['text', 'both', 'visual'],
        description: 'text (default) | both | visual',
      },
    },
  },
  output: textOutput(),
  async execute(args) {
    const a = args && typeof args === 'object' ? args : {}
    const format = a.format || 'text'
    const parts = []
    if (format !== 'visual') {
      const argv = ['read']
      pushFlag(argv, '--url', a.url)
      pushFlag(argv, '--sel', a.selector)
      pushFlag(argv, '--max', a.max)
      parts.push(await runCtl(argv))
    }
    if (format === 'both' || format === 'visual') {
      const argv = ['shot']
      pushFlag(argv, '--url', a.url)
      pushFlag(argv, '--sel', a.selector)
      parts.push(await runCtl(argv))
    }
    return { text: parts.join('\n') }
  },
}

export function apply(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    const disposers = []
    for (const tool of TOOLS) {
      try {
        disposers.push(toolCtx.tools.register(tool))
      } catch (error) {
        ctx.logger?.error?.('dsh-browser-attach: failed to register ' + tool.name)
        ctx.logger?.error?.(error)
      }
    }
    toolCtx.effect(() => () => {
      for (const d of disposers) {
        try { if (typeof d === 'function') d() } catch {}
      }
    })
  })
}
