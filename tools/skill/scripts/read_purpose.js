#!/usr/bin/env node
/**
 * 读取一个工作空间的"真实用途"。
 *
 * 优先级：
 *   1. <space>/.workbuddy/memory/MEMORY.md
 *   2. 最新一份 <space>/.workbuddy/memory/YYYY-MM-DD.md
 *   3. <space>/README.md
 *   4. 都没有 → 返回 null
 *
 * 用法：
 *   node read_purpose.js "E:\\WorkBuddyRepo\\HongkongGTA"
 *
 * 输出：
 *   { source: 'memory|daily|readme|none', filePath, excerpt }
 */

const fs = require('fs');
const path = require('path');

function readFirstLines(file, max = 60) {
  try {
    const txt = fs.readFileSync(file, 'utf-8');
    return txt.split(/\r?\n/).slice(0, max).join('\n').trim();
  } catch {
    return '';
  }
}

function findLatestDaily(memDir) {
  if (!fs.existsSync(memDir)) return null;
  const files = fs.readdirSync(memDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  return files.length ? path.join(memDir, files[0]) : null;
}

function readPurpose(spaceDir) {
  // 路径防呆：把 / 和 \ 都规范成系统分隔符，避免 bash 调用时反斜杠被转义吞掉
  const normalized = path.normalize(spaceDir.replace(/[\\/]+/g, path.sep));
  const memDir = path.join(normalized, '.workbuddy', 'memory');

  const memoryMd = path.join(memDir, 'MEMORY.md');
  if (fs.existsSync(memoryMd)) {
    return { source: 'memory', filePath: memoryMd, excerpt: readFirstLines(memoryMd, 80) };
  }

  const daily = findLatestDaily(memDir);
  if (daily) {
    return { source: 'daily', filePath: daily, excerpt: readFirstLines(daily, 80) };
  }

  const readme = path.join(spaceDir, 'README.md');
  if (fs.existsSync(readme)) {
    return { source: 'readme', filePath: readme, excerpt: readFirstLines(readme, 30) };
  }

  return { source: 'none', filePath: null, excerpt: '' };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node read_purpose.js <space-dir>');
    process.exit(1);
  }
  console.log(JSON.stringify(readPurpose(dir), null, 2));
}

main();
