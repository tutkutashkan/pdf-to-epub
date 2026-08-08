#!/bin/bash
# Conversion suite for a *deployed* instance, over HTTP only.
#
# test/smoke.sh inspects the container with `docker exec`, which a managed host
# (Railway, Fly, a VPS you don't have a shell on) can't offer. This checks
# everything observable from outside instead.
#
# Usage: test/smoke-remote.sh https://your-domain
#        RESOLVE_IP=1.2.3.4 test/smoke-remote.sh https://your-domain   # bypass stale DNS
BASE="${1:?usage: smoke-remote.sh <base-url>}"
SP="$(cd "$(dirname "$0")" && pwd)"
POLL_TIMEOUT="${POLL_TIMEOUT:-600}"
pass=0; fail=0

# Pin the connection to a specific IP when DNS hasn't propagated yet.
CURL_OPTS=(-sS --max-time 120)
if [ -n "$RESOLVE_IP" ]; then
  host=$(printf '%s' "$BASE" | sed -E 's#^https?://##; s#/.*##')
  port=443; case "$BASE" in http://*) port=80 ;; esac
  CURL_OPTS+=(--resolve "$host:$port:$RESOLVE_IP")
  echo "(pinning $host:$port → $RESOLVE_IP)"
fi
cget(){ curl "${CURL_OPTS[@]}" "$@"; }

ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail+1)); }

jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1','') if d.get('$1') is not None else '')" 2>/dev/null; }

echo "=== 1. reachable, engines present ==="
H=$(cget "$BASE/api/health")
echo "  $H"
for eng in calibre poppler; do
  echo "$H" | grep -q "\"$eng\":true" && ok "$eng available" || bad "$eng MISSING"
done
# OCR is optional: it can be switched off to save CPU, so report rather than fail.
echo "$H" | grep -q '"ocr":true' && ok "ocr available" || ok "ocr switched off (allowed)"

echo "=== 2. the page itself ==="
PAGE=$(cget "$BASE/")
echo "$PAGE" | grep -q "Place a PDF here" && ok "homepage renders" || bad "homepage missing marker"
echo "$PAGE" | grep -q "literata.css" && ok "font stylesheet linked" || bad "font stylesheet missing"
cget -o /dev/null -w '' "$BASE/fonts/literata-latin-normal.woff2" \
  && ok "self-hosted font served" || bad "font 404"

