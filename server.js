import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { convert, capabilities, OCR_LANGUAGES } from "./converters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config (env-overridable so the same image works locally and in prod) ----
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 50;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 2;
// Full-length books legitimately take many minutes; a tight budget kills them.
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS) || 20 * 60 * 1000;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 20 * 60 * 1000;
const WORK_DIR_RAW = process.env.WORK_DIR || path.join(os.tmpdir(), "pdf2epub");
await fs.mkdir(WORK_DIR_RAW, { recursive: true });

// Canonicalise the work directory before anything writes to it. On macOS
// os.tmpdir() returns /var/... which is a symlink to /private/var/..., and
// Calibre fails to resolve a document's relative image links through a symlinked
// path — it drops the images from the finished book without reporting an error.
// Resolving once here keeps every job path real. (No-op where nothing is linked.)
const WORK_DIR = await fs.realpath(WORK_DIR_RAW);

// ---- Tiny concurrency-limited queue ----
// Keeps the box from being overwhelmed: only CONCURRENCY conversions run at once,
// the rest wait their turn instead of all spiking CPU/RAM simultaneously.
class Queue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }
  get depth() {
    return this.running + this.pending.length;
  }
  add(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#drain();
    });
  }
  #drain() {
    if (this.running >= this.concurrency) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running++;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running--;
        this.#drain();
      });
  }
}
const queue = new Queue(CONCURRENCY);

// ---- Job store ----
// In-memory on purpose: a converted book is disposable, and a restart losing an
// in-flight job is fine. Anything longer-lived would need Redis and a worker.
const jobs = new Map();
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS) || 30 * 60 * 1000;

// No job survives a restart, so anything already in the work directory at startup
// is orphaned — left by a previous process that exited before its files were
// collected. Nothing else will ever clean these up, so clear them now.
for (const entry of await fs.readdir(WORK_DIR).catch(() => [])) {
  await fs.rm(path.join(WORK_DIR, entry), { recursive: true, force: true }).catch(() => {});
}

// A user who closes the tab mid-conversion would otherwise leave the upload and
// finished EPUB on disk forever, so sweep anything untouched past its TTL.
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const last = job.finishedAt || job.createdAt;
    if (last < cutoff) {
      jobs.delete(id);
      fs.rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

// ---- Upload handling ----
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const jobDir = path.join(WORK_DIR, randomUUID());
    await fs.mkdir(jobDir, { recursive: true });
    req.jobDir = jobDir;
    cb(null, jobDir);
  },
  filename: (req, file, cb) => cb(null, "input.pdf"),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) return cb(new Error("Only PDF files are accepted."));
    cb(null, true);
  },
});

// ---- App ----
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // correct client IPs behind a reverse proxy / load balancer

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 conversions per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many conversions from this IP. Please try again later." },
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (req, res) => {
  const caps = await capabilities();
  res.json({ ok: true, ...caps, queueDepth: queue.depth });
});

