const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileCard = document.getElementById("fileCard");
const fcName = document.getElementById("fcName");
const fcSize = document.getElementById("fcSize");
const fcRemove = document.getElementById("fcRemove");
const convertBtn = document.getElementById("convertBtn");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const spinner = document.getElementById("spinner");
const limitNote = document.getElementById("limitNote");
const engineEl = document.getElementById("engine");

let selectedFile = null;

// ---- Light / dark, remembered between visits ----
const themeBtn = document.getElementById("themeBtn");
const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
themeBtn.addEventListener("click", () => {
  const current =
    document.documentElement.dataset.theme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// Learn the server's real limits / engine status on load.
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (!h) return;
    if (!h.ocr) {
      // Don't offer OCR the server can't perform.
      const box = document.getElementById("ocr");
      box.checked = false;
      box.disabled = true;
      box.closest("label").classList.add("disabled");
      box.closest("label").title = "OCR is not installed on this server.";
    }
    if (!h.calibre && !h.poppler) {
      engineEl.textContent = "⚠️ Conversion engine offline";
    } else if (!h.poppler) {
      engineEl.textContent = "Powered by Calibre (scanned-PDF mode unavailable)";
    } else if (!h.calibre) {
      engineEl.textContent = "Fixed-layout mode only (Calibre unavailable)";
    }
  })
  .catch(() => {});

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showStatus("Please choose a PDF file.", "error");
    return;
  }
  selectedFile = file;
  fcName.textContent = file.name;
  fcSize.textContent = fmtSize(file.size);
  fileCard.classList.remove("hidden");
  convertBtn.disabled = false;
  hideStatus();
}

function clearFile() {
  selectedFile = null;
  fileInput.value = "";
  fileCard.classList.add("hidden");
  convertBtn.disabled = true;
}

function showStatus(msg, kind) {
  statusEl.classList.remove("hidden", "error", "success");
  if (kind) statusEl.classList.add(kind);
  spinner.style.display = kind ? "none" : "block";
  statusText.textContent = msg;
}
function hideStatus() {
  statusEl.classList.add("hidden");
  setProgress(null);
}

// fraction 0–1 shows the bar; null hides it (we only show real progress)
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
function setProgress(fraction) {
  if (fraction == null) {
    progressEl.classList.add("hidden");
    return;
  }
  progressEl.classList.remove("hidden");
  progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

// ---- Dropzone events ----
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", (e) => setFile(e.target.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  setFile(file);
});

fcRemove.addEventListener("click", clearFile);

// ---- Conversion mode: segmented buttons, each explaining what it does ----
const MODE_HINTS = {
  auto: "<strong>Auto</strong> checks the PDF first. If it holds real text you get an adjustable, reflowable book; if it's a scan, it falls back to page images — so a file never fails to convert.",
  reflowable:
    "<strong>Reflowable</strong> lets the text reflow to fit the screen, so you can change font size, typeface and margins on your reader. Best for ordinary text PDFs — a scan has no text to reflow.",
  fixed:
    "<strong>Fixed layout</strong> turns every page into an image that looks exactly like the PDF. It always works, scans included — but the text is a picture, so its size can't be changed.",
};

const modeInput = document.getElementById("mode");
const modeHint = document.getElementById("modeHint");
const segButtons = Array.from(document.querySelectorAll(".seg"));

function setMode(mode) {
  modeInput.value = mode;
  modeHint.innerHTML = MODE_HINTS[mode];
  segButtons.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

segButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
setMode(modeInput.value);

// Only show the language picker once OCR is actually switched on.
const ocrBox = document.getElementById("ocr");
const ocrLangRow = document.getElementById("ocrLangRow");
ocrBox.addEventListener("change", () => {
  ocrLangRow.classList.toggle("hidden", !ocrBox.checked);
});

// ---- Convert ----
convertBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  const form = new FormData();
  form.append("file", selectedFile);
  form.append("title", document.getElementById("title").value);
  form.append("author", document.getElementById("author").value);
  form.append("profile", document.getElementById("profile").value);
  form.append("heuristics", document.getElementById("heuristics").checked);
  form.append("mode", document.getElementById("mode").value);
  form.append("ocr", document.getElementById("ocr").checked);
  form.append("ocrLang", document.getElementById("ocrLang").value);

  convertBtn.disabled = true;
  setProgress(null);
  resetSteps(); // a second conversion must not inherit the first one's ticks
  showStatus("Uploading…", null);

  try {
    // The server queues the job and answers straight away — a long OCR run can't
    // rely on the browser keeping a request open for tens of minutes.
    const res = await fetch("/api/convert", { method: "POST", body: form });
    if (!res.ok) {
      let msg = "Conversion failed.";
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch {}
      return fail(msg);
    }
    const { jobId } = await res.json();
    await followJob(jobId);
  } catch (err) {
    fail("Network error. Is the server running?");
  }
});

