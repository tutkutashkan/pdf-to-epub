# 📖 PDF → EPUB Converter

A small website that converts PDF files into **EPUB** files for Kindle and other
e-readers, behind a simple drag-and-drop web UI.

It uses **two conversion strategies** and picks the right one automatically, so it
converts *any* PDF without failing:

1. **Reflowable** (text PDFs) — [Calibre](https://calibre-ebook.com/)'s
   `ebook-convert` produces a normal EPUB with resizable text.
2. **Fixed-layout** (scanned / image-only PDFs) — each page is rasterized to an
   image with [poppler](https://poppler.freedesktop.org/)'s `pdftoppm` and wrapped
   in a spec-compliant EPUB 3 pre-paginated book. Text isn't resizable (it's a
   picture of the page), but conversion never fails and looks pixel-perfect.

**Auto mode** (the default) detects whether the PDF has real selectable text: text
PDFs go through Calibre; scanned PDFs go straight to fixed-layout. If a text PDF
fails in Calibre, it automatically falls back to fixed-layout so the user always
gets a file. Users can also force either mode from the UI.

- **Backend:** Node.js + Express (`server.js` + `converters.js`)
- **Frontend:** static HTML/CSS/JS (drag-drop, options, progress)
- **Packaging:** Docker, so it runs identically on your Mac and on a $5 server
- **Safety:** file-size limit, per-IP rate limit, conversion queue, auto-delete of
  uploaded files after each conversion

---

## Run it (Docker — recommended)

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed. On a Mac:

```bash
brew install --cask docker
```

Then, from this folder:

```bash
docker compose up --build
```

Open **http://localhost:3000**. The first build takes a while — it installs Calibre,
poppler, OCRmyPDF and the Tesseract language packs, giving a ~1.6 GB image. After
that, startups are fast.

Note the container binds port 3000, so stop any local `npm start` first or the bind
fails with "address already in use".

Stop it with `Ctrl+C`, or run detached with `docker compose up -d`.

---

## Run it without Docker (for quick local dev)

Requires **Node 20+**. Install the conversion engines you want to use:

```bash
brew install --cask calibre   # reflowable text conversion (`ebook-convert`)
brew install poppler          # fixed-layout / scanned-PDF conversion (`pdftoppm`)
brew install ocrmypdf tesseract-lang   # optional: OCR for scanned PDFs
npm install
npm start
```

You can install just one — the app reports which modes are available on
`/api/health`, and the UI adjusts. (With only poppler, every PDF converts as
fixed-layout; with only Calibre, scanned-PDF mode is unavailable.)

Open **http://localhost:3000**.

---

## Smoke test

`test/smoke.sh` runs the whole conversion matrix against a running instance — engine
availability, language packs, all three modes, per-page OCR fallback, that the
finished EPUB really contains the recognised text and the fallback page images, and
that collecting a book frees its disk.

```bash
docker compose up -d
CTR=pdf2epub test/smoke.sh http://localhost:3000
```

`CTR` is the container name (used for the checks that look inside it). Run it after
changing the Dockerfile or upgrading Calibre — it catches the failures that are
otherwise silent, like images going missing from the book.

GitHub Actions runs exactly this on every push (`.github/workflows/ci.yml`). That
matters beyond convenience: the runners are **x86_64**, so CI is the only place the
amd64 image is exercised — building on an Apple Silicon Mac produces arm64 and
would not catch an amd64-only break, which is what a typical VPS would hit.

## Why Calibre comes from upstream, not apt

Debian stable ships **Calibre 6.x**, and it produces a noticeably worse book:
converting the same PDF, Calibre 9 emits five distinct heading sizes
(`0.75em` … `1.67em`) while Calibre 6 collapses everything to `1em`, so headings
are no larger than body text. Everything else held on 6.x — relative font sizes,
no leaked `font-family`, working covers — but flat headings are a real
regression in a book.

So the image installs a **pinned** Calibre (`CALIBRE_VERSION`, currently 9.12.0)
as the official tarball for the build's architecture. Pinned rather than "latest"
so a rebuild months from now still produces the same book, and fetched as a
tarball over HTTPS rather than piping the install script into a shell. The build
then runs `ebook-convert --version` so a missing Qt library fails the build
instead of every conversion at runtime.

Override the version at build time if needed:

```bash
docker build --build-arg CALIBRE_VERSION=9.12.0 -t pdf-to-epub .
```

CI asserts the running Calibre is 9.x, so a silent fall back to apt's 6.x can't
slip through unnoticed.

## Configuration

All settings are environment variables (set them in `docker-compose.yml` or your
shell):

| Variable             | Default        | Meaning                                        |
| -------------------- | -------------- | ---------------------------------------------- |
| `PORT`               | `3000`         | Port the server listens on                     |
| `MAX_FILE_MB`        | `50`           | Largest PDF accepted                           |
| `CONCURRENCY`        | `2`            | How many conversions run at once               |
| `CONVERT_TIMEOUT_MS` | `1200000`      | Kill a conversion after this long (20 min)     |
| `EBOOK_CONVERT`      | `ebook-convert`| Path to the Calibre binary                     |
| `PDFTOPPM`           | `pdftoppm`     | Path to the poppler rasterizer                 |
| `OCRMYPDF`           | `ocrmypdf`     | Path to the OCR binary                         |
| `OCR_TIMEOUT_MS`     | `1200000`      | Kill an OCR run after this long (20 min)       |
| `OCR_JOBS`           | `2`            | OCR's internal CPU parallelism per job         |
| `RASTER_DPI`         | `150`          | Resolution for fixed-layout page images        |
| `WORK_DIR`           | OS temp dir    | Where uploads/outputs are staged (then deleted)|
| `JOB_TTL_MS`         | `1800000`      | Delete abandoned jobs after this long (30 min) |

---

## Deploying to a real server

Because Calibre is a large desktop app, this needs a container host or VPS — not a
static/serverless free tier. Cheap options that work well:

- **Hetzner Cloud** CX22 (2 vCPU / 4 GB) — ~$5/mo, best value
- **Fly.io** — Docker-native, scales to zero when idle
- **DigitalOcean / Railway / Render** — easy `git push` deploys

### Full deploy with automatic HTTPS (recommended)

The repo includes a production stack — the app behind **Caddy**, which fetches and
auto-renews a free Let's Encrypt certificate for you. No manual cert wrangling.

**1. Point your domain at the server.** Create a DNS `A` record (and `AAAA` if you
have IPv6) for e.g. `pdf2epub.yourdomain.com` → your server's IP. Do this *first* —
Caddy needs it resolving before it can get a certificate.

**2. On the server**, install Docker, clone/copy this folder, then:

```bash
cp .env.example .env
# edit .env: set SITE_DOMAIN to your domain and ADMIN_EMAIL to your email
docker compose -f docker-compose.prod.yml up -d --build
```

That's it. Caddy grabs the certificate on first boot and serves your site at
`https://your-domain` with HTTP→HTTPS redirect, HTTP/3, gzip, and security headers
already configured in the [`Caddyfile`](Caddyfile). The app itself is **not**
exposed to the internet directly — only Caddy talks to it.

Check logs / status with:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

The app already sets `trust proxy`, so per-IP rate limiting sees real client IPs
through Caddy.

### Local dev without HTTPS

For just running it locally, use the plain compose file (no Caddy, no domain):

```bash
docker compose up --build   # → http://localhost:3000
```

### Production tips

- Keep `MAX_FILE_MB` conservative (large PDFs = high RAM).
- Raise `CONCURRENCY` only if the box has the CPU/RAM headroom.
- The container runs as a non-root user and deletes files after each job.
- Consider adding a CDN / Cloudflare in front for basic abuse protection.

---

## Jobs and progress

Conversions run as **background jobs**, so a long OCR run never depends on the
browser holding a request open for tens of minutes:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/convert` | Accepts the upload, queues the job, returns `202 {jobId}` immediately |
| `GET /api/jobs/:id` | Status and progress — polled about once a second |
| `GET /api/jobs/:id/file` | Streams the finished EPUB, then deletes the job's files |

Progress is only ever reported where it can be measured honestly: OCR logs the
page it has reached, so the UI shows "Reading scanned pages — 47 of 300" with a
real progress bar. Other stages show a plain label (Examining the PDF / Assembling
the pages / Building the EPUB) rather than an invented percentage.

Jobs are held in memory and swept after `JOB_TTL_MS` (default 30 min), so a user
who closes the tab mid-conversion doesn't leave files behind. A restart loses
in-flight jobs — acceptable for a stateless converter; anything stronger would
need Redis and a separate worker.

## How conversion works

1. Browser uploads the PDF to `POST /api/convert` (multipart form).
2. Server saves it to a per-job temp dir and enqueues the job.
3. The orchestrator in `converters.js` picks a strategy:
   - **Reflowable:** `ebook-convert input.pdf output.epub --output-profile <profile> [--enable-heuristics] [--title …] [--authors …]`
   - **Fixed-layout:** `pdftoppm -jpeg -r <dpi> input.pdf page-N.jpg`, then each
     page image is wrapped in an EPUB 3 pre-paginated XHTML page and zipped.
   - **Auto:** measures text density (`pdftotext` + `pdfinfo`) to choose, and
     falls back from reflowable to fixed-layout if Calibre errors.
4. The finished `.epub` is streamed back (with an `X-Convert-Method` header saying
   which strategy ran).
5. The temp dir is deleted.

## Reader-controlled typography

Reflowable EPUBs are produced so the **e-reader**, not the PDF, controls how text
looks — you can change font size, typeface, and margins on your Kindle:

- Font sizes are emitted as relative `em` units, so they scale with the reader's
  font-size setting while keeping headings proportionally larger.
- `font-family` is stripped from the CSS so the reader's own font choice wins, and
  no fonts are embedded.
- Text/background colours are stripped so the device theme applies (this is also
  what prevents "black pages with white text" from PDFs that style pages darkly).
- Page margins are zeroed so the Kindle's own margin setting governs.

Pass `keepColors: true` / `keepFonts: true` in the convert options to opt out.

**Fixed-layout books are the exception:** their pages are images, so font size and
typeface cannot be changed on any reader. That's inherent to the format — unless
you turn on OCR, below.

## OCR for scanned PDFs (opt-in)

A scanned book has no text to reflow, so it normally converts as fixed-layout with
a locked font size. Ticking **"Read text from scanned pages (OCR)"** runs
[OCRmyPDF](https://ocrmypdf.readthedocs.io/) first, which recognises the words on
each page and adds a real text layer. The book then converts as a **reflowable**
EPUB, so font size, typeface, and margins all become adjustable.

Worth knowing before enabling it:

- **It's slow.** OCR is by far the heaviest step — expect minutes, not seconds, on
  a full book. The UI warns the user and the request timeout is raised to match.
- **It's only applied when needed.** PDFs that already contain text skip OCR
  entirely, so no time is wasted.
- **It self-checks.** If OCR comes back with little or no usable text (a poor
  scan), the app discards it and falls back to fixed-layout rather than producing a
  blank book.
- **Recognition isn't perfect.** Expect occasional wrong characters, and messy
  results from complex tables or multi-column layouts.
- **Judged page by page.** OCR quality varies across a book — a fold, a photo or a
  bad scan can leave one page unreadable in a book that is otherwise fine. Each
  page is checked on its own: recognised pages become real text, and pages OCR
  could not read keep their scanned image, so nothing is silently lost. The
  response reports `X-Text-Pages` / `X-Image-Pages` and the UI says how many pages
  were kept as images.
- **Recognised pages are text-only.** Photographs and diagrams sitting on a page
  that OCR *could* read are not carried over — only its text is. Convert without
  OCR if preserving every visual matters more than adjustable type.
- **Languages:** pick the language in the UI. Each needs its tesseract data pack;
  the Docker image ships English, Turkish, German, French, Spanish, Italian,
  Portuguese, and Dutch. Add more with `tesseract-ocr-<lang>` in the Dockerfile.

Tune it with `OCR_TIMEOUT_MS`, `OCR_JOBS` (CPU parallelism per job), and
`OCRMYPDF` (binary path).

## Long books and timeouts

Full-length books take minutes, not seconds, and Calibre's `--enable-heuristics`
(chapter detection and layout clean-up) roughly **doubles** conversion time — it is
the usual reason a long book exceeds its budget.

Rather than failing, a conversion that times out with heuristics on is
**automatically retried without them**. The book still comes out reflowable and
resizable, just less tidily structured; the response carries
`X-Heuristics-Skipped: 1` and the UI says so. If even that times out, the user gets
a clear message (HTTP 504) suggesting Fixed layout, which is far faster.

Raise `CONVERT_TIMEOUT_MS` if you routinely convert very large books on slow
hardware.

## Notes & limitations

- **Reflowable** EPUBs (text PDFs) reflow and resize like a normal ebook.
- **Fixed-layout** EPUBs (scanned/image PDFs) are pages-as-images: they always
  convert and look identical to the original, but the reader can't resize the text
  and file sizes are larger. Lower `RASTER_DPI` for smaller files, raise it for
  sharper pages.
- **Scanned PDFs still have no selectable text** — fixed-layout preserves their
  appearance but you can't search/select. Adding OCR (e.g. `ocrmypdf`) before
  conversion would make scanned books searchable — a good future add-on.
- This is a stateless converter: it never stores or shares user files.
