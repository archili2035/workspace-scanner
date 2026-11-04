#!/usr/bin/env node
/**
 * 把 scan.js 的 JSON 输出渲染成单文件 HTML（v7 / iframe explorer helper）。
 *
 * 用法：
 *   node scan.js | node build_html.js > workspaces.html
 *   或：node build_html.js --in scan_out.json --out workspaces.html
 *   分享版：node build_html.js --in scan_out.json --out workspaces_share.html --share
 */

const fs = require('fs');

function readArgs() {
  const args = process.argv.slice(2);
  let inFile = null, outFile = null, shareMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in' && args[i + 1]) { inFile = args[++i]; }
    else if (args[i] === '--out' && args[i + 1]) { outFile = args[++i]; }
    else if (args[i] === '--share') { shareMode = true; }
  }
  return { inFile, outFile, shareMode };
}

function readInput(inFile) {
  if (inFile) return JSON.parse(fs.readFileSync(inFile, 'utf-8'));
  const chunks = [];
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(chunks.join(''))); } catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildHtml(data, options = {}) {
  const s = data.summary;
  const shareMode = !!options.shareMode;
  const pageTitle = shareMode ? 'WorkBuddy 工作空间清单（分享版）' : 'WorkBuddy 工作空间清单';
  const spacesJson = JSON.stringify(data.spaces).replace(/</g, '\\u003c');
  const sourceBanner = s.primarySource === 'sqlite'
    ? `<div class="banner banner-ok"><b>数据源正常：</b>当前快照由 <code>workbuddy.db</code> 生成，生成时读取 ${s.dbRowCount} 行，合并后 ${s.total} 个工作空间。</div>`
    : `<div class="banner banner-warn"><b>数据源降级：</b>当前快照主源为 <code>${esc(s.primarySource)}</code>，结果可能不完整。</div>`;
  const shareBanner = shareMode
    ? `<div class="banner banner-warn"><b>分享版静态快照：</b>本页面不连接 DB、不调用本地 helper、不访问 <code>localhost</code>；路径和产物信息仅供参考，打开目录/定位文件等本机操作已隐藏。</div>`
    : '';
  const helperPanel = shareMode ? '' : `<div class="debug-panel">
    <div class="debug-row">
      <span>Explorer helper 调试：</span>
      <button class="btn" id="testHelperBtn" type="button">测试 helper</button>
      <a class="link" href="/logs" target="_blank">查看服务端日志</a>
      <span id="helperStatus" class="debug-status">等待操作</span>
    </div>
  </div>`;
  const helperFrame = shareMode ? '' : '<iframe name="open_helper_frame" id="openHelperFrame" style="display:none;width:0;height:0;border:0" title="open helper"></iframe>';
  const footer = shareMode
    ? `由 <code>workspace-scanner</code> v7 生成 · 分享版静态快照 · 不依赖本机 DB / helper / localhost`
    : `由 <code>workspace-scanner</code> v7 生成 · Explorer 打开通过隐藏 iframe 触发本地 helper：<code>node open_folder_server.js</code> · 复制路径可作为兜底`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(pageTitle)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root {
  --bg: #0e1117;
  --bg-elev: #161b22;
  --bg-soft: #1c232d;
  --border: #2a3340;
  --border-strong: #3d4956;
  --text: #e6edf3;
  --text-mute: #8b949e;
  --text-soft: #b1bac4;
  --accent: #58a6ff;
  --ok: #3fb950;
  --ok-bg: #102818;
  --warn: #f0883e;
  --warn-bg: #3a2410;
  --info: #d2a8ff;
  --danger: #ff7b72;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.55;
}
code { font-family: ui-monospace, "SF Mono", Consolas, Monaco, monospace; background: rgba(110,118,129,0.16); padding: 1px 6px; border-radius: 4px; }
.layout { max-width: 1680px; margin: 0 auto; padding: 28px 28px 72px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 6px; font-size: 24px; font-weight: 650; letter-spacing: 0.3px; }
.sub { color: var(--text-mute); font-size: 13px; }
.stats { display: flex; gap: 12px; flex-wrap: wrap; }
.stat { min-width: 92px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elev); }
.stat-num { font-size: 22px; font-weight: 650; }
.stat-label { font-size: 12px; color: var(--text-mute); }
.stat.inUse .stat-num { color: var(--ok); }
.stat.historical .stat-num { color: var(--info); }
.stat.db .stat-num { color: var(--accent); }
.stat.miss .stat-num { color: var(--warn); }
.banner { margin: 16px 0; padding: 12px 14px; border-radius: 10px; font-size: 13px; color: var(--text-soft); }
.banner-ok { background: var(--ok-bg); border: 1px solid #1d4d2c; border-left: 4px solid var(--ok); }
.banner-warn { background: var(--warn-bg); border: 1px solid #5a3719; border-left: 4px solid var(--warn); }
.toolbar { position: sticky; top: 0; z-index: 5; margin: 18px 0 14px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: rgba(22,27,34,0.96); backdrop-filter: blur(8px); }
.toolbar-grid { display: grid; grid-template-columns: minmax(260px, 2fr) repeat(5, minmax(130px, 1fr)); gap: 10px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field label { color: var(--text-mute); font-size: 12px; }
input[type="search"], select { width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #0d1117; color: var(--text); padding: 8px 10px; outline: none; }
input[type="search"]:focus, select:focus { border-color: var(--accent); }
.column-panel { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.check-pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 999px; background: rgba(255,255,255,0.03); color: var(--text-soft); font-size: 12px; user-select: none; }
.check-pill input { accent-color: var(--accent); }
.table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elev); }
table { width: 100%; border-collapse: collapse; min-width: 1480px; }
thead th { text-align: left; white-space: nowrap; background: #111821; color: var(--text-soft); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border-strong); padding: 10px 12px; cursor: pointer; }
thead th:hover { color: var(--accent); }
tbody td { border-bottom: 1px solid var(--border); padding: 10px 12px; vertical-align: top; color: var(--text-soft); }
tbody tr:hover { background: rgba(88,166,255,0.06); }
.name { color: var(--text); font-weight: 600; white-space: nowrap; }
.desc { max-width: 300px; color: var(--text-soft); }
.progress { max-width: 360px; color: var(--text-soft); }
.link { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(88,166,255,0.35); }
.link:hover { color: #79c0ff; border-bottom-color: #79c0ff; }
.artifact { min-width: 190px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.action-btn { border: 1px solid rgba(88,166,255,0.32); border-radius: 999px; background: rgba(88,166,255,0.08); color: var(--accent); padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit; }
.action-btn:hover { background: rgba(88,166,255,0.16); border-color: rgba(88,166,255,0.56); }
.action-btn.secondary { color: var(--text-mute); border-color: var(--border); background: rgba(255,255,255,0.03); }
.action-btn.secondary:hover { color: var(--text-soft); border-color: var(--border-strong); }
.path { font-family: ui-monospace, "SF Mono", Consolas, Monaco, monospace; font-size: 12px; color: var(--text-mute); word-break: break-all; min-width: 260px; }
.badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; white-space: nowrap; }
.badge-inUse { color: var(--ok); background: rgba(63,185,80,0.11); border-color: rgba(63,185,80,0.28); }
.badge-historical { color: var(--info); background: rgba(210,168,255,0.10); border-color: rgba(210,168,255,0.22); }
.badge-raw { color: var(--text-mute); background: rgba(139,148,158,0.10); border-color: rgba(139,148,158,0.18); }
.badge-dbHit { color: var(--accent); background: rgba(88,166,255,0.10); border-color: rgba(88,166,255,0.26); }
.badge-storageHit { color: var(--info); background: rgba(210,168,255,0.10); border-color: rgba(210,168,255,0.22); }
.badge-miss { color: var(--warn); background: rgba(240,136,62,0.12); border-color: rgba(240,136,62,0.28); }
.muted { color: var(--text-mute); }
.empty { padding: 30px; text-align: center; color: var(--text-mute); }
.result-line { display: flex; justify-content: space-between; gap: 16px; margin: 10px 0 8px; color: var(--text-mute); font-size: 12px; }
.btn { border: 1px solid var(--border); border-radius: 8px; background: #0d1117; color: var(--text-soft); padding: 6px 10px; cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.debug-panel { margin: 12px 0; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: rgba(255,255,255,0.025); color: var(--text-mute); font-size: 12px; }
.debug-panel code { color: var(--text-soft); }
.debug-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.debug-status { color: var(--text-soft); }
.footer { margin-top: 30px; color: var(--text-mute); font-size: 12px; text-align: center; border-top: 1px solid var(--border); padding-top: 16px; }
@media (max-width: 980px) { .toolbar-grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<div class="layout">
  <div class="page-head">
    <div>
      <h1>${esc(pageTitle)}</h1>
      <div class="sub">扫描时间：${esc(fmtDate(s.scannedAt))} · 主源：<code>${esc(s.primarySource)}</code> · 聚合目录：${esc(s.aggregateDirsScanned.join(', '))}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-num">${s.total}</div><div class="stat-label">总数</div></div>
      <div class="stat inUse"><div class="stat-num">${s.byCategory.inUse}</div><div class="stat-label">使用中</div></div>
      <div class="stat historical"><div class="stat-num">${s.byCategory.historical}</div><div class="stat-label">历史项目</div></div>
      <div class="stat db"><div class="stat-num">${s.byRegistry.dbHit}</div><div class="stat-label">db 登记</div></div>
      <div class="stat miss"><div class="stat-num">${s.byRegistry.miss}</div><div class="stat-label">未注册</div></div>
    </div>
  </div>

  ${sourceBanner}
  ${shareBanner}

  <section class="toolbar" aria-label="筛选与表格设置">
    <div class="toolbar-grid">
      <div class="field"><label for="keyword">关键词筛选</label><input id="keyword" type="search" placeholder="名称 / 路径 / 描述 / 产物 / 进展" /></div>
      <div class="field"><label for="categoryFilter">状态</label><select id="categoryFilter"><option value="all">全部</option><option value="inUse">使用中</option><option value="historical">历史项目</option><option value="raw">裸目录</option></select></div>
      <div class="field"><label for="driveFilter">盘符</label><select id="driveFilter"><option value="all">全部</option></select></div>
      <div class="field"><label for="registryFilter">登记状态</label><select id="registryFilter"><option value="all">全部</option><option value="dbHit">db 已登记</option><option value="storageHit">storage 已登记</option><option value="miss">未注册</option></select></div>
      <div class="field"><label for="memoryFilter">Memory</label><select id="memoryFilter"><option value="all">全部</option><option value="has">有 memory</option><option value="none">无 memory</option></select></div>
      <div class="field"><label for="sortRule">排序规则</label><select id="sortRule"><option value="lastOpenedDesc">最近打开 ↓</option><option value="lastOpenedAsc">最近打开 ↑</option><option value="nameAsc">名称 A-Z</option><option value="categoryAsc">状态</option><option value="dailyDesc">daily 数 ↓</option><option value="driveAsc">盘符</option></select></div>
    </div>
    <div class="column-panel" id="columnControls"></div>
  </section>

  <div class="result-line"><span id="resultSummary">—</span><button class="btn" id="resetBtn" type="button">重置筛选</button></div>
  ${helperPanel}
  <div class="table-wrap">
    <table>
      <thead><tr id="tableHead"></tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>

  <div class="footer">${footer}</div>
</div>
${helperFrame}
<script id="spaces-data" type="application/json">${spacesJson}</script>
<script>
(function () {
  const SHARE_MODE = ${shareMode ? 'true' : 'false'};
  const spaces = JSON.parse(document.getElementById('spaces-data').textContent);
  const columns = [
    { key: 'category', label: '状态', visible: true },
    { key: 'name', label: '名称', visible: true },
    { key: 'description', label: '描述', visible: true },
    { key: 'artifact', label: '主要产物', visible: true },
    { key: 'progress', label: '当前进展', visible: true },
    { key: 'path', label: '路径', visible: true },
    { key: 'lastOpened', label: '最近打开', visible: true },
    { key: 'dailyCount', label: 'daily 数', visible: true },
    { key: 'drive', label: '盘符', visible: false },
    { key: 'memoryTime', label: 'Memory 更新', visible: false },
    { key: 'latestDaily', label: '最近 daily', visible: false },
    { key: 'registry', label: '登记', visible: false },
    { key: 'aggregate', label: '位置', visible: false }
  ];
  const state = { visible: Object.fromEntries(columns.map(c => [c.key, c.visible])) };

  const $ = id => document.getElementById(id);
  const els = {
    keyword: $('keyword'), category: $('categoryFilter'), drive: $('driveFilter'), registry: $('registryFilter'), memory: $('memoryFilter'), sort: $('sortRule'),
    columnControls: $('columnControls'), head: $('tableHead'), body: $('tableBody'), summary: $('resultSummary'), reset: $('resetBtn'), helperStatus: $('helperStatus'), testHelper: $('testHelperBtn')
  };

  function categoryLabel(v) { return ({ inUse: '使用中', historical: '历史项目', raw: '裸目录' })[v] || v || '—'; }
  function registryLabel(v) { return ({ dbHit: 'db 已登记', storageHit: 'storage 已登记', miss: '未注册' })[v] || v || '—'; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  }
  function getActivityMs(row) {
    return row.lastOpenedAt || (row.memory && row.memory.lastModifiedISO ? new Date(row.memory.lastModifiedISO).getTime() : 0);
  }
  function fileHref(p) {
    if (!p) return '#';
    const normalized = String(p).replace(/\\\\/g, '/');
    return 'file:///' + normalized.split('/').map((part, idx) => {
      if (idx === 0 && /^[A-Za-z]:$/.test(part)) return part;
      return encodeURIComponent(part);
    }).join('/');
  }
  function link(label, href, className, title) {
    return '<a class="link ' + (className || '') + '" href="' + escHtml(href) + '" title="' + escHtml(title || label) + '">' + escHtml(label) + '</a>';
  }
  function actionButton(label, path, action, secondary) {
    return '<button type="button" class="action-btn ' + (secondary ? 'secondary' : '') + '" data-action="' + escHtml(action) + '" data-path="' + escHtml(path || '') + '">' + escHtml(label) + '</button>';
  }
  function artifactCell(row) {
    const a = row.artifact || { type: 'directory', label: '工作目录', path: row.path };
    const target = a.path || row.path;
    if (SHARE_MODE) {
      return '<div class="artifact"><div class="muted">' + escHtml(a.label || '工作目录') + '</div><div class="path">' + escHtml(target) + '</div></div>';
    }
    const buttons = [];
    if (a.type === 'html') {
      buttons.push(link('打开网页', fileHref(target), '', a.label || '打开 HTML 产物'));
      buttons.push(actionButton('定位文件', target, 'open', true));
    } else if (a.type === 'file') {
      buttons.push(actionButton('定位文件', target, 'open', false));
    } else {
      buttons.push(actionButton('打开目录', target, 'open', false));
    }
    buttons.push(actionButton('复制路径', target, 'copy', true));
    return '<div class="artifact"><div class="muted">' + escHtml(a.label || '工作目录') + '</div><div class="actions">' + buttons.join('') + '</div></div>';
  }
  function cell(row, key) {
    const m = row.memory || {};
    if (key === 'category') return '<span class="badge badge-' + escHtml(row.category) + '">' + escHtml(categoryLabel(row.category)) + '</span>';
    if (key === 'name') return '<span class="name">' + escHtml(row.name) + '</span>';
    if (key === 'description') return '<div class="desc">' + escHtml(row.description || '待补充工作内容描述') + '</div>';
    if (key === 'artifact') return artifactCell(row);
    if (key === 'progress') return '<div class="progress">' + escHtml(row.progress || '暂无进展记录') + '</div>';
    if (key === 'path') {
      if (SHARE_MODE) return '<div class="path">' + escHtml(row.path) + '</div>';
      return '<div class="path"><div>' + escHtml(row.path) + '</div><div class="actions">' + actionButton('Explorer 打开', row.path, 'open', false) + actionButton('复制路径', row.path, 'copy', true) + '</div></div>';
    }
    if (key === 'drive') return escHtml(row.drive || '—');
    if (key === 'lastOpened') return escHtml(fmtDate(row.lastOpenedISO));
    if (key === 'memoryTime') return escHtml(fmtDate(m.lastModifiedISO));
    if (key === 'latestDaily') return escHtml(m.latestDailyDate || '—');
    if (key === 'dailyCount') return String(m.dailyCount || 0);
    if (key === 'registry') return '<span class="badge badge-' + escHtml(row.registry) + '">' + escHtml(registryLabel(row.registry)) + '</span>';
    if (key === 'aggregate') return row.inAggregate ? '<span class="muted">聚合目录</span><br><code>' + escHtml(row.aggregateRoot) + '</code>' : '<span class="muted">散户路径</span>';
    return '';
  }
  function plainValue(row, key) {
    const m = row.memory || {};
    if (key === 'lastOpened') return row.lastOpenedAt || 0;
    if (key === 'memoryTime') return m.lastModifiedISO ? new Date(m.lastModifiedISO).getTime() : 0;
    if (key === 'dailyCount') return m.dailyCount || 0;
    if (key === 'latestDaily') return m.latestDailyDate || '';
    if (key === 'artifact') return String((row.artifact && row.artifact.label) || '').toLowerCase();
    return String(row[key] || '').toLowerCase();
  }
  function populateDriveFilter() {
    const drives = Array.from(new Set(spaces.map(s => s.drive).filter(Boolean))).sort();
    for (const d of drives) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d + ' 盘';
      els.drive.appendChild(opt);
    }
  }
  function renderColumnControls() {
    els.columnControls.innerHTML = '';
    for (const col of columns) {
      const label = document.createElement('label');
      label.className = 'check-pill';
      label.innerHTML = '<input type="checkbox" data-col="' + col.key + '" ' + (state.visible[col.key] ? 'checked' : '') + '> ' + escHtml(col.label);
      els.columnControls.appendChild(label);
    }
  }
  function renderHead() {
    els.head.innerHTML = '';
    for (const col of columns) {
      if (!state.visible[col.key]) continue;
      const th = document.createElement('th');
      th.textContent = col.label;
      th.title = '点击按此列排序';
      th.addEventListener('click', () => {
        if (col.key === 'name') els.sort.value = 'nameAsc';
        else if (col.key === 'category') els.sort.value = 'categoryAsc';
        else if (col.key === 'drive') els.sort.value = 'driveAsc';
        else if (col.key === 'dailyCount') els.sort.value = 'dailyDesc';
        else if (col.key === 'lastOpened') els.sort.value = els.sort.value === 'lastOpenedDesc' ? 'lastOpenedAsc' : 'lastOpenedDesc';
        render();
      });
      els.head.appendChild(th);
    }
  }
  function filteredRows() {
    const kw = els.keyword.value.trim().toLowerCase();
    let rows = spaces.filter(row => {
      const m = row.memory || {};
      if (kw) {
        const hay = [row.name, row.path, row.description, row.progress, row.artifact && row.artifact.label, row.category, row.registry].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      if (els.category.value !== 'all' && row.category !== els.category.value) return false;
      if (els.drive.value !== 'all' && row.drive !== els.drive.value) return false;
      if (els.registry.value !== 'all' && row.registry !== els.registry.value) return false;
      if (els.memory.value === 'has' && !m.exists) return false;
      if (els.memory.value === 'none' && m.exists) return false;
      return true;
    });
    const rule = els.sort.value;
    const categoryRank = { inUse: 0, historical: 1, raw: 2 };
    rows.sort((a, b) => {
      if (rule === 'lastOpenedDesc') return getActivityMs(b) - getActivityMs(a);
      if (rule === 'lastOpenedAsc') return getActivityMs(a) - getActivityMs(b);
      if (rule === 'nameAsc') return a.name.localeCompare(b.name);
      if (rule === 'categoryAsc') return (categoryRank[a.category] - categoryRank[b.category]) || getActivityMs(b) - getActivityMs(a);
      if (rule === 'dailyDesc') return plainValue(b, 'dailyCount') - plainValue(a, 'dailyCount');
      if (rule === 'driveAsc') return String(a.drive).localeCompare(String(b.drive)) || a.name.localeCompare(b.name);
      return 0;
    });
    return rows;
  }
  function renderBody(rows) {
    els.body.innerHTML = '';
    const visibleCols = columns.filter(c => state.visible[c.key]);
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="empty" colspan="' + Math.max(1, visibleCols.length) + '">没有符合条件的工作空间</td>';
      els.body.appendChild(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = visibleCols.map(col => '<td>' + cell(row, col.key) + '</td>').join('');
      els.body.appendChild(tr);
    }
  }
  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      return true;
    } catch (e) {
      window.prompt('复制失败，请手动复制路径：', path);
      return false;
    }
  }
  function setHelperStatus(text) {
    if (els.helperStatus) els.helperStatus.textContent = text;
    console.log('[workspace-scanner]', text);
  }
  function helperUrl(path) {
    return 'http://127.0.0.1:17365/open?path=' + encodeURIComponent(path);
  }
  function openWithExplorer(path) {
    const url = helperUrl(path);
    setHelperStatus('发送打开请求：' + path);
    const frame = document.getElementById('openHelperFrame');
    if (frame) {
      frame.onload = () => setHelperStatus('helper iframe 已加载；请检查 Explorer 是否打开，并查看 /logs');
      frame.onerror = () => setHelperStatus('helper iframe 加载失败；请确认服务运行');
      frame.src = url;
    } else {
      window.open(url, 'open_helper_frame');
    }
  }
  async function testHelper() {
    try {
      setHelperStatus('正在测试 /health ...');
      const res = await fetch('/health', { cache: 'no-store' });
      const body = await res.json();
      setHelperStatus('helper 正常：roots=' + body.roots + '，日志=' + (body.logFile || '')); 
    } catch (e) {
      setHelperStatus('helper 测试失败：' + e.message);
    }
  }
  function render() {
    const rows = filteredRows();
    renderHead();
    renderBody(rows);
    els.summary.textContent = '显示 ' + rows.length + ' / ' + spaces.length + ' 个工作空间';
  }
  function bind() {
    for (const el of [els.keyword, els.category, els.drive, els.registry, els.memory, els.sort]) {
      el.addEventListener('input', render);
      el.addEventListener('change', render);
    }
    els.columnControls.addEventListener('change', e => {
      const key = e.target && e.target.dataset ? e.target.dataset.col : null;
      if (!key) return;
      state.visible[key] = e.target.checked;
      render();
    });
    if (!SHARE_MODE && els.testHelper) els.testHelper.addEventListener('click', testHelper);
    const frame = document.getElementById('openHelperFrame');
    if (!SHARE_MODE && frame) frame.addEventListener('load', () => console.log('[workspace-scanner] iframe load:', frame.src));
    if (!SHARE_MODE) {
      els.body.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const p = btn.dataset.path || '';
        if (!p) return;
        if (btn.dataset.action === 'copy') copyPath(p);
        else if (btn.dataset.action === 'open') openWithExplorer(p);
      });
    }
    els.reset.addEventListener('click', () => {
      els.keyword.value = '';
      els.category.value = 'all';
      els.drive.value = 'all';
      els.registry.value = 'all';
      els.memory.value = 'all';
      els.sort.value = 'lastOpenedDesc';
      for (const col of columns) state.visible[col.key] = col.visible;
      renderColumnControls();
      render();
    });
  }
  populateDriveFilter();
  renderColumnControls();
  bind();
  render();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const { inFile, outFile, shareMode } = readArgs();
  const data = await readInput(inFile);
  const html = buildHtml(data, { shareMode });
  if (outFile) {
    fs.writeFileSync(outFile, html, 'utf-8');
    process.stderr.write(`written: ${outFile}\n`);
  } else {
    process.stdout.write(html);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
