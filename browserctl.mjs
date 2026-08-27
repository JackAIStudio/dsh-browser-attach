#!/usr/bin/env node
/**
 * browserctl — control the user's real Chrome over CDP (attach mode).
 * Zero dependencies. Node >= 21 (global WebSocket).
 *
 * Usage: node browserctl.mjs <command> [args] [--json]
 *
 * Every command is transparently routed through a local daemon (127.0.0.1:9223)
 * that holds ONE persistent CDP connection to Chrome — Chrome only asks for the
 * remote-debugging consent dialog once per new connection, so a persistent
 * connection means one "允许" per Chrome session.
 *
 * Commands:
 *   doctor                       check CDP connectivity + environment
 *   tabs [--all]                 list tabs (default: only pages)
 *   open <url> [--activate]      open url in a new tab
 *   activate <id|url-substr>     bring a tab to front
 *   close <id|url-substr>        close a tab
 *   read [--url s] [--sel css] [--max n] [--json]
 *                                page text (title, url, innerText)
 *   shot [--url s] [--sel css] [--full] [--out path] [--json]
 *                                screenshot (full page / element)
 *   snapshot [--url s] [--json]  accessibility tree map with [ref] ids
 *   click <css|@ref|text> [--url s] [--text] [--json]
 *                                click by css ref or visible text
 *   type <text> [--sel css] [--url s] [--json]
 *                                set value + dispatch input/change (React-safe)
 *   eval <js> [--url s] [--json] evaluate JS, print value
 *   wait [--url s] [--state complete|title] [--sel css] [--timeout ms] [--json]
 *                                wait until page state matches
 *
 * Target selection: --url substr matches a tab; otherwise the last used tab,
 * otherwise the first page.
 *
 * Audit trail: ~/.config/browserctl/audit.jsonl  (append-only JSONL)
 * State:       ~/.config/browserctl/state.json   (last target id/url)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';

const CDP_WS = 'ws://127.0.0.1:9222/devtools/browser';
const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 9223;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'browserctl');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.jsonl');
const SHOT_DIR = path.join(process.cwd(), 'browser-shots');

// ---------- small utils ----------
function logAudit(entry) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    entry.ts = new Date().toISOString();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {}
}
function slug(s) {
  return String(s).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'page';
}
function trim(s, n) { return s && s.length > n ? s.slice(0, n) + ' …' : s; }

// ---------- tiny arg parser ----------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// ---------- CDP client ----------
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
  }
  open() {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP connect timeout (is Chrome running with --remote-debugging-port=9222?)')), 5000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
      this.ws.onerror = () => { clearTimeout(t); rej(new Error('CDP connect failed: ' + CDP_WS)); };
      this.ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.id && this.pending.has(d.id)) {
          const p = this.pending.get(d.id);
          this.pending.delete(d.id);
          if (d.error) p.rej(new Error(`${p.method}: ${d.error.message}`));
          else p.res(d.result);
        }
      };
    });
  }
  send(method, params = {}, useSession = true) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify({
        id,
        method,
        params,
        ...(useSession && this.sessionId ? { sessionId: this.sessionId } : {}),
      }));
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    return sessionId;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------- shared CDP connection (daemon keeps it alive) ----------
let __shared = null;
async function getSharedCdp() {
  if (__shared && __shared.ws && __shared.ws.readyState === 1) return __shared;
  if (__shared) { try { __shared.ws.close(); } catch {} }
  __shared = new Cdp(CDP_WS);
  await __shared.open();
  return __shared;
}
function releaseCdp() {
  // Connection is shared across commands (daemon holds it); CLI wrapper closes at exit.
}

function spawnDaemon() {
  try {
    const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
      detached: true, stdio: 'ignore', cwd: process.cwd(),
    });
    child.unref();
  } catch {}
}

function callDaemon(argv, timeoutMs) {
  return new Promise((res, rej) => {
    const sock = net.connect(DAEMON_PORT, DAEMON_HOST);
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); rej(new Error('daemon not responding')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, argv }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const r = JSON.parse(line);
          clearTimeout(t); sock.destroy(); res(r); return;
        } catch {}
      }
    });
    sock.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

async function handleDaemonRequest(sock, req) {
  const logs = [];
  const oldLog = console.log, oldErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
  let code = 2;
  try { code = (await dispatch(req.argv)) ?? 0; } catch (e) { logs.push('✗ ' + e.message); code = e.usageError ? 2 : 1; }
  console.log = oldLog; console.error = oldErr;
  try { sock.write(JSON.stringify({ id: req.id, code, out: logs.join('\n') }) + '\n'); } catch {}
}

async function runDaemon() {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        handleDaemonRequest(sock, req).catch(() => {});
      }
    });
  });
  server.listen(DAEMON_PORT, DAEMON_HOST, () => {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(path.join(CONFIG_DIR, 'daemon.pid'), String(process.pid));
    } catch {}
  });
  // keep the process alive
  setInterval(() => {}, 1 << 30);
}

// ---------- helpers ----------
async function listPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets', {}, false);
  return targetInfos.filter((t) => t.type === 'page');
}

async function resolveTarget(cdp, spec) {
  const pages = await listPages(cdp);
  if (pages.length === 0) throw new Error('no page tabs found in the attached Chrome');
  if (spec) {
    if (pages.some((p) => p.targetId === spec)) return pages.find((p) => p.targetId === spec);
    const m = pages.filter((p) => p.url.includes(spec));
    if (m.length === 0) {
      throw new Error(`no tab matches "${spec}". Tabs:\n` +
        pages.map((p) => `  ${p.targetId}  ${trim(p.title, 40)}  ${p.url}`).join('\n'));
    }
    if (m.length > 1) throw new Error(`ambiguous "${spec}" matches ${m.length} tabs; use a more specific url substring or targetId`);
    return m[0];
  }
  const st = readState();
  if (st.lastTargetId && pages.some((p) => p.targetId === st.lastTargetId)) {
    return pages.find((p) => p.targetId === st.lastTargetId);
  }
  return pages[pages.length - 1];
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('JS error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

function remember(page) {
  writeState({ lastTargetId: page.targetId, lastUrl: page.url, at: new Date().toISOString() });
}

// ---------- commands ----------
async function cmdDoctor({ flags }) {
  const out = {};
  const cdp = await getSharedCdp();
  try {
    const v = await cdp.send('Browser.getVersion', {}, false);
    const { targetInfos } = await cdp.send('Target.getTargets', {}, false);
    const pages = targetInfos.filter((t) => t.type === 'page');
    const workers = targetInfos.filter((t) => t.type !== 'page').length;
    out.ok = true;
    out.chrome = v.product;
    out.cdp = CDP_WS;
    out.pages = pages.map((p) => ({ id: p.targetId.slice(0, 8), title: p.title, url: p.url }));
    out.otherTargets = workers;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  releaseCdp();
  if (flags.json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  if (!out.ok) {
    console.error('✗ CDP not reachable at ' + CDP_WS);
    console.error('  ' + out.error);
    console.error('  Fix: quit Chrome and relaunch with:');
    console.error('    open -a "Google Chrome" --args --remote-debugging-port=9222');
    console.error('  (or use a dedicated profile:');
    console.error('    open -a "Google Chrome" --args --user-data-dir="$HOME/.dsh/browser-profile" --remote-debugging-port=9222)');
    return 1;
  }
  console.log('✓ Chrome ' + out.chrome);
  console.log('✓ ' + out.pages.length + ' page tabs, ' + out.otherTargets + ' other targets');
  for (const p of out.pages.slice(0, 15)) console.log(`   ${p.id}  ${trim(p.title, 40)}  ${p.url}`);
  if (out.pages.length > 15) console.log(`   … and ${out.pages.length - 15} more`);
  console.log('audit: ' + AUDIT_FILE);
  return 0;
}

async function cmdTabs({ flags }) {
  const cdp = await getSharedCdp();
  const { targetInfos } = await cdp.send('Target.getTargets', {}, false);
  releaseCdp();
  const pages = targetInfos.filter((t) => t.type === 'page');
  const rows = pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }));
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  console.log(`${rows.length} tab(s):`);
  rows.forEach((p, i) => console.log(`  [${i + 1}] ${p.targetId}  ${trim(p.title, 50)}  ${p.url}`));
  return 0;
}

async function cmdOpen({ positional, flags }) {
  const url = positional[0];
  if (!url) throw usage('open <url>');
  const cdp = await getSharedCdp();
  const { targetId } = await cdp.send('Target.createTarget', { url }, false);
  if (flags.activate) await cdp.send('Target.activateTarget', { targetId }, false);
  releaseCdp();
  remember({ targetId, url });
  logAudit({ cmd: 'open', url, ok: true });
  if (flags.json) { console.log(JSON.stringify({ targetId, url })); return 0; }
  console.log(`opened ${url}  (targetId ${targetId})`);
  return 0;
}

async function resolveOne(pages, spec, what) {
  if (!spec) throw usage(`activate|close needs <id|url-substr>`);
  const byId = pages.find((p) => p.targetId === spec);
  if (byId) return byId;
  const m = pages.filter((p) => p.url.includes(spec));
  if (m.length === 0) throw new Error(`no tab matches "${spec}"`);
  if (m.length > 1) throw new Error(`ambiguous "${spec}" matches ${m.length} tabs`);
  return m[0];
}

async function cmdActivate({ positional }) {
  const cdp = await getSharedCdp();
  const pages = await listPages(cdp);
  const page = await resolveOne(pages, positional[0]);
  await cdp.send('Target.activateTarget', { targetId: page.targetId }, false);
  releaseCdp();
  remember(page);
  logAudit({ cmd: 'activate', url: page.url, ok: true });
  console.log(`activated: ${page.url}`);
  return 0;
}

async function cmdClose({ positional }) {
  const cdp = await getSharedCdp();
  const pages = await listPages(cdp);
  const page = await resolveOne(pages, positional[0]);
  await cdp.send('Target.closeTarget', { targetId: page.targetId }, false);
  releaseCdp();
  logAudit({ cmd: 'close', url: page.url, ok: true });
  console.log(`closed: ${page.url}`);
  return 0;
}

async function cmdRead({ flags }) {
  const max = parseInt(flags.max || '6000', 10);
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  const selExpr = flags.sel
    ? `(document.querySelector(${JSON.stringify(flags.sel)})||document.body)`
    : `(document.body||document.documentElement)`;
  const raw = await evalJs(cdp, `(()=>{
    const el = ${selExpr};
    return JSON.stringify({
      title: document.title,
      url: location.href,
      ready: document.readyState,
      text: (el&&el.innerText?el.innerText:'').slice(0,${max})
    });
  })()`);
  releaseCdp();
  const data = JSON.parse(raw);
  remember(page);
  logAudit({ cmd: 'read', url: page.url, ok: true, chars: data.text.length });
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); return 0; }
  console.log(`# ${data.title}`);
  console.log(`url: ${data.url}   ready: ${data.ready}`);
  console.log('---');
  console.log(data.text || '(empty page)');
  return 0;
}

async function cmdShot({ flags }) {
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  const params = { format: 'png' };
  if (flags.full) params.captureBeyondViewport = true;
  if (flags.sel) {
    const rect = await evalJs(cdp, `(()=>{
      const el=document.querySelector(${JSON.stringify(flags.sel)});
      if(!el) return null;
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height});
    })()`);
    if (!rect) { cdp.close(); throw new Error('selector not found: ' + flags.sel); }
    const r = JSON.parse(rect);
    if (r.w < 1 || r.h < 1) { cdp.close(); throw new Error('element has zero size: ' + flags.sel); }
    params.clip = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.ceil(r.w), height: Math.ceil(r.h), scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', params);
  releaseCdp();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = flags.out ? path.resolve(flags.out) : path.join(SHOT_DIR, `${stamp}-${slug(page.url)}.png`);
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  remember(page);
  logAudit({ cmd: 'shot', url: page.url, ok: true, out, bytes: Buffer.byteLength(data, 'base64') });
  if (flags.json) { console.log(JSON.stringify({ path: out, url: page.url })); return 0; }
  console.log('screenshot: ' + out);
  return 0;
}

async function cmdSnapshot({ flags }) {
  const cap = parseInt(flags.max || '250', 10);
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  releaseCdp();
  const keep = nodes.filter((n) => !n.ignored && (n.role?.value || '') !== 'none' && (n.name?.value || n.role?.value));
  const rows = [];
  let ref = 0;
  for (const n of keep) {
    if (rows.length >= cap) break;
    const role = (n.role?.value || 'generic').toLowerCase();
    const name = (n.name?.value || '').replace(/\s+/g, ' ').trim();
    const props = {};
    for (const p of n.properties || []) {
      if (['url', 'placeholder', 'value', 'checked', 'haspopup', 'expanded', 'readonly'].includes(p.name)) {
        props[p.name] = String(p.value?.value ?? '');
      }
    }
    rows.push({ ref: ref++, role, name: name.slice(0, 120), ...props, backendDOMNodeId: n.backendDOMNodeId });
  }
  remember(page);
  logAudit({ cmd: 'snapshot', url: page.url, ok: true, nodes: rows.length });
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  for (const r of rows) {
    const extra = r.url ? ` url=${r.url}` : r.placeholder ? ` placeholder="${r.placeholder}"` : r.value ? ` value="${r.value}"` : '';
    console.log(`[${r.ref}] ${r.role} "${r.name}"${extra}`);
  }
  console.log(`${rows.length} node(s) shown (full tree may be larger)`);
  return 0;
}

async function cmdClick({ positional, flags }) {
  const spec = positional[0];
  if (!spec) throw usage('click <css|@ref|text>');
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  let clicked = null;
  if (spec.startsWith('@')) {
    const refNum = parseInt(spec.slice(1), 10);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const keep = nodes.filter((n) => !n.ignored && n.name?.value);
    const node = keep[refNum];
    if (!node?.backendDOMNodeId) throw new Error('@ref ' + refNum + ' not found in accessibility tree');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); this.click(); return true; }',
      returnByValue: true,
    });
    clicked = node.name.value.slice(0, 120);
  } else if (flags.text) {
    const label = spec;
    clicked = await evalJs(cdp, `(()=>{
      const t=${JSON.stringify(label)};
      const cands=[...document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],input[type=submit],summary,label')];
      const el=cands.find(e=>e.offsetParent!==null && ((e.innerText||e.value||e.getAttribute('aria-label')||e.textContent||'')).trim().includes(t));
      if(!el) return null;
      el.scrollIntoView({block:'center'}); el.click(); return (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,120);
    })()`);
    if (clicked === null) throw new Error('no visible element matching text: ' + label);
  } else {
    const sel = spec;
    clicked = await evalJs(cdp, `(()=>{
      const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null;
      el.scrollIntoView({block:'center'}); el.click();
      return (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,120)||el.tagName;
    })()`);
    if (clicked === null) throw new Error('selector not found: ' + sel);
  }
  releaseCdp();
  remember(page);
  logAudit({ cmd: 'click', target: spec, url: page.url, ok: true, clicked });
  if (flags.json) { console.log(JSON.stringify({ clicked, url: page.url })); return 0; }
  console.log('clicked: ' + clicked);
  return 0;
}

async function cmdType({ positional, flags }) {
  const text = positional[0] ?? '';
  if (!text) throw usage('type <text>');
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  const ok = await evalJs(cdp, `(()=>{
    const sel=${JSON.stringify(flags.sel || 'input,textarea,[contenteditable]')};
    const el=document.querySelector(sel)||document.querySelector('input,textarea,[contenteditable]');
    if(!el) return false;
    el.focus();
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(text)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      el.textContent=${JSON.stringify(text)};
      el.dispatchEvent(new Event('input',{bubbles:true}));
    }
    return true;
  })()`);
  releaseCdp();
  if (!ok) throw new Error('no input element found');
  remember(page);
  logAudit({ cmd: 'type', url: page.url, ok: true, chars: text.length });
  if (flags.json) { console.log(JSON.stringify({ typed: text.slice(0, 60), url: page.url })); return 0; }
  console.log('typed ' + text.length + ' chars into input on ' + page.url);
  return 0;
}

async function cmdEval({ positional, flags }) {
  const expr = positional[0];
  if (!expr) throw usage('eval <js>');
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  const value = await evalJs(cdp, expr);
  releaseCdp();
  remember(page);
  logAudit({ cmd: 'eval', url: page.url, ok: true });
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  console.log(text);
  return 0;
}

async function cmdWait({ flags }) {
  const timeout = parseInt(flags.timeout || '20000', 10);
  const state = flags.state || 'complete';
  const sel = flags.sel;
  const cdp = await getSharedCdp();
  const page = await resolveTarget(cdp, flags.url);
  await cdp.attach(page.targetId);
  const deadline = Date.now() + timeout;
  let data = null;
  while (Date.now() < deadline) {
    data = JSON.parse(await evalJs(cdp, `JSON.stringify({
      ready: document.readyState,
      hasSel: ${sel ? `!!document.querySelector(${JSON.stringify(sel)})` : 'true'},
      title: document.title, url: location.href
    })`));
    const okState = state === 'complete' ? data.ready === 'complete' : state === 'title' ? true : data.ready === 'complete';
    if (okState && data.hasSel) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  releaseCdp();
  remember(page);
  logAudit({ cmd: 'wait', url: page.url, ok: true, state, sel: sel || null });
  if (flags.json) { console.log(JSON.stringify(data)); return 0; }
  console.log(`waited: ready=${data.ready} title="${data.title}" url=${data.url}`);
  return 0;
}

function usage(hint) {
  return Object.assign(new Error('usage: browserctl ' + hint), { usageError: true });
}

// ---------- main ----------
const handlers = { doctor: cmdDoctor, tabs: cmdTabs, open: cmdOpen, activate: cmdActivate, close: cmdClose, read: cmdRead, shot: cmdShot, snapshot: cmdSnapshot, click: cmdClick, type: cmdType, eval: cmdEval, wait: cmdWait };

async function dispatch(argv) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd) throw usage('doctor|tabs|open|activate|close|read|shot|snapshot|click|type|eval|wait');
  positional.shift();
  const fn = handlers[cmd];
  if (!fn) throw usage('unknown command: ' + cmd);
  return await fn({ positional, flags });
}

async function runDirect(argv) {
  const logs = [];
  const oldLog = console.log, oldErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
  let code = 2;
  try { code = (await dispatch(argv)) ?? 0; } catch (e) { logs.push('✗ ' + e.message); code = e.usageError ? 2 : 1; }
  console.log = oldLog; console.error = oldErr;
  if (__shared) { try { __shared.ws.close(); } catch {} }
  return { code, out: logs.join('\n') };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'daemon') { await runDaemon(); return; }
  try {
    const r = await callDaemon(argv, 3000);
    process.stdout.write(r.out);
    process.exit(r.code);
  } catch {
    spawnDaemon();
    try {
      const r = await callDaemon(argv, 6000);
      process.stdout.write(r.out);
      process.exit(r.code);
    } catch {
      const r = await runDirect(argv);
      process.stdout.write(r.out);
      process.exit(r.code);
    }
  }
}

main();