app.post("/api/convert", limiter, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    const jobDir = req.jobDir;
    const cleanup = async () => {
      if (jobDir) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    };

    if (err) {
      await cleanup();
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? `File too large. Maximum size is ${MAX_FILE_MB} MB.`
          : err.message || "Upload failed.";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      await cleanup();
      return res.status(400).json({ error: "No PDF file was uploaded." });
    }

    const inputPath = path.join(jobDir, "input.pdf");
    const outputPath = path.join(jobDir, "output.epub");

    // Options from the form (all passed as an arg array — never shell-interpolated).
    const opts = {
      title: (req.body.title || "").toString().slice(0, 300).trim(),
      author: (req.body.author || "").toString().slice(0, 300).trim(),
      heuristics: req.body.heuristics !== "false", // default on
      profile: ["tablet", "kindle_pw3", "kindle_oasis", "generic_eink"].includes(req.body.profile)
        ? req.body.profile
        : "tablet",
      mode: ["auto", "reflowable", "fixed"].includes(req.body.mode) ? req.body.mode : "auto",
      // Opt-in OCR for scanned PDFs (slow) — only honoured when the PDF has no text.
      ocr: req.body.ocr === "true",
      ocrLang: OCR_LANGUAGES.includes(req.body.ocrLang) ? req.body.ocrLang : "eng",
      ocrTimeoutMs: OCR_TIMEOUT_MS,
      // Used as the title if neither the form nor the PDF's metadata supplies one.
      fallbackTitle: (req.file.originalname || "")
        .replace(/\.pdf$/i, "")
        .replace(/[_-]+/g, " ")
        .trim()
        .slice(0, 300),
      timeoutMs: CONVERT_TIMEOUT_MS,
    };

    // Register the job and answer immediately. A long OCR run must not depend on
    // the browser holding a request open for tens of minutes.
    const base = (req.file.originalname || "book").replace(/\.pdf$/i, "");
    const job = {
      id: path.basename(jobDir),
      status: "queued", // queued → running → done | error
      // analyzing | ocr | building | rendering | packaging | converting
      stage: "queued",
      // Every stage this job has actually entered, in order. The browser polls
      // once a second and short stages finish in between, so it cannot infer
      // this from what it happened to observe — it would report a stage that
      // ran quickly as one that never ran.
      stages: [],
      page: 0,
      pages: 0,
      percent: 0,
      detail: "",
      filename: (base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "book") + ".epub",
      jobDir,
      outputPath,
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id });

    opts.onProgress = (patch) => {
      if (job.status === "error") return;
      // Each stage reports its own counters; clear the previous stage's so a
      // stale "page 300 of 300" can't linger into a stage that has no pages.
      if (patch.stage && patch.stage !== job.stage) {
        job.page = 0;
        job.pages = 0;
        job.percent = 0;
        job.detail = "";
        if (!job.stages.includes(patch.stage)) job.stages.push(patch.stage);
      }
      Object.assign(job, patch);
    };

    queue
      .add(() => {
        job.status = "running";
        return convert(inputPath, outputPath, jobDir, opts);
      })
      .then((result) => {
        job.status = "done";
        job.stage = "done";
        job.method = result.method;
        job.heuristicsSkipped = !!result.heuristicsSkipped;
        if (result.textPages != null) job.textPages = result.textPages;
        if (result.imagePages != null) job.imagePages = result.imagePages;
        job.finishedAt = Date.now();
      })
      .catch(async (e) => {
        const missing = e.code === "ENOENT";
        console.error(
          `Conversion failed [${req.file.originalname}] mode=${opts.mode} ocr=${opts.ocr}:`,
          e.message
        );
        job.status = "error";
        job.stage = "error";
        job.finishedAt = Date.now();
        job.error = missing
          ? "A required conversion tool is not installed on the server."
          : e.isTimeout
          ? "This PDF took too long to convert — it may be very large. Try Fixed layout, which is much faster."
          : "Conversion failed. The PDF may be corrupt, encrypted, or unsupported.";
        await cleanup();
      });
  });
});

// Progress polling. Deliberately small — the browser hits this every second.
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown or expired job." });
  res.json({
    status: job.status,
    stage: job.stage,
    stages: job.stages,
    page: job.page,
    pages: job.pages,
    percent: job.percent,
    detail: job.detail,
    method: job.method,
    heuristicsSkipped: job.heuristicsSkipped,
    textPages: job.textPages,
    imagePages: job.imagePages,
    error: job.error,
    queueDepth: queue.depth,
  });
});

// Collect the finished book, then delete everything belonging to the job.
app.get("/api/jobs/:id/file", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown or expired job." });
  if (job.status !== "done") return res.status(409).json({ error: "Not finished yet." });

  res.setHeader("X-Convert-Method", job.method || "");
  if (job.heuristicsSkipped) res.setHeader("X-Heuristics-Skipped", "1");
  if (job.imagePages) res.setHeader("X-Image-Pages", String(job.imagePages));
  if (job.textPages) res.setHeader("X-Text-Pages", String(job.textPages));

  res.download(job.outputPath, job.filename, async () => {
    await fs.rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(job.id);
  });
});

const server = app.listen(PORT, () => {
  console.log(`PDF→EPUB server listening on http://localhost:${PORT}`);
  console.log(`  max file size: ${MAX_FILE_MB} MB | concurrency: ${CONCURRENCY}`);
});

// A queued OCR job can hold the request open far longer than Node's 5-minute
// default, which would otherwise abort the upload mid-conversion.
server.requestTimeout = OCR_TIMEOUT_MS + 5 * 60 * 1000;
server.headersTimeout = server.requestTimeout + 10_000;
