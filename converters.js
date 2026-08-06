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
const OCRMYPDF = process.env.OCRMYPDF || "ocrmypdf";
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
    probe(OCRMYPDF, ["--version"]),
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

// ---- Detection: does this PDF actually contain selectable text? ----
export async function inspectPdf(inputPath) {
  let pages = 0;
  try {
    const { stdout } = await execFileAsync(PDFINFO, [inputPath], { timeout: 30000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    if (m) pages = Number(m[1]);
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
  return { pages, textChars, isImageBased: perPage < MIN_CHARS_PER_PAGE };
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
  return { htmlPath, textPages, imagePages };
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
  return { outputPath, heuristicsSkipped };
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
  let pageStats = null;
  if (opts.ocr && info.isImageBased) {
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
      method: ocrApplied ? "reflowable-ocr" : "reflowable",
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
      method: ocrApplied ? "reflowable-ocr" : "reflowable",
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
