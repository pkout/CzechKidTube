// Checks every catalog video against YouTube's oEmbed endpoint (401 = owner disabled embedding,
// 404 = removed/private) and deletes those episodes from the catalog YAML in place, since they
// could only ever fail in the embedded player.
//
// Usage: node scripts/check-embeddable.js [--dry-run]   (re-run after adding videos to the catalog)
//
// Episodes are removed textually (not by re-serializing the YAML) so the rest of the file —
// quoting, comments, ordering — stays exactly as it was.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = process.env.CATALOG_PATH || path.join(__dirname, '..', 'data', 'czech_channels.yaml');
const CONCURRENCY = 16;
const DRY_RUN = process.argv.includes('--dry-run');

const text = fs.readFileSync(CATALOG_PATH, 'utf8');
const raw = YAML.parse(text);
const ids = [...new Set((raw?.channels || []).flatMap((c) => (c.episodes || []).map((e) => e?.id).filter(Boolean)))];

async function check(id) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  const res = await fetch(url);
  if (res.status === 401 || res.status === 404) return 'blocked';
  if (res.ok) return 'ok';
  return 'unknown'; // e.g. 429/5xx: inconclusive, keep the video
}

const blocked = new Set();
let unknown = 0;
let index = 0;
async function worker() {
  while (index < ids.length) {
    const id = ids[index++];
    try {
      const result = await check(id);
      if (result === 'blocked') blocked.add(id);
      else if (result === 'unknown') unknown += 1;
    } catch {
      unknown += 1;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`Checked ${ids.length} videos: ${blocked.size} not embeddable, ${unknown} inconclusive (kept).`);
if (!blocked.size || DRY_RUN) process.exit(0);

// An episode is a "- id: X" list item plus every following line indented deeper than its dash.
const lines = text.split('\n');
const out = [];
let skipIndent = -1; // >= 0 while dropping the continuation lines of a removed episode
for (const line of lines) {
  const indent = line.length - line.trimStart().length;
  if (skipIndent >= 0) {
    if (line.trim() === '' || indent > skipIndent) continue;
    skipIndent = -1;
  }
  const m = line.match(/^(\s*)- id:\s*['"]?([\w-]+)['"]?\s*$/);
  if (m && blocked.has(m[2]) && /^\s*episodes:\s*$/.test(findListParent(out, m[1].length))) {
    skipIndent = m[1].length;
    continue;
  }
  out.push(line);
}

// "episodes:" left with no items would parse as null; make it an explicit empty list.
for (let i = 0; i < out.length; i++) {
  const m = out[i].match(/^(\s*)episodes:\s*$/);
  if (!m) continue;
  const next = out.slice(i + 1).find((l) => l.trim() !== '');
  const nextIndent = next === undefined ? -1 : next.length - next.trimStart().length;
  if (!(next?.trimStart().startsWith('- ') && nextIndent >= m[1].length)) out[i] = `${m[1]}episodes: []`;
}

const result = out.join('\n');
const remaining = (YAML.parse(result)?.channels || []).flatMap((c) => c.episodes || []);
const leftover = remaining.filter((e) => blocked.has(e?.id));
if (leftover.length || remaining.length !== ids.length - blocked.size) {
  console.error('Sanity check failed: pruned YAML does not match the expected episode set. File left unchanged.');
  process.exit(1);
}
fs.writeFileSync(CATALOG_PATH, result);
console.log(`Removed ${blocked.size} episodes from ${CATALOG_PATH}; ${remaining.length} remain.`);

// Nearest preceding non-blank line with smaller indentation: the key owning this list item.
function findListParent(prevLines, itemIndent) {
  for (let i = prevLines.length - 1; i >= 0; i--) {
    const l = prevLines[i];
    if (l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind < itemIndent) return l;
  }
  return '';
}
