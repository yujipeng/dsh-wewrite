#!/usr/bin/env node
/**
 * seed-style —— 把 docs/style/ 的风格指南与范文播种到 dsh_wewrite storage 的 writingProfile。
 *
 * 用法：
 *   node scripts/seed-style.mjs --dry-run     # 只解析并打印，不写文件
 *   node scripts/seed-style.mjs               # 写入 storage（要求宿主已停止）
 *
 * 前置：
 *   - 已安装包含 styleGuide / styleExemplars 字段的插件版本（否则旧 schema 无法解析新字段）；
 *   - 宿主已停止（脚本检测 127.0.0.1:3080，可达则拒绝写入，避免运行中内存状态覆盖）。
 *   - 写入前自动备份 storage 为 <storage>.bak-<timestamp>。
 */
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE_PATH = join(ROOT, 'docs/style/social-psychology-style.md');
const EXEMPLAR_DIR = join(ROOT, 'docs/style/exemplars');
const DEFAULT_STORAGE = join(homedir(), '.dsh/storages/dsh_wewrite.json');

const GUIDE_MAX = 4000;
const EXCERPT_MAX = 2000;
const TITLE_MAX = 120;
const LEARN_MAX = 200;
const MAX_EXEMPLARS = 3;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseExemplar(file) {
  const text = readFileSync(file, 'utf8');
  const rawTitle = (text.match(/^#\s+(.+)$/m)?.[1] ?? '').trim();
  const title = (rawTitle.replace(/^范文\s*\d+[：:]\s*/, '') || rawTitle).slice(0, TITLE_MAX);
  const learn = (text.match(/^-\s*\*\*学习点\*\*[：:]\s*(.+)$/m)?.[1] ?? '').trim().slice(0, LEARN_MAX);
  const section = text.split(/^##\s+节选\s*$/m)[1] ?? '';
  const excerpt = section
    .split(/^##\s+/m)[0]
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, EXCERPT_MAX);
  return { title, excerpt, learn };
}

function loadExemplars() {
  return readdirSync(EXEMPLAR_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => parseExemplar(join(EXEMPLAR_DIR, name)))
    .filter((item) => item.excerpt)
    .slice(0, MAX_EXEMPLARS);
}

async function hostRunning() {
  try {
    await fetch('http://127.0.0.1:3080', { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const storage = argValue('--storage') ?? DEFAULT_STORAGE;
  const styleGuide = readFileSync(GUIDE_PATH, 'utf8').trim().slice(0, GUIDE_MAX);
  const styleExemplars = loadExemplars();

  console.log(`风格指南：${styleGuide.length} 字（上限 ${GUIDE_MAX}）`);
  console.log(`范文：${styleExemplars.length} 条`);
  for (const [index, item] of styleExemplars.entries()) {
    console.log(`  ${index + 1}. ${item.title}（${item.excerpt.length} 字）学习点：${item.learn || '（空）'}`);
  }
  console.log(`storage：${storage}`);

  if (dryRun) {
    console.log('dry-run：未写入任何文件。');
    return;
  }
  if (await hostRunning()) {
    console.error('宿主仍在运行（127.0.0.1:3080 可达）。先执行 npm run host:stop，再重跑本脚本。');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(storage, 'utf8'));
  const profile = data?.global?.settings?.writingProfile;
  if (!profile) {
    console.error('storage 中找不到 global.settings.writingProfile，未写入。');
    process.exit(1);
  }
  const backup = `${storage}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(storage, backup);
  profile.styleGuide = styleGuide;
  profile.styleExemplars = styleExemplars;
  writeFileSync(storage, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`已写入 writingProfile（备份：${backup}）。`);
  console.log('下一步：npm run host:start，然后在设置页确认「风格基准」已填充。');
}

await main();
