#!/bin/bash
# Full conversion suite run against the containerised app.
# Usage: container_test.sh <base-url>
BASE="${1:-http://localhost:3100}"
SP="$(cd "$(dirname "$0")" && pwd)"
pass=0; fail=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail+1)); }

echo "=== 1. health / engines present ==="
H=$(curl -s "$BASE/api/health")
echo "  $H"
for eng in calibre poppler ocr; do
  echo "$H" | grep -q "\"$eng\":true" && ok "$eng available" || bad "$eng MISSING"
done

echo "=== 2. tesseract language packs ==="
LANGS=$(docker exec ${CTR:-pdf2epub-test} tesseract --list-langs 2>/dev/null | tail -n +2 | tr '\n' ' ')
echo "  installed: $LANGS"
for l in eng tur deu fra spa ita por nld; do
  echo "$LANGS" | grep -qw "$l" && ok "lang $l" || bad "lang $l MISSING"
done

# submit a job, wait, return "method|textPages|imagePages"
run_job() {
  local file="$1" mode="$2" ocr="$3"
  local J
  J=$(curl -s -X POST -F "file=@$file" -F "mode=$mode" -F "ocr=$ocr" "$BASE/api/convert" \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null)
  [ -z "$J" ] && { echo "NOJOB||"; return; }
  for i in $(seq 1 300); do
    S=$(curl -s "$BASE/api/jobs/$J")
    echo "$S" | grep -q '"status":"done"\|"status":"error"' && break
    sleep 1
  done
  # run_job is called via $( ), i.e. a subshell — a plain variable would not
  # survive, so hand the id back through a file.
  echo "$J" > "$SP/.last_job"
  echo "$S" | python3 -c "
import sys,json;j=json.load(sys.stdin)
print(f\"{j.get('method') or 'ERROR'}|{j.get('textPages','')}|{j.get('imagePages','')}\")" 2>/dev/null
}

echo "=== 3. text PDF -> reflowable ==="
R=$(run_job "$SP/gatsby.pdf" auto false); echo "  $R"
[ "${R%%|*}" = "reflowable" ] && ok "text PDF reflows" || bad "expected reflowable, got ${R%%|*}"

echo "=== 4. scanned PDF, no OCR -> fixed ==="
R=$(run_job "$SP/scanned.pdf" auto false); echo "  $R"
[ "${R%%|*}" = "fixed" ] && ok "scan falls back to fixed" || bad "expected fixed, got ${R%%|*}"

echo "=== 5. scanned PDF + OCR -> reflowable-ocr ==="
R=$(run_job "$SP/scanned.pdf" auto true); echo "  $R"
[ "${R%%|*}" = "reflowable-ocr" ] && ok "OCR makes scan reflowable" || bad "expected reflowable-ocr, got ${R%%|*}"

echo "=== 6. mixed scan: per-page fallback ==="
R=$(run_job "$SP/mixed11.pdf" auto true); echo "  $R"
M="${R%%|*}"; TP=$(echo "$R" | cut -d'|' -f2); IP=$(echo "$R" | cut -d'|' -f3)
[ "$M" = "reflowable-ocr" ] && ok "method reflowable-ocr" || bad "method was $M"
[ "$TP" = "8" ] && ok "8 pages kept as text" || bad "textPages=$TP (want 8)"
[ "$IP" = "3" ] && ok "3 unreadable pages kept as images" || bad "imagePages=$IP (want 3)"

echo "=== 7. downloaded EPUB really contains those images ==="
LAST_JOB=$(cat "$SP/.last_job")
curl -s -o "$SP/ctest.epub" "$BASE/api/jobs/$LAST_JOB/file"
file -b "$SP/ctest.epub" | grep -q EPUB && ok "valid EPUB" || bad "not an EPUB"
N=$(unzip -l "$SP/ctest.epub" 2>/dev/null | grep -cE 'p[0-9]+\.jpg')
[ "$N" = "3" ] && ok "3 page images embedded (symlink bug absent)" || bad "found $N page images (want 3)"
unzip -p "$SP/ctest.epub" index.html 2>/dev/null | grep -q "younger and more vulnerable" \
  && ok "recognised text present" || bad "OCR text missing from book"

echo "=== 8. collecting a book frees its disk ==="
# Finished-but-uncollected jobs legitimately keep their files until the TTL sweep,
# so the meaningful check is that a *collected* job is cleaned up immediately.
count_dirs() { docker exec ${CTR:-pdf2epub-test} sh -c 'ls /tmp/pdf2epub 2>/dev/null | wc -l' | tr -d ' '; }
BEFORE=$(count_dirs)
J8=$(curl -s -X POST -F "file=@$SP/gatsby.pdf" -F "mode=auto" "$BASE/api/convert" \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
for i in $(seq 1 120); do curl -s "$BASE/api/jobs/$J8" | grep -q '"status":"done"' && break; sleep 1; done
DURING=$(count_dirs)
[ "$DURING" = "$((BEFORE+1))" ] && ok "job staged on disk ($BEFORE→$DURING)" || bad "expected $((BEFORE+1)) dirs, saw $DURING"
curl -s -o /dev/null "$BASE/api/jobs/$J8/file"; sleep 1
AFTER=$(count_dirs)
[ "$AFTER" = "$BEFORE" ] && ok "files deleted on collection ($DURING→$AFTER)" || bad "leak: $AFTER dirs remain"
curl -s "$BASE/api/jobs/$J8" | grep -q "expired" && ok "job forgotten after collection" || bad "job still tracked"

echo
echo "=============================="
printf "  passed: %s   failed: %s\n" "$pass" "$fail"
echo "=============================="
[ "$fail" = "0" ]
