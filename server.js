import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { catalog, searchVideos, recommendedVideos, toPublic } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 20;

// Search and recommendations are served entirely from the local curated catalog
// (data/czech_channels.yaml) — the YouTube API is no longer queried. Videos are
// still played via the YouTube embed player and use YouTube thumbnail URLs.
const LANGUAGE_NAMES = { cs: 'Česky', en: 'English', sk: 'Slovensky', de: 'Deutsch' };
const LANGUAGES = [{ code: catalog.language, name: LANGUAGE_NAMES[catalog.language] || catalog.language }];
const SUPPORTED_LANGS = new Set(LANGUAGES.map((l) => l.code));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/languages', (req, res) => {
  res.json(LANGUAGES);
});

function parseLang(req) {
  // lang is optional; default to the catalog's language.
  const lang = (req.query.lang || catalog.language).toString().trim();
  return SUPPORTED_LANGS.has(lang) ? lang : null;
}

function paginate(list, offset) {
  const page = list.slice(offset, offset + PAGE_SIZE).map(toPublic);
  const nextOffset = offset + page.length;
  return { page, nextOffset, hasMore: nextOffset < list.length };
}

app.get('/api/recommended', (req, res) => {
  const lang = parseLang(req);
  if (!lang) return res.status(400).json({ error: 'Unsupported "lang". See /api/languages.' });

  // pageToken = "<seed>.<offset>" — the seed keeps the shuffled order stable across pages.
  const [seedStr, offsetStr] = (req.query.pageToken || '').toString().split('.');
  const seed = Number.parseInt(seedStr, 10) || Math.floor(Math.random() * 2 ** 31);
  const offset = Math.max(0, Number.parseInt(offsetStr, 10) || 0);

  const feed = recommendedVideos(seed);
  const { page, nextOffset, hasMore } = paginate(feed, offset);

  res.json({
    lang,
    results: page,
    total: feed.length,
    nextPageToken: hasMore ? `${seed}.${nextOffset}` : null,
    hasMore,
  });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const lang = parseLang(req);
  if (!q) return res.status(400).json({ error: 'Missing query parameter "q".' });
  if (!lang) return res.status(400).json({ error: 'Unsupported "lang". See /api/languages.' });

  const offset = Math.max(0, Number.parseInt(req.query.pageToken, 10) || 0);
  const matches = searchVideos(q);
  const { page, nextOffset, hasMore } = paginate(matches, offset);

  console.log(`[search] q="${q}" matches=${matches.length} offset=${offset}`);

  res.json({
    query: q,
    lang,
    results: page,
    total: matches.length,
    nextPageToken: hasMore ? String(nextOffset) : null,
    hasMore,
  });
});

app.listen(PORT, () => {
  console.log(`CzechKidTube running at http://localhost:${PORT}`);
});