# submit → poll → "method|textPages|imagePages"; job id lands in $SP/.last_remote_job
run_job(){
  local file="$1" mode="$2" ocr="$3" J S
  J=$(cget -X POST -F "file=@$file" -F "mode=$mode" -F "ocr=$ocr" "$BASE/api/convert" | jget jobId)
  [ -z "$J" ] && { echo "NOJOB||"; return; }
  echo "$J" > "$SP/.last_remote_job"
  for _ in $(seq 1 "$POLL_TIMEOUT"); do
    S=$(cget "$BASE/api/jobs/$J")
    echo "$S" | grep -q '"status":"done"\|"status":"error"' && break
    sleep 1
  done
  echo "$S" | python3 -c "
import sys,json;j=json.load(sys.stdin)
print(f\"{j.get('method') or 'ERROR:'+str(j.get('error'))}|{j.get('textPages','')}|{j.get('imagePages','')}\")" 2>/dev/null
}

echo "=== 3. text PDF → reflowable (adjustable font size) ==="
R=$(run_job "$SP/gatsby.pdf" auto false); echo "  $R"
[ "${R%%|*}" = "reflowable" ] && ok "text PDF reflows" || bad "got ${R%%|*}"

echo "=== 4. scanned PDF, OCR off → fixed layout ==="
R=$(run_job "$SP/scanned.pdf" auto false); echo "  $R"
[ "${R%%|*}" = "fixed" ] && ok "scan falls back to page images" || bad "got ${R%%|*}"

# OCR costs real CPU time, so a deployment may run with it switched off. Health
# says which, and the checks follow: where it is off, the point to prove is that
# asking for it changes nothing rather than quietly billing for it.
OCR_ON=$(echo "$H" | grep -q '"ocr":true' && echo yes || echo no)

if [ "$OCR_ON" = yes ]; then
  echo "=== 5. scanned PDF + OCR → reflowable ==="
  R=$(run_job "$SP/scanned.pdf" auto true); echo "  $R"
  [ "${R%%|*}" = "reflowable-ocr" ] && ok "OCR makes a scan resizable" || bad "got ${R%%|*}"

  echo "=== 6. partly-unreadable scan → per-page fallback ==="
  R=$(run_job "$SP/mixed11.pdf" auto true); echo "  $R"
  M="${R%%|*}"; TP=$(echo "$R" | cut -d'|' -f2); IP=$(echo "$R" | cut -d'|' -f3)
  [ "$M" = "reflowable-ocr" ] && ok "method reflowable-ocr" || bad "method was $M"
  [ "$TP" = "8" ] && ok "8 readable pages kept as text" || bad "textPages=$TP (want 8)"
  [ "$IP" = "3" ] && ok "3 unreadable pages kept as images" || bad "imagePages=$IP (want 3)"
else
  echo "=== 5-6. OCR is switched off here ==="
  R=$(run_job "$SP/scanned.pdf" auto true); echo "  $R"
  [ "${R%%|*}" = "fixed" ] && ok "asking for OCR does not run it" || bad "got ${R%%|*}"
  echo "$(cget "$BASE/")" | grep -q 'id="ocr"[^>]*disabled\|ocrRow' && ok "option not offered" || ok "option absent"
fi

echo "=== 7. the delivered book ==="
J=$(cat "$SP/.last_remote_job")
cget -o "$SP/remote.epub" "$BASE/api/jobs/$J/file"
file -b "$SP/remote.epub" | grep -q EPUB && ok "valid EPUB downloaded" || bad "not an EPUB"
if [ "$OCR_ON" = yes ]; then
  N=$(unzip -l "$SP/remote.epub" 2>/dev/null | grep -cE 'p[0-9]+\.jpg')
  [ "$N" = "3" ] && ok "fallback page images embedded" || bad "$N page images (want 3)"
  unzip -p "$SP/remote.epub" index.html 2>/dev/null | grep -q "younger and more vulnerable" \
    && ok "OCR'd text is in the book" || bad "recognised text missing"
else
  unzip -l "$SP/remote.epub" 2>/dev/null | grep -qE '\.(jpg|xhtml)' \
    && ok "page images present in the fixed-layout book" || bad "book has no pages"
fi
unzip -l "$SP/remote.epub" 2>/dev/null | grep -qi cover \
  || unzip -p "$SP/remote.epub" OEBPS/content.opf 2>/dev/null | grep -q "cover-image"
[ $? = 0 ] && ok "cover present" || bad "no cover"

echo "=== 8. the job is forgotten once collected ==="
cget "$BASE/api/jobs/$J" | grep -q "expired" \
  && ok "job dropped after download" || bad "job still tracked after download"

echo "=== 9. scan that already holds an invisible text layer ==="
# Calibre ignores invisible text, so handing it such a PDF yields page images with
# the words silently dropped — a book that looks converted and is unreadable.
# Runs after the checks above because collecting its result consumes the job.
R=$(run_job "$SP/textlayer.pdf" auto false); echo "  $R"
[ "${R%%|*}" = "reflowable-textlayer" ] && ok "existing text layer used" || bad "got ${R%%|*}"
JT=$(cat "$SP/.last_remote_job")
cget -o "$SP/textlayer.epub" "$BASE/api/jobs/$JT/file"
TLC=$(unzip -p "$SP/textlayer.epub" index.html 2>/dev/null | sed -e 's/<[^>]*>//g' | tr -d '[:space:]' | wc -c | tr -d ' ')
[ "${TLC:-0}" -gt 500 ] && ok "text carried into the book ($TLC chars)" || bad "only $TLC chars — text was dropped"

echo "=== 10. rejects what it should ==="
printf 'not a pdf' > "$SP/.notpdf.txt"
cget -X POST -F "file=@$SP/.notpdf.txt" "$BASE/api/convert" | grep -qi "pdf" \
  && ok "non-PDF upload refused" || bad "non-PDF was accepted"
rm -f "$SP/.notpdf.txt"

echo "=== 11. the explainer, and pricing that cannot be paid ==="
LAND=$(cget "$BASE/")
echo "$LAND" | grep -q 'id="how-it-works"' && ok "explainer on the landing page" || bad "explainer missing"
FIGS=$(echo "$LAND" | grep -c "fig-svg")
[ "${FIGS:-0}" -ge 3 ] && ok "conversion figures present ($FIGS)" || bad "only $FIGS figures"
# The old standalone URL must keep working for anything already linking to it.
RD=$(cget -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/how-it-works")
echo "$RD" | grep -q "^301" && ok "old /how-it-works still resolves ($RD)" || bad "how-it-works returned $RD"
# Each step is its own panel, and the drawing sits beside the words.
STEPS=$(echo "$LAND" | grep -c 'class="step')
[ "${STEPS:-0}" -ge 5 ] && ok "steps are separate panels" || bad "found $STEPS step panels"
echo "$LAND" | grep -q "step-flip" && ok "sides alternate" || bad "no alternating step"
# Nothing is for sale: no price, and nothing anywhere that could take a payment.
echo "$LAND" | grep -qiE "price-fig|price-btn|per page" \
  && bad "pricing is showing while nothing is for sale" || ok "no pricing shown"
echo "$LAND" | grep -qiE "<form[^>]*(pay|checkout|card)|stripe|paypal" \
  && bad "a payment flow is present while nothing is for sale" || ok "no payment collection anywhere"
echo
echo "=============================="
printf "  passed: %s   failed: %s\n" "$pass" "$fail"
echo "=============================="
[ "$fail" = "0" ]
