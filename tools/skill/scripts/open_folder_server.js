#!/usr/bin/env node
/**
 * workspace-scanner local helper: open folders/files in Windows Explorer.
 *
 * This server intentionally listens only on 127.0.0.1 and only opens paths
 * that are inside the latest scanned WorkBuddy workspace list.
 *
 * Usage:
 *   node open_folder_server.js
 *   node open_folder_server.js --port 17365 --scan-json C:/Users/archili/AppData/Local/Temp/scan_out.json
 *
 * Endpoints:
 *   GET /
 *   GET /workspaces.html
 *   GET /health
 *   GET /open?path=<encoded absolute path>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { URL } = require('url');

const DEFAULT_PORT = 17365;
const DEFAULT_SCAN_JSON = 'C:/Users/archili/AppData/Local/Temp/scan_out.json';
const DEFAULT_HTML = 'C:/Users/archili/.workbuddy/memory/workspaces.html';
const DEFAULT_LOG = 'C:/Users/archili/.workbuddy/memory/workspace-open-helper.log';
const HOST = '127.0.0.1';

function readArgs() {
  const args = process.argv.slice(2);
  const out = { port: DEFAULT_PORT, scanJson: DEFAULT_SCAN_JSON, htmlFile: DEFAULT_HTML, logFile: DEFAULT_LOG };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) out.port = Number(args[++i]);
    else if (args[i] === '--scan-json' && args[i + 1]) out.scanJson = args[++i];
    else if (args[i] === '--html' && args[i + 1]) out.htmlFile = args[++i];
    else if (args[i] === '--log' && args[i + 1]) out.logFile = args[++i];
  }
  return out;
}

function toWinPath(p) {
  return String(p || '').replace(/^file:\/\/\//i, '').replace(/\//g, '\\');
}

function normalizeWin(p) {
  return path.win32.normalize(toWinPath(decodeURIComponent(String(p || ''))));
}

function lowerNorm(p) {
  return normalizeWin(p).toLowerCase();
}

function loadAllowedRoots(scanJson) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(scanJson, 'utf-8'));
  } catch (e) {
    throw new Error(`无法读取扫描 JSON: ${scanJson} (${e.message})`);
  }
  const roots = [];
  for (const s of data.spaces || []) {
    if (s.path) roots.push(normalizeWin(s.path));
  }
  // Deduplicate by lower-case normalized path.
  const seen = new Set();
  return roots.filter(r => {
    const key = r.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAllowed(target, roots) {
  const t = lowerNorm(target);
  return roots.some(root => {
    const r = lowerNorm(root);
    return t === r || t.startsWith(r.endsWith('\\') ? r : `${r}\\`);
  });
}

function statTarget(target) {
  try { return fs.statSync(target); } catch { return null; }
}

function spawnDetached(command, args) {
  const child = cp.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

function openDirectory(target) {
  // Use cmd/start so Windows ShellExecute handles the folder, which is more visible/stable than raw explorer.exe from Node.
  const pid = spawnDetached('cmd.exe', ['/c', 'start', '', target]);
  return { action: 'open-directory', opened: target, command: 'cmd.exe /c start', pid };
}

function selectFile(target, action = 'select-file') {
  // Explorer expects /select,<path> as one argument. Splitting '/select,' and path can silently fail on some systems.
  const pid = spawnDetached('explorer.exe', [`/select,${target}`]);
  return { action, opened: target, command: 'explorer.exe /select,<path>', pid };
}

function minimalPowerShellEnv(extra = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'Path', 'PATH', 'TEMP', 'TMP', 'ComSpec', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function focusExplorerTarget(focusTarget) {
  if (process.platform !== 'win32') {
    return { focused: false, focusMethod: 'none', focusError: 'not running on Windows' };
  }

  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targetRaw = $env:WB_FOCUS_TARGET
if ([string]::IsNullOrWhiteSpace($targetRaw)) {
  @{ ok = $false; method = 'set-foreground'; error = 'missing target' } | ConvertTo-Json -Compress
  exit 0
}

Start-Sleep -Milliseconds 450

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WbExplorerFocusNative {
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@

$target = [System.IO.Path]::GetFullPath($targetRaw).TrimEnd('\')
$shell = New-Object -ComObject Shell.Application
foreach ($window in @($shell.Windows())) {
  try {
    $fullName = [string]$window.FullName
    if ([System.IO.Path]::GetFileName($fullName) -ine 'explorer.exe') { continue }
    $location = [string]$window.Document.Folder.Self.Path
    if ([string]::IsNullOrWhiteSpace($location)) { continue }
    $locationFull = [System.IO.Path]::GetFullPath($location).TrimEnd('\')
    if ($locationFull -ieq $target) {
      $hwnd = [IntPtr]([int64]$window.HWND)
      [WbExplorerFocusNative]::ShowWindowAsync($hwnd, 9) | Out-Null
      $ok = [WbExplorerFocusNative]::SetForegroundWindow($hwnd)
      @{ ok = [bool]$ok; method = 'set-foreground'; hwnd = [int64]$window.HWND; location = $locationFull } | ConvertTo-Json -Compress
      exit 0
    }
  } catch {}
}

@{ ok = $false; method = 'set-foreground'; error = 'matching Explorer window not found'; target = $target } | ConvertTo-Json -Compress
exit 0
`;

  try {
    const out = cp.execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      encoding: 'utf-8',
      env: minimalPowerShellEnv({ WB_FOCUS_TARGET: focusTarget }),
      timeout: 4000,
      windowsHide: true,
    }).trim();
    const line = out.split(/\r?\n/).filter(Boolean).pop();
    const parsed = line ? JSON.parse(line) : null;
    if (parsed && parsed.ok) {
      return { focused: true, focusMethod: parsed.method || 'set-foreground', focusHwnd: parsed.hwnd, focusLocation: parsed.location };
    }
    return {
      focused: false,
      focusMethod: parsed && parsed.method ? parsed.method : 'set-foreground',
      focusError: parsed && parsed.error ? parsed.error : 'focus command did not return success',
      focusLocation: parsed && parsed.location,
    };
  } catch (e) {
    return { focused: false, focusMethod: 'set-foreground', focusError: e.message };
  }
}

function withFocus(result, focusTarget) {
  return { ...result, ...focusExplorerTarget(focusTarget) };
}

function openExplorer(target) {
  const st = statTarget(target);
  if (!st) {
    const parent = path.win32.dirname(target);
    if (fs.existsSync(parent)) return withFocus(selectFile(target, 'select-missing-target-parent'), parent);
    throw new Error('路径不存在');
  }
  if (st.isDirectory()) return withFocus(openDirectory(target), target);
  return withFocus(selectFile(target), path.win32.dirname(target));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res, htmlFile) {
  let html;
  try {
    html = fs.readFileSync(htmlFile, 'utf-8');
  } catch (e) {
    return send(res, 500, { ok: false, error: `cannot read html: ${e.message}`, htmlFile });
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function appendLog(logFile, event, payload = {}) {
  const row = { ts: new Date().toISOString(), event, ...payload };
  const line = JSON.stringify(row);
  console.log(line);
  try { fs.appendFileSync(logFile, `${line}\n`, 'utf-8'); } catch (e) { console.error(`log write failed: ${e.message}`); }
}

function tailLog(logFile, limit = 80) {
  try {
    const text = fs.readFileSync(logFile, 'utf-8');
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch { return []; }
}

function main() {
  const { port, scanJson, htmlFile, logFile } = readArgs();
  let roots = loadAllowedRoots(scanJson);
  appendLog(logFile, 'server-start', { port, scanJson, htmlFile, roots: roots.length });
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const url = new URL(req.url, `http://${HOST}:${port}`);
    if (url.pathname === '/') return redirect(res, '/workspaces.html');
    if (url.pathname === '/workspaces.html') return sendHtml(res, htmlFile);
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, roots: roots.length, scanJson, htmlFile, logFile, workspacesUrl: `http://${HOST}:${port}/workspaces.html` });
    }
    if (url.pathname === '/logs') {
      return send(res, 200, { ok: true, logFile, logs: tailLog(logFile, Number(url.searchParams.get('limit') || 80)) });
    }
    if (url.pathname === '/reload') {
      try {
        roots = loadAllowedRoots(scanJson);
        appendLog(logFile, 'reload', { roots: roots.length });
        return send(res, 200, { ok: true, roots: roots.length });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }
    if (url.pathname !== '/open') return send(res, 404, { ok: false, error: 'not found' });
    const rawPath = url.searchParams.get('path');
    appendLog(logFile, 'open-request', { rawPath, referer: req.headers.referer || null, userAgent: req.headers['user-agent'] || null });
    if (!rawPath) {
      appendLog(logFile, 'open-error', { error: 'missing path' });
      return send(res, 400, { ok: false, error: 'missing path' });
    }
    let target;
    try { target = normalizeWin(rawPath); } catch {
      appendLog(logFile, 'open-error', { rawPath, error: 'bad path' });
      return send(res, 400, { ok: false, error: 'bad path' });
    }
    const allowed = isAllowed(target, roots);
    const exists = !!statTarget(target);
    appendLog(logFile, 'open-check', { target, allowed, exists });
    if (!allowed) {
      appendLog(logFile, 'open-denied', { target, error: 'path is outside scanned workspaces' });
      return send(res, 403, { ok: false, error: 'path is outside scanned workspaces', path: target });
    }
    try {
      const result = openExplorer(target);
      appendLog(logFile, 'open-success', { target, ...result });
      return send(res, 200, { ok: true, path: target, ...result });
    } catch (e) {
      appendLog(logFile, 'open-error', { target, error: e.message });
      return send(res, 500, { ok: false, error: e.message, path: target });
    }
  });

  server.listen(port, HOST, () => {
    console.log(`workspace-scanner helper listening on http://${HOST}:${port}`);
    console.log(`workspace table: http://${HOST}:${port}/workspaces.html`);
    console.log(`debug logs: http://${HOST}:${port}/logs`);
    console.log(`log file: ${logFile}`);
    console.log(`allowed roots loaded from: ${scanJson} (${roots.length})`);
  });
}

main();
