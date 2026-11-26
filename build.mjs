// Builds the bookmarklet from the userscript, so there is one source of truth.
// Usage: npm install terser && node build.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { minify } from 'terser';

const SOURCE = 'youtube-playlists-export.user.js';
const TARGET = 'youtube-playlists-export.bookmarklet.txt';

const source = await readFile(new URL(SOURCE, import.meta.url), 'utf8');
const { code } = await minify(source, {
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
});

// "void" keeps the browser from replacing the page with the script's result;
// encoding keeps "%", "#" and quotes intact when the text is stored as a bookmark URL.
const bookmarklet = `javascript:${encodeURIComponent(`void ${code}`)}`;
await writeFile(new URL(TARGET, import.meta.url), `${bookmarklet}\n`);
console.log(`${TARGET}: ${bookmarklet.length.toLocaleString()} characters`);
