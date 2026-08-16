#!/usr/bin/env node

// fetch-feeds.mjs — pulls Letterboxd + Goodreads RSS, writes data/films.json + data/books.json
// Usage: node scripts/fetch-feeds.mjs
// CI: runs via GitHub Actions; npx fast-xml-parser used for XML parsing (no checked-in deps)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");

// ── Config ──────────────────────────────────────────────────────────
const LETTERBOXD_USER = "ak_13_";
const GOODREADS_USER_ID = "178710019-amit-konda";
const GOODREADS_KEY = "lgruY0muJs9TEYO4GoHnWLwUj1ekPPLi77a0IfITIdAkXm6r";

const LETTERBOXD_RSS = `https://letterboxd.com/${LETTERBOXD_USER}/rss/`;
// Note: sort=date_read is unreliable — user_read_at is only populated for reviews
// that have an explicit read date (here: 4 of 30), so undated books fall through
// in arbitrary order. sort=date_added covers every review (30/30) and comes back
// in monotonic descending review-ID order, i.e. truly newest-first.
const GOODREADS_RSS = `https://www.goodreads.com/review/list_rss/${GOODREADS_USER_ID}?key=${GOODREADS_KEY}&shelf=read&sort=date_added&order=d`;

// ── Helpers ─────────────────────────────────────────────────────────
function text(root, tag) {
  const m = root.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}

function attr(root, tag, attrName) {
  const m = root.match(
    new RegExp(`<${tag}[^>]*${attrName}\\s*=\\s*"([^"]*)"`, "i")
  );
  return m ? m[1] : "";
}

function isoNow() {
  return new Date().toISOString();
}

// ── Letterboxd ──────────────────────────────────────────────────────
async function fetchLetterboxd() {
  console.log("Fetching Letterboxd RSS…");
  const res = await fetch(LETTERBOXD_RSS);
  if (!res.ok) throw new Error(`Letterboxd HTTP ${res.status}`);
  const xml = await res.text();

  // Split into <item> blocks
  const items = xml.split(/<item>/).slice(1);
  const films = [];

  for (const item of items) {
    const endIdx = item.indexOf("</item>");
    if (endIdx === -1) continue;
    const block = item.slice(0, endIdx);

    const title = text(block, "letterboxd:filmTitle");
    const year = text(block, "letterboxd:filmYear");
    const rating = text(block, "letterboxd:memberRating");
    const link = text(block, "link");
    const desc = text(block, "description");

    // Skip list entries (no filmTitle) and unrated entries
    if (!title || !rating) continue;

    // Extract poster URL from <img> in description
    const imgMatch = desc.match(/<img[^>]*src="([^"]*)"/i);
    const poster = imgMatch ? imgMatch[1] : "";

    films.push({
      title,
      year: parseInt(year, 10) || null,
      rating: parseFloat(rating),
      poster,
      url: link,
    });
  }

  // Take 10 most recent rated films
  const top10 = films.slice(0, 10);
  console.log(`  → ${top10.length} rated films (${films.length} total rated in feed)`);
  return top10;
}

// ── Goodreads ───────────────────────────────────────────────────────
async function fetchGoodreads() {
  console.log("Fetching Goodreads RSS…");
  const res = await fetch(GOODREADS_RSS);
  if (!res.ok) throw new Error(`Goodreads HTTP ${res.status}`);
  const xml = await res.text();

  const items = xml.split(/<item>/).slice(1);
  const books = [];

  for (const item of items) {
    const endIdx = item.indexOf("</item>");
    if (endIdx === -1) continue;
    const block = item.slice(0, endIdx);

    const title = text(block, "title");
    const author = text(block, "author_name");
    const ratingStr = text(block, "user_rating");
    const cover = text(block, "book_large_image_url");
    const link = text(block, "link");

    // Goodreads review IDs are monotonically increasing with when the review was
    // added to the shelf, so they're a reliable recency key (read dates are
    // missing on most items and can't be trusted for ordering).
    const reviewIdMatch = link.match(/review\/show\/(\d+)/);
    const sortKey = reviewIdMatch ? parseInt(reviewIdMatch[1], 10) : 0;

    const rating = parseInt(ratingStr, 10);

    // Skip unrated (0) and entries without title
    if (!title || rating === 0) continue;

    books.push({
      title,
      author: author || "",
      rating,
      cover,
      url: link,
      sortKey,
    });
  }

  // Take 10 most recent rated books (newest review first)
  const top10 = books
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(({ sortKey, ...rest }) => rest)
    .slice(0, 10);
  console.log(`  → ${top10.length} rated books (${books.length} total rated in feed)`);
  return top10;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const [films, books] = await Promise.all([
    fetchLetterboxd(),
    fetchGoodreads(),
  ]);

  const filmsJson = { updated: isoNow(), items: films };
  const filmsPath = resolve(DATA_DIR, "films.json");
  writeFileSync(filmsPath, JSON.stringify(filmsJson, null, 2) + "\n");
  console.log(`Wrote ${filmsPath} (${films.length} items)`);

  const booksJson = { updated: isoNow(), items: books };
  const booksPath = resolve(DATA_DIR, "books.json");
  writeFileSync(booksPath, JSON.stringify(booksJson, null, 2) + "\n");
  console.log(`Wrote ${booksPath} (${books.length} items)`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
