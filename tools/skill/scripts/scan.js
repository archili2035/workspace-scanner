#!/usr/bin/env node
/**
 * workspace-scanner: 一次性扫描脚本（v3 / sqlite-first）
 *
 * 数据源优先级（高到低）：
 *   1. workbuddy.db `workspaces` 表 —— 新版客户端唯一权威源（含 last_opened_at 毫秒时间戳）
 *   2. storage.json profileAssociations.workspaces —— 旧版兼容；新客户端不再写
 *   3. 聚合目录扫描 —— 兜底发现没在注册表里的"散户"目录
 *
 * 判定层级：
 *   inUse       — last_opened_at 在 30 天内（优先）；或 .workbuddy/memory/ 30 天内有更新
 *   historical  — 注册过但 30 天内没打开；或有 memory 但 30 天没动
 *   raw         — 既无注册记录也无 .workbuddy/memory/
 *
 * 注册状态标签：
 *   dbHit       — workbuddy.db 里有
 *   storageHit  — 旧 storage.json 里有
 *   miss        — 两边都没有（纯文件系统发现）
 *
 * 用法：
 *   node scan.js [--aggregate-dir "E:\\WorkBuddyRepo"] ...
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = 'C:/Users/archili/.workbuddy/workbuddy.db';
const STORAGE_PATH = 'C:/Users/archili/AppData/Roaming/WorkBuddy/User/globalStorage/storage.json';
const WORKSPACES_MD = 'C:/Users/archili/.workbuddy/memory/WORKSPACES.md';
const FRESH_DAYS = 30;
const ARTIFACT_OVERRIDES = new Map([
  ['e:\\workbuddyrepo\\health', { type: 'html', label: '网页：health_dashboard.html', path: 'E:/WorkBuddyRepo/Health/outputs/health_dashboard.html' }],
  ['d:\\stock', { type: 'html', label: '网页：index_rebuild.html', path: 'D:/stock/index_rebuild.html' }],
]);

// ---------- helpers ----------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function decodeStorageKey(key) {
  const m = key.match(/^file:\/\/\/([a-zA-Z])%3A\/(.*)$/);
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const rest = decodeURIComponent(m[2]).replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function probeMemory(spaceDir) {
  const memDir = path.join(spaceDir, '.workbuddy', 'memory');
  const st = safeStat(memDir);
  if (!st || !st.isDirectory()) {
    return { exists: false, hasMemoryMd: false, latestDailyDate: null, lastModifiedISO: null, dailyCount: 0 };
  }
  let files = [];
  try { files = fs.readdirSync(memDir); } catch { files = []; }
  const dailies = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const hasMemoryMd = files.includes('MEMORY.md');
  let latestMtime = 0;
  for (const f of files) {
    const fst = safeStat(path.join(memDir, f));
    if (fst && fst.mtimeMs > latestMtime) latestMtime = fst.mtimeMs;
  }
  return {
    exists: true,
    hasMemoryMd,
    latestDailyDate: dailies.length ? dailies[dailies.length - 1].replace('.md', '') : null,
    lastModifiedISO: latestMtime ? new Date(latestMtime).toISOString() : null,
    dailyCount: dailies.length,
  };
}

function readSqliteWorkspaces() {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare('SELECT path, last_opened_at FROM workspaces').all();
    db.close();
    return rows.map(r => ({
      path: r.path,
      lastOpenedAt: r.last_opened_at != null ? Number(r.last_opened_at) : null,
    }));
  } catch (e) {
    process.stderr.write(`[scan.js] sqlite read failed: ${e.message}\n`);
    return [];
  }
}

function readStorageJson() {
  if (!fs.existsSync(STORAGE_PATH)) return { entries: [], storageMtime: null };
  try {
    const d = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf-8'));
    const ws = (d.profileAssociations && d.profileAssociations.workspaces) || {};
    const entries = Object.keys(ws).map(decodeStorageKey).filter(Boolean);
    const st = safeStat(STORAGE_PATH);
    return { entries, storageMtime: st ? new Date(st.mtimeMs).toISOString() : null };
  } catch {
    return { entries: [], storageMtime: null };
  }
}

function listSubdirs(parent) {
  if (!fs.existsSync(parent)) return [];
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => path.join(parent, e.name));
  } catch { return []; }
}

function cleanMdCell(s) {
  return String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

function readDescriptionMap() {
  const out = new Map();
  if (!fs.existsSync(WORKSPACES_MD)) return out;
  let text = '';
  try { text = fs.readFileSync(WORKSPACES_MD, 'utf-8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    if (/\|\s*-+\s*\|/.test(line)) continue;
    if (line.includes('| 路径 |') || line.includes('| 名称 |')) continue;
    const pathMatch = line.match(/`([^`]+)`/);
    if (!pathMatch) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const desc = cleanMdCell(cells[cells.length - 1]);
    if (!desc || desc === '备注' || desc === '用途') continue;
    out.set(pathMatch[1].toLowerCase(), desc);
  }
  return out;
}

function fallbackDescription(spaceDir, memory) {
  if (memory && memory.exists) return '已有工作记忆，待补充简短描述';
  return '待补充工作内容描述';
}

function isNonEmptyDir(dir) {
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) return false;
  try { return fs.readdirSync(dir).some(name => !name.startsWith('.')); } catch { return false; }
}

function probeArtifact(spaceDir) {
  const override = ARTIFACT_OVERRIDES.get(spaceDir.toLowerCase());
  if (override) return override;
  const st = safeStat(spaceDir);
  if (!st || !st.isDirectory()) return { type: 'missing', label: '路径不可访问', path: spaceDir };
  let entries = [];
  try { entries = fs.readdirSync(spaceDir, { withFileTypes: true }); } catch { entries = []; }
  const htmlFiles = entries
    .filter(e => e.isFile() && /\.html?$/i.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      if (a.toLowerCase() === 'index.html') return -1;
      if (b.toLowerCase() === 'index.html') return 1;
      return a.localeCompare(b);
    });
  if (htmlFiles.length === 1 || htmlFiles.some(f => f.toLowerCase() === 'index.html')) {
    const file = htmlFiles.find(f => f.toLowerCase() === 'index.html') || htmlFiles[0];
    return { type: 'html', label: `网页：${file}`, path: path.join(spaceDir, file) };
  }
  if (htmlFiles.length > 1) {
    return { type: 'directory', label: `HTML 产物目录（${htmlFiles.length} 个）`, path: spaceDir };
  }
  const productDirs = ['dist', 'build', 'out', 'site', 'docs', 'public', 'output', 'outputs', 'artifacts', 'reports', 'assets'];
  for (const name of productDirs) {
    const dir = path.join(spaceDir, name);
    if (isNonEmptyDir(dir)) return { type: 'directory', label: `产物目录：${name}`, path: dir };
  }
  const docFiles = entries
    .filter(e => e.isFile() && /\.(xlsx|docx|pptx|pdf|md)$/i.test(e.name) && !/^README\.md$/i.test(e.name))
    .map(e => e.name)
    .sort();
  if (docFiles.length === 1) return { type: 'file', label: `文件：${docFiles[0]}`, path: path.join(spaceDir, docFiles[0]) };
  if (docFiles.length > 1) return { type: 'directory', label: `文件目录（${docFiles.length} 个）`, path: spaceDir };
  return { type: 'directory', label: '工作目录', path: spaceDir };
}

function compactText(s, max = 42) {
  const t = String(s || '').replace(/^[#\-\*\s]+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function readLatestDailySignal(spaceDir, memory) {
  if (!memory || !memory.latestDailyDate) return '';
  const file = path.join(spaceDir, '.workbuddy', 'memory', `${memory.latestDailyDate}.md`);
  if (!fs.existsSync(file)) return '';
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return ''; }
  const lines = text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('```') && !/^#\s*\d{4}-\d{2}-\d{2}/.test(l));
  const useful = lines.find(l => /^[-*]\s+/.test(l) || /^##\s+/.test(l)) || lines[0] || '';
  return compactText(useful, 36);
}

function inferProgress(spaceDir, description, memory, category) {
  const signal = readLatestDailySignal(spaceDir, memory);
  const current = memory && memory.latestDailyDate
    ? `最近记录 ${memory.latestDailyDate}${signal ? `：${signal}` : ''}`
    : (category === 'inUse' ? '近期打开过，暂无 daily 记录' : '暂无近期工作记录');
  const topic = compactText(description && !description.includes('待补充') ? description : path.basename(spaceDir), 18);
  const next = description && description.includes('待补充')
    ? '补齐用途、产物和计划'
    : (category === 'historical' ? '按需恢复或归档' : `继续推进${topic}`);
  return `${current}；下一步：${next}`;
}

function classify(memory, lastOpenedAt) {
  // 优先用 sqlite 的 last_opened_at；否则用 memory mtime
  const refMs = lastOpenedAt || (memory.lastModifiedISO ? new Date(memory.lastModifiedISO).getTime() : 0);
  if (!refMs) {
    return memory.exists ? 'historical' : 'raw';
  }
  const ageDays = (Date.now() - refMs) / 86400000;
  if (ageDays <= FRESH_DAYS) return 'inUse';
  return memory.exists || lastOpenedAt ? 'historical' : 'raw';
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  const aggregateDirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--aggregate-dir' && args[i + 1]) {
      aggregateDirs.push(args[i + 1]);
      i++;
    }
  }
  if (aggregateDirs.length === 0) aggregateDirs.push('E:\\WorkBuddyRepo');

  const dbRows = readSqliteWorkspaces();
  const dbMap = new Map(); // pathLower -> { path, lastOpenedAt }
  for (const r of dbRows) {
    const key = r.path.toLowerCase();
    // 同一路径可能因大小写录入两条，保留最新 last_opened_at
    const cur = dbMap.get(key);
    if (!cur || (r.lastOpenedAt || 0) > (cur.lastOpenedAt || 0)) {
      dbMap.set(key, { path: r.path, lastOpenedAt: r.lastOpenedAt });
    }
  }

  const { entries: storageEntries, storageMtime } = readStorageJson();
  const storageSet = new Set(storageEntries.map(p => p.toLowerCase()));
  const descriptionMap = readDescriptionMap();

  // 候选 space 集合：sqlite + storage + 聚合目录扫描
  const candidateSet = new Map(); // pathLower -> { path, aggregateRoot }
  for (const ag of aggregateDirs) {
    for (const sub of listSubdirs(ag)) {
      candidateSet.set(sub.toLowerCase(), { path: sub, aggregateRoot: ag });
    }
  }
  for (const [k, v] of dbMap) {
    if (!candidateSet.has(k)) candidateSet.set(k, { path: v.path, aggregateRoot: null });
  }
  for (const p of storageEntries) {
    const k = p.toLowerCase();
    if (!candidateSet.has(k)) candidateSet.set(k, { path: p, aggregateRoot: null });
  }

  const spaces = [];
  for (const { path: p, aggregateRoot } of candidateSet.values()) {
    const key = p.toLowerCase();
    const dbHit = dbMap.get(key);
    const inStorage = storageSet.has(key);
    const lastOpenedAt = dbHit ? dbHit.lastOpenedAt : null;
    const memory = probeMemory(p);
    const category = classify(memory, lastOpenedAt);
    const registry = dbHit ? 'dbHit' : (inStorage ? 'storageHit' : 'miss');
    const description = descriptionMap.get(key) || fallbackDescription(p, memory);
    const artifact = probeArtifact(p);
    const progress = inferProgress(p, description, memory, category);
    spaces.push({
      name: path.basename(p),
      path: p,
      drive: p[0].toUpperCase(),
      category,
      description,
      artifact,
      progress,
      registry,
      inDb: !!dbHit,
      inStorage,
      lastOpenedAt,
      lastOpenedISO: lastOpenedAt ? new Date(lastOpenedAt).toISOString() : null,
      memory,
      inAggregate: !!aggregateRoot,
      aggregateRoot,
    });
  }

  // 排序：inUse 在前，按 lastOpenedAt 倒序，再按 memory mtime；historical 次之；raw 最后
  const order = { inUse: 0, historical: 1, raw: 2 };
  spaces.sort((a, b) => {
    if (order[a.category] !== order[b.category]) return order[a.category] - order[b.category];
    const al = a.lastOpenedAt || 0;
    const bl = b.lastOpenedAt || 0;
    if (al !== bl) return bl - al;
    const am = a.memory.lastModifiedISO || '';
    const bm = b.memory.lastModifiedISO || '';
    if (am !== bm) return bm.localeCompare(am);
    return a.path.localeCompare(b.path);
  });

  const orphans = spaces.filter(s => s.registry === 'miss'); // 文件系统里有，但两个注册表都没记
  const dbOnly = spaces.filter(s => s.inDb && !s.inStorage);
  const storageOnly = spaces.filter(s => !s.inDb && s.inStorage);

  const byCategory = { inUse: 0, historical: 0, raw: 0 };
  const byRegistry = { dbHit: 0, storageHit: 0, miss: 0 };
  const byDrive = {};
  for (const s of spaces) {
    byCategory[s.category]++;
    byRegistry[s.registry]++;
    byDrive[s.drive] = (byDrive[s.drive] || 0) + 1;
  }

  const result = {
    spaces,
    orphans,
    dbOnly,
    storageOnly,
    summary: {
      total: spaces.length,
      byCategory,
      byRegistry,
      byDrive,
      aggregateDirsScanned: aggregateDirs,
      scannedAt: new Date().toISOString(),
      dbRowCount: dbRows.length,
      storageRowCount: storageEntries.length,
      storageMtime,
      primarySource: dbRows.length > 0 ? 'sqlite' : (storageEntries.length > 0 ? 'storage.json' : 'filesystem-only'),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
