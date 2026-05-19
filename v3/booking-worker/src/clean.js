import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

async function removePath(target) {
  try {
    const before = await sizeOf(target);
    await fs.rm(target, { recursive: true, force: true });
    return before;
  } catch {
    return 0;
  }
}

async function sizeOf(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) {
    return stat.size;
  }

  const entries = await fs.readdir(target);
  const sizes = await Promise.all(entries.map((entry) => sizeOf(path.join(target, entry)).catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const artifactDir = path.resolve(config.artifactDir);
let freed = await removePath(artifactDir);

const tempDir = os.tmpdir();
const tempEntries = await fs.readdir(tempDir).catch(() => []);
for (const entry of tempEntries) {
  if (/^playwright/i.test(entry)) {
    freed += await removePath(path.join(tempDir, entry));
  }
}

await fs.mkdir(artifactDir, { recursive: true });

console.log(`Cleaned booking worker browser artifacts (${formatBytes(freed)} freed).`);
