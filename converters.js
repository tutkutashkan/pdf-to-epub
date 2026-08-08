import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

const EBOOK_CONVERT = process.env.EBOOK_CONVERT || "ebook-convert";
const PDFTOPPM = process.env.PDFTOPPM || "pdftoppm";
const PDFTOTEXT = process.env.PDFTOTEXT || "pdftotext";
const PDFINFO = process.env.PDFINFO || "pdfinfo";
const PDFIMAGES = process.env.PDFIMAGES || "pdfimages";
const OCRMYPDF = process.env.OCRMYPDF || "ocrmypdf";
// OCR is the one step that costs real CPU time, so it has an off switch. On by
// default; set OCR_ENABLED=false to withdraw it. The state is reported through
// /api/health, which the page already uses to hide the option, and the server
// refuses the work regardless, so a stale page cannot spend CPU time either.
const OCR_ENABLED = process.env.OCR_ENABLED !== "false";
const RASTER_DPI = Number(process.env.RASTER_DPI) || 150;
// A full-length book takes minutes, not seconds — a 300-page PDF alone runs for a
// while and real books are far more complex than that. Too tight a budget kills
// legitimate conversions, so this is deliberately generous.
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS) || 20 * 60 * 1000;
// OCR is far slower than the other steps, so it gets its own (longer) budget.
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 20 * 60 * 1000;
// Bound OCR's internal parallelism so it can't starve other queued conversions.
const OCR_JOBS = Number(process.env.OCR_JOBS) || 2;
// Languages users may pick. Each needs its tesseract data pack installed.
export const OCR_LANGUAGES = ["eng", "tur", "deu", "fra", "spa", "ita", "por", "nld"];

// Below this many extractable characters per page, a PDF is treated as scanned.
// Kept deliberately low: a genuine scan yields ~0 characters (at most a stamped
// page number), while sparsely-set real text — poetry, title pages, wide-margin
// typesetting — can still be quite thin. Erring towards "has text" is the safer
// mistake: it gives the reader adjustable font size, and if the text turns out to
// be unusable the reflowable conversion fails and we fall back to page images.
const MIN_CHARS_PER_PAGE = 12;

// OCR output is held to a stricter standard — we only replace the page images
// with recognised text if enough of it came back to make a real book.
const OCR_MIN_CHARS_PER_PAGE = 50;

// Share of pages that must be a full-page image before the PDF counts as a scan.
// Not 100%: real books have a plate section, a colophon, or a stray typeset page.
const SCANNED_PAGE_RATIO = 0.8;

const escapeXml = (s = "") =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

