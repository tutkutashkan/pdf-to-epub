# PDF → EPUB converter: Node backend + Calibre, poppler and OCR engines.
FROM node:20-slim

# Calibre is installed from upstream rather than apt: Debian stable ships 6.x,
# which flattens the heading hierarchy (every size collapses to 1em) so headings
# are no larger than body text. Pinned rather than "latest" so a rebuild months
# from now produces the same book, and fetched as a signed-by-HTTPS tarball
# rather than piping the install script into a shell.
ARG CALIBRE_VERSION=9.12.0
ARG TARGETARCH

# poppler-utils → pdftoppm/pdfinfo/pdftotext (page images, metadata, text detection)
# ocrmypdf + tesseract → optional OCR for scanned books, one pack per offered language
# xz-utils/wget      → unpacking the Calibre tarball
# lib*              → what Calibre's bundled Qt needs to run headless
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      ocrmypdf \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-tur \
      tesseract-ocr-deu \
      tesseract-ocr-fra \
      tesseract-ocr-spa \
      tesseract-ocr-ita \
      tesseract-ocr-por \
      tesseract-ocr-nld \
      xz-utils \
      wget \
      ca-certificates \
      fonts-liberation \
      libegl1 \
      libopengl0 \
      libgl1 \
      libxcb-cursor0 \
      libxcb-xinerama0 \
      libxkbcommon0 \
      libxkbcommon-x11-0 \
      libfontconfig1 \
      libfreetype6 \
      libdbus-1-3 \
      libglib2.0-0 \
      libxrender1 \
      libxi6 \
      libsm6 \
      libice6 \
      libnss3 \
      libxdamage1 \
      libxcomposite1 \
      libxrandr2 \
      libxtst6 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

# TARGETARCH is supplied by BuildKit; uname is the fallback for a plain builder.
RUN set -eux; \
    case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64)  cal_arch=x86_64 ;; \
      arm64|aarch64) cal_arch=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac; \
    wget -nv -O /tmp/calibre.txz \
      "https://download.calibre-ebook.com/${CALIBRE_VERSION}/calibre-${CALIBRE_VERSION}-${cal_arch}.txz"; \
    mkdir -p /opt/calibre; \
    tar xJof /tmp/calibre.txz -C /opt/calibre; \
    rm /tmp/calibre.txz

ENV PATH="/opt/calibre:${PATH}"

# Fail the build here rather than at runtime if a Qt library is missing.
RUN ebook-convert --version && pdftoppm -v && ocrmypdf --version

WORKDIR /app

# Install node deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source. Keep this list in step with the modules server.js imports.
COPY server.js converters.js ./
COPY public ./public

# Non-root user for safety.
RUN useradd -m appuser && mkdir -p /tmp/pdf2epub && chown -R appuser /tmp/pdf2epub
USER appuser

ENV PORT=3000 \
    WORK_DIR=/tmp/pdf2epub \
    MAX_FILE_MB=50 \
    CONCURRENCY=2

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
