import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = process.env.CATALOG_PATH || path.join(__dirname, 'data', 'czech_channels.yaml');

// Lowercase + strip diacritics so "kocka" matches "Kočka" and "pohadky" matches "pohádky".
export function normalize(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function tokenize(str) {
  return normalize(str)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Field weights for search scoring: a hit in the title matters far more than one in the description.
const FIELD_WEIGHTS = { title: 10, channel: 6, highlights: 4, category: 3, description: 1 };

function loadCatalog() {
  const raw = YAML.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const language = raw?.metadata?.language || 'cs';
  const channels = raw?.channels || [];

  const videos = [];
  for (const channel of channels) {
    for (const ep of channel.episodes || []) {
      if (!ep?.id) continue;
      videos.push({
        videoId: ep.id,
        title: ep.title || '',
        channelTitle: channel.name,
        channelId: channel.id,
        description: ep.description || '',
        thumbnail: `https://i.ytimg.com/vi/${ep.id}/mqdefault.jpg`,
        url: ep.url,
        category: channel.category,
        ageRange: channel.age_range,
        // Pre-normalized fields used by search; stripped from API responses.
        _fields: {
          title: normalize(ep.title),
          channel: normalize(`${channel.name} ${channel.handle || ''}`),
          highlights: normalize((channel.highlights || []).join(' ')),
          category: normalize(`${channel.category || ''} ${channel.format || ''}`),
          description: normalize(ep.description),
        },
      });
    }
  }

  console.log(`[catalog] loaded ${videos.length} videos from ${channels.length} channels (${CATALOG_PATH})`);
  return { language, channels, videos };
}

export const catalog = loadCatalog();

export function toPublic(video) {
  const { _fields, ...rest } = video;
  return rest;
}

// Every query token must appear (as a substring, so prefixes work for Czech inflection)
// in at least one field. Score = sum of field weights for each token hit, with a bonus
// for tokens that start a word in the title and for the full phrase appearing in the title.
export function searchVideos(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const phrase = tokens.join(' ');

  const scored = [];
  for (const video of catalog.videos) {
    const f = video._fields;
    let score = 0;
    let allMatched = true;

    for (const token of tokens) {
      let tokenScore = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (f[field].includes(token)) tokenScore += weight;
      }
      if (!tokenScore) {
        allMatched = false;
        break;
      }
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}`, 'u').test(f.title)) tokenScore += 5;
      score += tokenScore;
    }

    if (!allMatched) continue;
    if (tokens.length > 1 && f.title.includes(phrase)) score += 15;
    scored.push({ video, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.video);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Small seeded PRNG (mulberry32) so a shuffled feed stays stable across paginated requests.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Recommended feed: shuffle each channel's episodes and the channel order, then interleave
// round-robin so the feed mixes channels instead of showing 100 episodes of one show in a row.
const recommendedCache = new Map();
export function recommendedVideos(seed) {
  if (recommendedCache.has(seed)) return recommendedCache.get(seed);
  const rand = seededRandom(seed);

  const byChannel = new Map();
  for (const v of catalog.videos) {
    if (!byChannel.has(v.channelId)) byChannel.set(v.channelId, []);
    byChannel.get(v.channelId).push(v);
  }
  const queues = shuffle([...byChannel.values()], rand).map((eps) => shuffle(eps, rand));

  const feed = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) if (q.length) feed.push(q.shift());
  }

  if (recommendedCache.size > 50) recommendedCache.clear();
  recommendedCache.set(seed, feed);
  return feed;
}