// ---- Capability probes (used by /api/health) ----
export async function probe(bin, args = ["--version"]) {
  try {
    await execFileAsync(bin, args, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Which engines are installed. Every visitor's page load hits /api/health, and
// each probe spawns a process, so the answer is cached briefly — the installed
// binaries don't change minute to minute, but the TTL still lets a newly
// installed engine be picked up without a restart.
const CAPS_TTL_MS = 60_000;
let capsCache = { at: 0, value: null };

export async function capabilities() {
  const now = Date.now();
  if (capsCache.value && now - capsCache.at < CAPS_TTL_MS) return capsCache.value;
  const [calibre, poppler, ocr] = await Promise.all([
    probe(EBOOK_CONVERT, ["--version"]),
    probe(PDFTOPPM, ["-v"]),
    OCR_ENABLED ? probe(OCRMYPDF, ["--version"]) : Promise.resolve(false),
  ]);
  capsCache = { at: now, value: { calibre, poppler, ocr } };
  return capsCache.value;
}

// ---- How many pages? Cheap: pdfinfo only, no text extraction ----
export async function pageCount(inputPath) {
  try {
    const { stdout } = await execFileAsync(PDFINFO, [inputPath], { timeout: 30000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0; // unreadable or pdfinfo missing — progress just won't show a total
  }
}

// ---- Is this a scan? i.e. are the pages themselves pictures ----
// Returns the share of pages carrying an image big enough to be the page itself.
// A digital PDF scores 0; a scanned book scores ~1. Cheap: ~0.7s for 286 pages.
export async function pageImageCoverage(inputPath, pages, pageW, pageH) {
  if (!pages) return 0;
  try {
    const { stdout } = await execFileAsync(PDFIMAGES, ["-list", inputPath], {
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    // A page-sized image is at least ~100dpi across the page's width and height.
    const minW = (pageW / 72) * 100;
    const minH = (pageH / 72) * 100;
    const covered = new Set();
    for (const line of stdout.split("\n").slice(2)) {
      const f = line.trim().split(/\s+/);
      const [pg, w, h] = [Number(f[0]), Number(f[3]), Number(f[4])];
      if (Number.isFinite(pg) && w >= minW && h >= minH) covered.add(pg);
    }
    return covered.size / pages;
  } catch {
    return 0; // pdfimages missing or unreadable — assume not a scan
  }
}

// ---- Pull out a PDF's existing text layer, one chunk per page ----
// pdftotext separates pages with a form feed, which is the same shape
// buildOcrDocument already consumes.
export async function extractTextLayer(inputPath) {
  const { stdout } = await execFileAsync(PDFTOTEXT, ["-q", inputPath, "-"], {
    timeout: 180000,
    maxBuffer: 200 * 1024 * 1024,
  });
  return stdout;
}

// ---- Detection: does this PDF actually contain selectable text? ----
export async function inspectPdf(inputPath) {
  let pages = 0;
  let pageW = 612;
  let pageH = 792;
  try {
    const { stdout } = await execFileAsync(PDFINFO, [inputPath], { timeout: 30000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    if (m) pages = Number(m[1]);
    const s = stdout.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m);
    if (s) {
      pageW = Number(s[1]);
      pageH = Number(s[2]);
    }
  } catch {
    /* ignore — treated as unknown below */
  }

  let textChars = 0;
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT, ["-q", inputPath, "-"], {
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024,
    });
    textChars = stdout.replace(/\s/g, "").length;
  } catch {
    /* ignore */
  }

  const perPage = pages > 0 ? textChars / pages : textChars;
  const isImageBased = perPage < MIN_CHARS_PER_PAGE;

  // A scan can still carry a text layer — someone already OCR'd it. That text is
  // usually written invisibly on top of the page image, and Calibre's PDF input
  // ignores invisible text, so handing it the PDF yields a book of pictures with
  // the words silently dropped. Knowing the pages are images lets us take the
  // text out ourselves instead.
  const imageRatio = await pageImageCoverage(inputPath, pages, pageW, pageH);

  return {
    pages,
    textChars,
    isImageBased,
    imageRatio,
    // Pages are pictures, yet text comes out of it: a scan with an OCR layer.
    hasHiddenTextLayer: !isImageBased && imageRatio >= SCANNED_PAGE_RATIO,
  };
}

// ---- Read the PDF's embedded title/author (Document Info dictionary) ----
export async function pdfMetadata(inputPath) {
  const meta = { title: "", author: "" };
  try {
    const { stdout } = await execFileAsync(PDFINFO, [inputPath], { timeout: 30000 });
    const t = stdout.match(/^Title:\s+(.+?)\s*$/m);
    const a = stdout.match(/^Author:\s+(.+?)\s*$/m);
    if (t && t[1].trim()) meta.title = t[1].trim();
    if (a && a[1].trim()) meta.author = a[1].trim();
  } catch {
    /* pdfinfo missing or PDF unreadable — leave blank */
  }
  return meta;
}

// ---- Render the first page to a JPEG to use as the book cover ----
// Best-effort: returns a path, or null if poppler is unavailable / it fails.
async function renderCover(inputPath, dir, dpi) {
  const prefix = path.join(dir, "cover");
  try {
    // -singlefile writes exactly `cover.jpg` (no page-number suffix).
    await execFileAsync(
      PDFTOPPM,
      ["-jpeg", "-f", "1", "-l", "1", "-singlefile", "-r", String(dpi || 150), inputPath, prefix],
      { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }
    );
    const coverPath = `${prefix}.jpg`;
    await fs.access(coverPath);
    return coverPath;
  } catch {
    return null;
  }
}

// ---- OCR: recognise the words on a scanned PDF's pages ----
// Turns page images into real text so the book can be made reflowable (and
// therefore resizable on an e-reader). Slow and CPU-heavy — opt-in only.
//
// We keep the `--sidecar` plain-text output and build the book from THAT, not
// from the OCR'd PDF. OCRmyPDF writes its text as an *invisible* layer over the
// page image, and Calibre's PDF input (both engines) ignores invisible text — it
// would produce a book of images again. The sidecar is the same recognised text
// without that problem.
//
// Returns { pdfPath, textPath, chars }.
export async function runOcr(inputPath, jobDir, opts = {}) {
  const pdfPath = path.join(jobDir, "ocr.pdf");
  const textPath = path.join(jobDir, "ocr.txt");
  const lang = OCR_LANGUAGES.includes(opts.ocrLang) ? opts.ocrLang : "eng";
  const timeoutMs = opts.ocrTimeoutMs || OCR_TIMEOUT_MS;

  const args = [
    "--skip-text", // leave pages that already have text untouched
    "--output-type", "pdf", // plain PDF is much faster than PDF/A
    "--optimize", "0", // we only need the text, not a smaller file
    // Verbose logging prefixes each line with the page it concerns, which is the
    // only honest source of progress we have — so we stream it instead of --quiet.
    "--verbose", "1",
    "-l", lang,
    "--jobs", String(opts.ocrJobs || OCR_JOBS),
    "--sidecar", textPath,
    inputPath,
    pdfPath,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(OCRMYPDF, args);
    let tail = "";
    let maxPage = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stderr.on("data", (buf) => {
      const chunk = buf.toString();
      tail = (tail + chunk).slice(-4000); // keep the end for error reporting
      // Lines look like "   12 Running: ['tesseract', ...]" — the leading number
      // is the page. Track the furthest page reached so progress only moves
      // forward even though pages finish out of order.
      for (const m of chunk.matchAll(/^\s*(\d+)\s+\S/gm)) {
        const page = Number(m[1]);
        if (page > maxPage) {
          maxPage = page;
          opts.onProgress?.({ page });
        }
      }
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error(`OCR timed out after ${Math.round(timeoutMs / 60000)} min`);
        e.isTimeout = true;
        return reject(e);
      }
      if (code !== 0) {
        return reject(new Error(`OCR failed (exit ${code}): ${tail.trim().split("\n").slice(-3).join(" | ")}`));
      }
      resolve();
    });
  });

  const text = await fs.readFile(textPath, "utf8").catch(() => "");
  return { pdfPath, textPath, text, chars: text.replace(/\s/g, "").length };
}

// ---- Strip running heads, page numbers and watermarks ----
// A scanned book repeats its title, author and page number in the margin of every
// page. Extracting the text pulls that furniture into the middle of the prose,
// where an e-reader reflows it straight into the sentences. By this point the text
// has no coordinates, so it can't be removed by position — but it can be removed
// by repetition: furniture recurs across pages, prose does not.
//
// Only the first and last few lines of a page are candidates, and a line must
// recur across a quarter of the pages, so a phrase repeated inside the prose is
// safe. Digits normalise to '#', so "-22-" and "-23-" count as one pattern.
export function stripPageFurniture(pages, opts = {}) {
  const { headLines = 2, footLines = 3, minPages = 6, ratio = 0.25, maxLen = 80 } = opts;
  if (pages.length < minPages) return { pages, removed: 0, patterns: [] };

  const norm = (s) => s.trim().replace(/\s+/g, " ").replace(/\d+/g, "#").toLowerCase();
  const zones = (p) => {
    const ne = p.split("\n").map((l, i) => [l, i]).filter(([l]) => l.trim());
    return [ne.slice(0, headLines), ne.slice(-footLines)];
  };

  const head = new Map();
  const foot = new Map();
  for (const p of pages) {
    const [h, f] = zones(p);
    for (const [l] of h) {
      const k = norm(l);
      if (k) head.set(k, (head.get(k) || 0) + 1);
    }
    for (const [l] of f) {
      const k = norm(l);
      if (k) foot.set(k, (foot.get(k) || 0) + 1);
    }
  }

  const need = Math.max(3, Math.floor(pages.length * ratio));
  const isFurniture = (line, counts) => {
    const k = norm(line);
    return k.length > 0 && k.length <= maxLen && (counts.get(k) || 0) >= need;
  };

  let removed = 0;
  const cleaned = pages.map((p) => {
    const lines = p.split("\n");
    const [h, f] = zones(p);
    const kill = new Set();
    for (const [l, i] of h) if (isFurniture(l, head)) kill.add(i);
    for (const [l, i] of f) if (isFurniture(l, foot)) kill.add(i);
    removed += kill.size;
    return lines.filter((_, i) => !kill.has(i)).join("\n");
  });

  const patterns = [...head, ...foot]
    .filter(([k, n]) => k.length <= maxLen && n >= need)
    .sort((a, b) => b[1] - a[1]);

  return { pages: cleaned, removed, patterns };
}

// ---- Per-page fallback ----
// OCR quality varies page by page: a fold, a photo or a bad scan can leave one
// page unreadable in a book that is otherwise fine. Rather than judging the whole
// document (which either discards good text or ships blank pages), each page is
// checked on its own — recognised pages become real text, unreadable ones keep
// the scanned image so nothing is silently lost.
//
// The result is ONE reflowable document: the image pages are ordinary <img> in a
// reflowable page, which every reader supports, so the book stays resizable
// throughout instead of needing mixed fixed/reflowable layout.
async function buildOcrDocument(inputPath, jobDir, pagesText, opts = {}) {
  const dir = path.join(jobDir, "book");
  const imgDir = path.join(dir, "pages");
  await fs.mkdir(imgDir, { recursive: true });

  // Both sources of page text — an existing text layer and our own OCR — carry
  // the page's running head and number, so clean them here rather than twice.
  let furniture = { removed: 0, patterns: [] };
  if (opts.stripFurniture !== false) {
    furniture = stripPageFurniture(pagesText);
    pagesText = furniture.pages;
    if (furniture.removed) {
      console.error(
        `Removed ${furniture.removed} header/footer line(s): ` +
          furniture.patterns.slice(0, 4).map(([k, n]) => `"${k}"×${n}`).join(", ")
      );
    }
  }

  const parts = [];
  let textPages = 0;
  let imagePages = 0;

  const total = pagesText.length;
  for (let i = 0; i < total; i++) {
    const n = i + 1;
    const raw = (pagesText[i] || "").trim();
    // Rasterising the unreadable pages happens in this loop, so report as we go.
    opts.onProgress?.({ page: n, pages: total });

    if (raw.replace(/\s/g, "").length >= OCR_MIN_CHARS_PER_PAGE) {
      textPages++;
      // OCR emits a newline per scanned line; blank lines separate paragraphs.
      for (const para of raw.split(/\n\s*\n/)) {
        const joined = para
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (joined) parts.push(`<p>${escapeXml(joined)}</p>`);
      }
    } else {
      // Couldn't read this page — keep the page itself rather than losing it.
      const prefix = path.join(imgDir, `p${n}`);
      try {
        await execFileAsync(
          PDFTOPPM,
          ["-jpeg", "-f", String(n), "-l", String(n), "-singlefile", "-r",
            String(opts.dpi || RASTER_DPI), inputPath, prefix],
          { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }
        );
        await fs.access(`${prefix}.jpg`);
        parts.push(
          `<div class="scan"><img src="pages/p${n}.jpg" alt="Page ${n} (scanned)"/></div>`
        );
        imagePages++;
      } catch {
        /* page couldn't be rendered either — skip it rather than fail the book */
      }
    }
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escapeXml(opts.title || "Converted PDF")}</title>
<style>.scan{margin:1em 0;text-align:center;page-break-inside:avoid}.scan img{max-width:100%}</style>
</head><body>
${parts.join("\n")}
</body></html>`;

  const htmlPath = path.join(dir, "index.html");
  await fs.writeFile(htmlPath, html, "utf8");
  return { htmlPath, textPages, imagePages, furnitureRemoved: furniture.removed };
}

// ---- Page furniture in a digital PDF ----
// The repetition-based stripper only ever ran on scans, because that is the only
// path where we assemble the text ourselves. An ordinary PDF goes straight to
// Calibre, which keeps the running head and page number and — worse — splices
// them into the middle of whichever sentence spans the page break:
//
//   ...he's wearing a pair of 10 Infect Your Friends and Loved Ones old coveralls...
//
// Calibre's own --pdf-header-regex only inspects a page's first line, and books
// routinely put two things up there, so it cannot do this job. Instead we find
// the furniture from the PDF itself, where coordinates make it unambiguous, and
// remove it from the converted book afterwards.

// Letters and digits only. Calibre normalises the letter-spaced "Tor rey Peters"
// into "Torrey Peters", so anything looser than this fails to match.
const furnitureKey = (s) =>
  s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ")
   .toLowerCase().replace(/[^a-z0-9]+/g, "");

// A line is furniture when it sits in a page's margin AND recurs across pages.
// Position alone catches chapter openers; repetition alone catches refrains.
export async function findPageFurniture(inputPath, opts = {}) {
  const { band = 0.1, ratio = 0.25, maxLen = 90 } = opts;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(PDFTOTEXT, ["-bbox-layout", inputPath, "-"], {
      timeout: 180000,
      maxBuffer: 400 * 1024 * 1024,
    }));
  } catch {
    return new Set(); // no coordinates available, so nothing to be confident about
  }

  const pages = [...stdout.matchAll(/<page width="[\d.]+" height="([\d.]+)">([\s\S]*?)<\/page>/g)];
  if (pages.length < 6) return new Set();

  const norm = (t) => t.trim().replace(/\s+/g, " ").replace(/\d+/g, "#").toLowerCase();
  const counts = new Map();
  const bodyLens = [];
  const candidates = [];
  for (const [, h, body] of pages) {
    const H = Number(h);
    for (const m of body.matchAll(/<line[^>]*yMin="([\d.]+)"[^>]*>([\s\S]*?)<\/line>/g)) {
      const y = Number(m[1]);
      const text = [...m[2].matchAll(/>([^<]+)<\/word>/g)].map((w) => w[1]).join(" ");
      if (!text.trim()) continue;
      if (y >= H * band && y <= H * (1 - band)) {
        bodyLens.push(text.length); // measure the page's normal line length
      } else {
        candidates.push(text);
      }
    }
  }

  // Margins are only a pre-filter: a page's first body line can fall inside the
  // band on a tightly-set book. A running head is also markedly shorter than a
  // line of prose, so calibrate against this document's own measure rather than
  // trusting a fixed number of characters.
  bodyLens.sort((a, b) => a - b);
  const medianBody = bodyLens.length ? bodyLens[Math.floor(bodyLens.length / 2)] : 0;
  const lenCap = Math.min(maxLen, Math.max(40, Math.round(medianBody * 0.6)));

  for (const text of candidates) {
    const k = norm(text);
    if (k && k.length <= lenCap) counts.set(k, (counts.get(k) || 0) + 1);
  }

  const need = Math.max(3, Math.floor(pages.length * ratio));
  const keys = new Set(
    [...counts]
      .filter(([k, n]) => n >= need && k !== "#")
      .map(([k]) => furnitureKey(k))
      .filter(Boolean)
  );
  // A page number is a shape, not a string, so it is not a key. Record only that
  // this book puts numbers in its margins, which licenses removing a stray digit
  // clinging to a paragraph's edge; without that evidence a lone number could be
  // a footnote marker or part of the prose.
  if ((counts.get("#") || 0) >= need) keys.marginNumbers = true;
  return keys;
}

// Remove those strings from one XHTML file, and heal the seam behind them.
export function stripFurnitureHtml(html, keys) {
  let removed = 0;
  // A page number that ended up inside a paragraph, at its start or its end.
  if (keys.marginNumbers) {
    html = html.replace(
      /(<p\b[^>]*>)\s*<(span|i|b|em|strong)\b[^>]*>\s*\d{1,4}\s*<\/\2>\s*/gi,
      (m, open) => { removed++; return open; }
    );
    html = html.replace(
      /\s*<(span|i|b|em|strong)\b[^>]*>\s*\d{1,4}\s*<\/\1>\s*(<\/p>)/gi,
      (m, _t, close) => { removed++; return close; }
    );
  }
  // Inline: the furniture element, plus a bare page number leaning against it.
  html = html.replace(
    /(\s*\b\d{1,4}\b)?\s*<(span|i|b|em|strong)\b[^>]*>((?:(?!<\/?\2\b)[\s\S])*?)<\/\2>\s*/gi,
    (m, _num, tag, inner) => {
      if (!keys.has(furnitureKey(inner))) return m;
      removed++;
      return " ";
    }
  );
  // A block left holding only a number, or nothing, or furniture alone. Headings
  // are included deliberately: Calibre's heuristics promote a lone page number to
  // an <h2>, which then becomes an entry in the table of contents, so a book ends
  // up with a contents list of page numbers instead of chapters.
  html = html.replace(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => {
    const text = inner.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
    if (text === "" || /^\d{1,4}$/.test(text) || keys.has(furnitureKey(inner))) {
      removed++;
      return "";
    }
    return m;
  });

  // Rejoin a sentence broken by a page turn. Calibre paragraphs each page
  // separately, so a sentence spanning the break arrives as two paragraphs; the
  // giveaway is the first ending without punctuation and the second opening
  // lower-case. A hyphen at the break is a split word, so close it up.
  let joins = 0;
  const BLOCK = /<p\b[^>]*>([\s\S]*?)<\/p>(\s*)<p\b[^>]*>([\s\S]*?)<\/p>/i;
  for (let guard = 0; guard < 500; guard++) {
    let changed = false;
    html = html.replace(BLOCK, (m, a, gap, b) => {
      const endA = a.replace(/<[^>]*>/g, "").trim();
      const startB = b.replace(/<[^>]*>/g, "").trim();
      if (!endA || !startB) return m;
      const unfinished = !/[.!?:;”’"')\]]$/.test(endA);
      const continues = /^[a-zàâäèéêëîïôöùûüçğışœæ]/.test(startB);
      if (!(unfinished && continues)) return m;
      changed = true;
      joins++;
      const hyphenated = /-$/.test(endA);
      const head = hyphenated ? a.replace(/-(\s*(?:<[^>]*>\s*)*)$/, "$1") : a;
      return `<p>${head}${hyphenated ? "" : " "}${b}</p>`;
    });
    if (!changed) break;
  }

  // Close the gap so an interrupted sentence reads as one again.
  html = html.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?’”])/g, "$1");
  return { html, removed, joins };
}

// Apply it across a finished EPUB, in place.
export async function stripFurnitureFromEpub(epubPath, keys) {
  if (!keys.size) return { removed: 0, joined: 0 };
  const zip = await JSZip.loadAsync(await fs.readFile(epubPath));
  let removed = 0;
  let joined = 0;
  const names = Object.keys(zip.files).filter((n) => /\.(x?html)$/i.test(n));
  for (const name of names) {
    const src = await zip.file(name).async("string");
    const r = stripFurnitureHtml(src, keys);
    if (r.removed || r.joins) {
      zip.file(name, r.html);
      removed += r.removed;
      joined += r.joins || 0;
    }
  }
  if (!removed && !joined) return { removed: 0, joined: 0 };

  // Rebuild rather than re-save. EPUB requires "mimetype" to be the archive's
  // first entry, stored uncompressed; JSZip's regenerate does not preserve that,
  // and a book that loses it stops being recognised as an EPUB at all.
  const out = new JSZip();
  out.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const name of Object.keys(zip.files)) {
    if (name === "mimetype") continue;
    const entry = zip.files[name];
    if (entry.dir) continue;
    out.file(name, await entry.async("nodebuffer"));
  }
  const buf = await out.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/epub+zip",
  });
  await fs.writeFile(epubPath, buf);
  return { removed, joined };
}

// ---- Strategy A: reflowable EPUB via Calibre ----
export async function convertReflowable(inputPath, outputPath, jobDir, opts = {}) {
  const baseArgs = [inputPath, outputPath, "--output-profile", opts.profile || "tablet"];
  if (opts.title) baseArgs.push("--title", opts.title);
  if (opts.author) baseArgs.push("--authors", opts.author);
  const args = baseArgs;

  // OCR'd books are converted from plain text, which has a hard line break at the
  // end of every scanned line. This tells Calibre to rejoin them into paragraphs
  // instead of treating each line as its own.
  if (opts.isText) args.push("--paragraph-type", "unformatted");

  // Give the book a real cover (first page image) so it shows a proper thumbnail
  // in the e-reader library. Calibre's PDF input often produces no usable cover.
  // Always render it from the original PDF — the input here may be OCR text.
  const coverPath = await renderCover(opts.coverSource || inputPath, jobDir, opts.coverDpi || 150);
  if (coverPath) args.push("--cover", coverPath);

  // Hand typography and colour control to the e-reader.
  //
  // colours: without this, pages the PDF authored as white-on-dark (chapter
  //   openers, callout boxes) render as black pages with white text on a Kindle.
  // font-family: a PDF's fonts leaking into the CSS override the reader's own
  //   font choice. Removing it lets the Kindle font setting win.
  //
  // Note we deliberately do NOT filter font-size: Calibre emits relative `em`
  // sizes, which already scale with the reader's font-size setting while keeping
  // headings proportionally larger. Stripping it would flatten that hierarchy.
  const cssFilters = [];
  if (!opts.keepColors) cssFilters.push("color", "background", "background-color");
  if (!opts.keepFonts) cssFilters.push("font-family");
  if (cssFilters.length) args.push("--filter-css", cssFilters.join(","));

  // Don't let the PDF's page geometry dictate margins — the Kindle applies its
  // own, and large baked-in margins waste screen space at bigger font sizes.
  args.push("--margin-top", "0", "--margin-bottom", "0", "--margin-left", "0", "--margin-right", "0");

  // Tell Calibre about the furniture before it converts, not just after. Left to
  // itself it promotes a lone page number to a heading, which becomes a table of
  // contents full of numbers and splits the book at every page, so a sentence
  // spanning the break ends up in two different files where nothing can rejoin
  // it. --pdf-header-regex only inspects a page's first line, which is why the
  // post-pass still runs, but it stops the damage that cannot be undone later.
  let furnitureKeys = new Set();
  if (opts.stripFurniture !== false && /\.pdf$/i.test(opts.coverSource || inputPath)) {
    furnitureKeys = await findPageFurniture(opts.coverSource || inputPath).catch(() => new Set());
    if (furnitureKeys.size) {
      // Match the head with flexible spacing (the PDF may be letter-spaced) and
      // an optional page number on either side of it.
      const alts = [...furnitureKeys].map((k) =>
        k.split("").map((c) => (/[a-z0-9]/.test(c) ? c : "\\" + c)).join("\\s*")
      );
      args.push(
        "--pdf-header-regex",
        `(?i)^\\s*(\\d{1,4}\\s*)?(${alts.join("|")})(\\s*\\d{1,4})?\\s*$`
      );
    }
  }

  // Calibre inserts a page break at every PDF page and splits the EPUB there, so
  // a sentence spanning the break lands in two separate documents where nothing
  // can rejoin it. A PDF page boundary is an artefact of paper, not a structural
  // division of the book, so stop breaking on it; real chapters come from
  // headings and still reach the table of contents.
  if (/\.pdf$/i.test(opts.coverSource || inputPath)) {
    args.push("--page-breaks-before", "/");
  }

  const timeoutMs = opts.timeoutMs || CONVERT_TIMEOUT_MS;

  // Spawned rather than exec'd so Calibre's progress can be streamed as it runs.
  // It prints lines like "34% Running transforms on e-book...", which is the only
  // insight available into a phase that can take minutes on a full-length book.
  const run = (extraArgs) =>
    new Promise((resolve, reject) => {
      const child = spawn(EBOOK_CONVERT, [...args, ...extraArgs]);
      let stderr = "";
      let killedByTimeout = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (buf) => {
        for (const line of buf.toString().split("\n")) {
          const m = line.match(/^\s*(\d+)%\s+(.*\S)/);
          if (m) opts.onProgress?.({ percent: Number(m[1]), detail: m[2].replace(/\.\.\.$/, "") });
        }
      });
      // Keep only the tail: Calibre's tracebacks are long and only the end matters.
      child.stderr.on("data", (buf) => {
        stderr = (stderr + buf.toString()).slice(-4000);
      });

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e); // ENOENT etc. — surfaced as "tool not installed"
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killedByTimeout) {
          const err = new Error(`Calibre timed out after ${Math.round(timeoutMs / 60000)} min`);
          err.isTimeout = true;
          return reject(err);
        }
        if (code === 0) return resolve();
        const detail = stderr.trim().split("\n").slice(-6).join(" | ");
        reject(new Error(`Calibre failed${detail ? `: ${detail}` : ` (exit ${code})`}`));
      });
    });

  const wantsHeuristics = opts.heuristics !== false;
  let heuristicsSkipped = false;
  try {
    await run(wantsHeuristics ? ["--enable-heuristics"] : []);
  } catch (e) {
    // Heuristics (chapter detection, layout clean-up) roughly doubles conversion
    // time and is the usual reason a long book blows the budget. Rather than fail
    // outright, retry without it — the book is still reflowable and resizable,
    // just less tidily structured.
    if (!e.isTimeout || !wantsHeuristics) throw e;
    console.error("Timed out with heuristics — retrying without them.");
    await run([]);
    heuristicsSkipped = true;
  }

  // Guard against "succeeded" but produced an empty/broken file.
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size < 1024) throw new Error("Calibre produced an empty EPUB.");

  // Take the running head and page number out of the finished book. Only for a
  // PDF source: the coordinates come from the PDF, and an HTML source (our own
  // assembled text) has already been cleaned before it got here.
  let furnitureRemoved = 0;
  if (opts.stripFurniture !== false && /\.pdf$/i.test(opts.coverSource || inputPath)) {
    try {
      const keys = furnitureKeys.size
        ? furnitureKeys
        : await findPageFurniture(opts.coverSource || inputPath);
      const r = await stripFurnitureFromEpub(outputPath, keys);
      furnitureRemoved = r.removed;
      if (r.removed || r.joined) {
        console.error(
          `Cleaned the book: removed ${r.removed} furniture element(s) ` +
            `(${[...keys].join(", ")}), rejoined ${r.joined} sentence(s) split by a page turn.`
        );
      }
    } catch (e) {
      // A book with its headers left in beats no book at all.
      console.error("Furniture removal skipped:", e.message);
    }
  }

  return { outputPath, heuristicsSkipped, furnitureRemoved };
}

// ---- Read width/height from a PNG or JPEG buffer (no image library needed) ----
function imageSize(buf) {
  // PNG: dimensions live in the IHDR chunk at fixed offsets.
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 8) {
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = buf[o + 1];
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

// ---- Strategy B: fixed-layout image EPUB (works on ANY PDF) ----
// Rasterizes each page to a JPEG and wraps them in an EPUB 3 pre-paginated book.
export async function convertFixedLayout(inputPath, outputPath, jobDir, opts = {}) {
  const pagesDir = path.join(jobDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });

  // Render every page to pages/page-N.jpg (pdftoppm zero-pads the number).
  // pdftoppm prints no progress, so count the files it has written instead —
  // rendering a long book is otherwise several silent minutes.
  const expected = opts.totalPages || 0;
  const ticker = opts.onProgress
    ? setInterval(async () => {
        const done = (await fs.readdir(pagesDir).catch(() => [])).filter((f) =>
          /\.jpe?g$/i.test(f)
        ).length;
        opts.onProgress({ page: done, pages: expected });
      }, 1000)
    : null;
  try {
    await execFileAsync(
      PDFTOPPM,
      ["-jpeg", "-r", String(opts.dpi || RASTER_DPI), inputPath, path.join(pagesDir, "page")],
      { timeout: opts.timeoutMs || 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }
    );
  } finally {
    if (ticker) clearInterval(ticker);
  }

  const files = (await fs.readdir(pagesDir))
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] || 0);
      const nb = Number(b.match(/(\d+)/)?.[1] || 0);
      return na - nb;
    });

  if (files.length === 0) throw new Error("No pages could be rendered from the PDF.");

  const zip = new JSZip();
  // Per spec: mimetype must be the first entry and stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  const oebps = zip.folder("OEBPS");
  const manifestItems = [];
  const spineItems = [];
  const navItems = [];

  for (let i = 0; i < files.length; i++) {
    const n = i + 1;
    // Second pass over the pages — reported separately so the count doesn't
    // appear to run twice from 1..N with no explanation.
    opts.onPackaging?.({ page: n, pages: files.length });
    const data = await fs.readFile(path.join(pagesDir, files[i]));
    const dim = imageSize(data) || { width: 1200, height: 1600 };

    const imgHref = `images/page${n}.jpg`;
    const pageHref = `page${n}.xhtml`;
    oebps.file(imgHref, data);
    oebps.file(
      pageHref,
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=${dim.width}, height=${dim.height}"/>
<title>Page ${n}</title>
<style>html,body{margin:0;padding:0;} img{display:block;width:100%;height:100%;object-fit:contain;}</style>
</head>
<body>
<div class="page"><img src="${imgHref}" alt="Page ${n}" width="${dim.width}" height="${dim.height}"/></div>
</body>
</html>`
    );

    // Mark the first page as the cover image so the library shows a thumbnail.
    const coverProp = i === 0 ? ` properties="cover-image"` : "";
    manifestItems.push(`<item id="img${n}" href="${imgHref}" media-type="image/jpeg"${coverProp}/>`);
    manifestItems.push(
      `<item id="page${n}" href="${pageHref}" media-type="application/xhtml+xml"/>`
    );
    spineItems.push(`<itemref idref="page${n}"/>`);
    navItems.push(`<li><a href="${pageHref}">Page ${n}</a></li>`);
  }

  const title = escapeXml(opts.title || "Converted PDF");
  const author = escapeXml(opts.author || "Unknown");
  const uid = `urn:uuid:${cryptoRandom()}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  oebps.file(
    "nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>${title}</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.join("")}</ol></nav>
</body>
</html>`
  );

  oebps.file(
    "content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${now}</meta>
    <meta name="cover" content="img1"/>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">auto</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>
    ${spineItems.join("\n    ")}
  </spine>
</package>`
  );

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/epub+zip",
  });
  await fs.writeFile(outputPath, buf);
  return outputPath;
}

function cryptoRandom() {
  // Small helper so we don't import crypto just for one id.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---- Orchestrator: pick the right strategy, with automatic fallback ----
// mode: "auto" | "reflowable" | "fixed"
// Returns { outputPath, method } where method is what actually ran.
export async function convert(inputPath, outputPath, jobDir, opts = {}) {
  const mode = opts.mode || "auto";
  const report = (patch) => opts.onProgress?.(patch);

  // Progress wiring for the two strategies. Written as functions so they pick up
  // `opts` as it is when the strategy actually runs — the OCR branch reassigns it.
  const fixedOpts = (totalPages) => ({
    ...opts,
    totalPages,
    onProgress: ({ page, pages }) => report({ stage: "rendering", page, pages }),
    onPackaging: ({ page, pages }) => report({ stage: "packaging", page, pages }),
  });
  const reflowOpts = () => ({
    ...opts,
    onProgress: ({ percent, detail }) => report({ stage: "converting", percent, detail }),
  });

  report({ stage: "analyzing" });

  // Resolve title/author once, with precedence: what the user typed wins, then the
  // PDF's own embedded metadata, then the original filename (title) / "Unknown".
  const meta = await pdfMetadata(inputPath);
  opts = {
    ...opts,
    title: opts.title || meta.title || opts.fallbackTitle || "",
    author: opts.author || meta.author || "",
  };

  // Fixed layout is a deliberate choice — never OCR or reflow it. Only the page
  // count is needed here, so skip the full text-detection pass.
  if (mode === "fixed") {
    const total = await pageCount(inputPath);
    report({ stage: "rendering", page: 0, pages: total });
    await convertFixedLayout(inputPath, outputPath, jobDir, fixedOpts(total));
    return { outputPath, method: "fixed" };
  }

  const info = await inspectPdf(inputPath).catch(() => ({ isImageBased: false }));

  // OCR (opt-in): a scanned PDF has no text to reflow, so recognise it first.
  // Only worth doing when the PDF really is image-based — a PDF that already has
  // text gains nothing and would just burn CPU.
  let sourcePath = inputPath;
  let ocrApplied = false;
  let usedTextLayer = false;
  let pageStats = null;

  // A scan someone has already OCR'd: the words are there, but written invisibly
  // over the page images, and Calibre drops them. Take the text out with
  // pdftotext and build the book from that — no OCR needed, the recognition has
  // already been done, and it is far better than re-recognising it ourselves.
  if (info.hasHiddenTextLayer) {
    try {
      report({ stage: "extracting", pages: info.pages || 0, page: 0 });
      const text = await extractTextLayer(inputPath);
      const doc = await buildOcrDocument(inputPath, jobDir, text.split("\f"), {
        ...opts,
        onProgress: ({ page, pages }) => report({ stage: "building", page, pages }),
      });
      if (doc.textPages > 0) {
        sourcePath = doc.htmlPath;
        usedTextLayer = true;
        pageStats = { textPages: doc.textPages, imagePages: doc.imagePages };
        opts = { ...opts, isText: false, coverSource: inputPath };
        console.error(
          `Text layer: ${doc.textPages} page(s) as text, ${doc.imagePages} kept as images.`
        );
      }
    } catch (e) {
      // Fall through to the normal paths — worse output, but still a book.
      console.error("Text-layer extraction failed, continuing without it:", e.message);
    }
  }

  if (opts.ocr && !OCR_ENABLED) {
    console.error("OCR requested but disabled (set OCR_ENABLED=true to allow it).");
  }
  if (OCR_ENABLED && opts.ocr && info.isImageBased) {
    try {
      report({ stage: "ocr", pages: info.pages || 0, page: 0 });
      const ocr = await runOcr(inputPath, jobDir, {
        ...opts,
        onProgress: ({ page }) => report({ stage: "ocr", page, pages: info.pages || 0 }),
      });

      // Only trust the result if OCR actually found text — a poor scan can come
      // back essentially empty, which would otherwise produce a blank "book".
      const minChars = Math.max(OCR_MIN_CHARS_PER_PAGE, (info.pages || 1) * OCR_MIN_CHARS_PER_PAGE);
      if (ocr.chars >= minChars) {
        report({ stage: "building", page: 0, pages: info.pages || 0 });
        // Judge each page separately, keeping the scan for pages OCR couldn't read.
        const doc = await buildOcrDocument(inputPath, jobDir, ocr.text.split("\f"), {
          ...opts,
          onProgress: ({ page, pages }) => report({ stage: "building", page, pages }),
        });
        if (doc.textPages > 0) {
          sourcePath = doc.htmlPath;
          ocrApplied = true;
          pageStats = { textPages: doc.textPages, imagePages: doc.imagePages };
          // Build from the recognised pages, but take the cover from the real PDF.
          opts = { ...opts, isText: false, coverSource: inputPath };
          if (doc.imagePages) {
            console.error(
              `OCR: ${doc.textPages} page(s) as text, ${doc.imagePages} kept as images.`
            );
          }
        }
      } else {
        console.error(`OCR found too little text (${ocr.chars} chars) — using page images.`);
      }
    } catch (e) {
      // OCR unavailable or failed — carry on with the normal paths below.
      console.error("OCR failed, continuing without it:", e.message);
    }
  }

  if (mode === "reflowable") {
    report({ stage: "converting", percent: 0 });
    const r = await convertReflowable(sourcePath, outputPath, jobDir, reflowOpts());
    return {
      outputPath,
      method: ocrApplied ? "reflowable-ocr" : usedTextLayer ? "reflowable-textlayer" : "reflowable",
      heuristicsSkipped: r.heuristicsSkipped,
      ...pageStats,
    };
  }

  // auto: reflow when there's text to reflow (possibly thanks to OCR), else
  // fall back to fixed-layout so the file always converts.
  if (info.isImageBased && !ocrApplied) {
    report({ stage: "rendering", page: 0, pages: info?.pages || 0 });
    await convertFixedLayout(inputPath, outputPath, jobDir, fixedOpts(info?.pages || 0));
    return { outputPath, method: "fixed" };
  }

  try {
    report({ stage: "converting", percent: 0 });
    const r = await convertReflowable(sourcePath, outputPath, jobDir, reflowOpts());
    return {
      outputPath,
      method: ocrApplied ? "reflowable-ocr" : usedTextLayer ? "reflowable-textlayer" : "reflowable",
      heuristicsSkipped: r.heuristicsSkipped,
      ...pageStats,
    };
  } catch (e) {
    // Reflowable failed — fall back to the original pages so the user still
    // gets a readable file.
    report({ stage: "rendering", page: 0, pages: info?.pages || 0 });
    await convertFixedLayout(inputPath, outputPath, jobDir, fixedOpts(info?.pages || 0));
    return { outputPath, method: "fixed-fallback" };
  }
}
