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
const GOODREADS_RSS = `https://www.goodreads.com/review/list_rss/${GOODREADS_USER_ID}?key=${GOODREADS_KEY}&shelf=read&sort=date_read&order=d`;

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

    const rating = parseInt(ratingStr, 10);

    // Skip unrated (0) and entries without title
    if (!title || rating === 0) continue;

    books.push({
      title,
      author: author || "",
      rating,
      cover,
      url: link,
    });
  }

  // Take 5 most recent rated books
  const top5 = books.slice(0, 5);
  console.log(`  → ${top5.length} rated books (${books.length} total rated in feed)`);
  return top5;
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