function fail(msg) {
  setProgress(null);
  showStatus(msg, "error");
  convertBtn.disabled = false;
}

// The pipeline, in the order stages actually occur. Not every book visits every
// step — a text PDF never runs OCR — so steps are only shown once reached, and
// anything skipped over is marked as such instead of silently vanishing.
const STEPS = [
  { key: "analyzing", label: "Examining the PDF" },
  { key: "ocr", label: "Reading scanned pages", counts: true },
  { key: "building", label: "Assembling the pages", counts: true },
  { key: "rendering", label: "Rendering pages", counts: true },
  { key: "packaging", label: "Packaging the book", counts: true },
  { key: "converting", label: "Building the EPUB" },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.key, i]));

const stepList = document.getElementById("stepList");

function resetSteps() {
  stepList.innerHTML = "";
  stepList.classList.add("hidden");
}

function renderSteps(job) {
  const current = STEP_INDEX[job.stage];
  if (current == null) return; // queued, or a stage with no step of its own
  // Which stages ran is the server's to say — see the note on `stages` there.
  const visited = new Set(job.stages || []);

  stepList.classList.remove("hidden");
  // Only steps this book actually went through. Listing the ones it didn't would
  // be noise, and misleading besides: rendering/packaging aren't skipped steps,
  // they're the other branch — a book takes the reflowable path or the
  // page-image path, never both.
  stepList.innerHTML = STEPS.filter((s) => visited.has(s.key))
    .map((step) => {
      const active = STEP_INDEX[step.key] === current;
      let detail = "";
      if (active) {
        if (step.counts && job.pages > 0 && job.page > 0) {
          detail = `${job.page} / ${job.pages}`;
        } else if (job.detail) {
          detail = job.detail;
        }
      }
      return `<li class="step is-${active ? "active" : "done"}">
        <span class="step-mark">${active ? "▸" : "✓"}</span>
        <span class="step-label">${step.label}</span>
        <span class="step-detail">${detail}</span>
      </li>`;
    })
    .join("");
}

async function followJob(jobId) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));

    let job;
    try {
      const r = await fetch(`/api/jobs/${jobId}`);
      if (!r.ok) return fail("The conversion job expired. Please try again.");
      job = await r.json();
    } catch {
      return fail("Lost contact with the server.");
    }

    if (job.status === "error") return fail(job.error || "Conversion failed.");

    if (job.status === "done") {
      setProgress(null);
      return downloadResult(jobId);
    }

    renderSteps(job);

    // The bar only moves on figures the server actually measured — page counts,
    // or Calibre's own percentage. No stage gets a fabricated percentage; if
    // there's nothing real to show, the bar hides rather than guessing.
    if (job.pages > 0 && job.page > 0) {
      setProgress(job.page / job.pages);
    } else if (job.percent > 0) {
      setProgress(job.percent / 100);
    } else {
      setProgress(null);
    }

    const queued = job.status === "queued" && job.queueDepth > 1;
    showStatus(queued ? "Waiting for a free slot…" : "Converting…", null);
  }
}

async function downloadResult(jobId) {
  showStatus("Fetching your book…", null);
  const res = await fetch(`/api/jobs/${jobId}/file`);
  if (!res.ok) return fail("Could not download the finished book.");

  const method = res.headers.get("X-Convert-Method");
  const slow = res.headers.get("X-Heuristics-Skipped") === "1";
  const imagePages = Number(res.headers.get("X-Image-Pages") || 0);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = selectedFile.name.replace(/\.pdf$/i, "") + ".epub";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const note =
    method === "reflowable-ocr"
      ? " Text recognised with OCR — font size is adjustable on your reader."
      : method === "reflowable"
      ? " Reflowable — you can adjust font size on your reader."
      : method === "fixed"
      ? " Fixed layout (scanned PDF) — font size can't be adjusted."
      : method === "fixed-fallback"
      ? " Fixed layout — text extraction wasn't possible, so font size is locked."
      : "";
  const pageNote = imagePages
    ? ` ${imagePages} page${imagePages > 1 ? "s" : ""} couldn't be read and ${
        imagePages > 1 ? "were" : "was"
      } kept as ${imagePages > 1 ? "images" : "an image"}.`
    : "";
  const slowNote = slow
    ? " (Chapter detection was skipped to finish this large book in time.)"
    : "";

  showStatus("✓ Done! Your EPUB has been downloaded." + note + pageNote + slowNote, "success");
  convertBtn.disabled = false;
}
