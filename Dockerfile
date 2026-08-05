# PDF → EPUB converter: Node backend + Calibre's ebook-convert engine.
FROM node:20-slim

# Install Calibre (provides `ebook-convert`) plus the runtime libs it needs headless.
# calibre pulls a lot of deps; --no-install-recommends keeps the image smaller.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre \
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
      libegl1 \
      libopengl0 \
      libxcb-cursor0 \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

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
