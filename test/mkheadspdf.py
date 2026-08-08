#!/usr/bin/env python3
"""Build a PDF that reproduces the running-head bug: every page carries a page
number and an alternating running head in its top margin, and one sentence runs
across a page break so the furniture lands in the middle of it."""
import sys

TITLE, AUTHOR = "The Salt Road", "Marta Nieves"
# The sentence that must survive intact once the furniture is stripped.
SPLIT_A, SPLIT_B = "he was wearing a pair of", "old canvas trousers he never washed"
# Unique prose per page and a normal top margin. A fixture that repeats the same
# body line on every page is not a book: repetition is exactly the signal used to
# find furniture, so identical body text makes the fixture flag itself.
LINES = [
    "The harbour had emptied by the time she reached the wall.",
    "Salt had dried white along the seams of her only good coat.",
    "Nobody came down to the water at that hour except the gulls.",
    "She counted the boats twice and got a different answer each time.",
    "The ferryman had a way of looking past whoever was speaking.",
    "Rain arrived from the west without troubling to announce itself.",
    "Her brother had written once, in pencil, and never again after.",
    "The road out of town climbed until the roofs fell out of sight.",
    "Someone had left a chair on the quay, facing the wrong way.",
    "By evening the tide had taken back everything it had lent.",
    "She learned the timetable by heart and then ignored it.",
    "The last light went out of the water like a held breath.",
]

def esc(t): return t.replace("(", r"\(").replace(")", r"\)")

def page_ops(n, first_line, rest):
    head = TITLE if n % 2 == 0 else AUTHOR
    ops = [f"BT /F1 8 Tf 250 812 Td ({esc(head)}) Tj ET",      # running head, top margin
           f"BT /F1 8 Tf 90 800 Td ({n}) Tj ET"]              # page number, top margin
    y = 730   # body starts well clear of the margin, as a typeset book does
    for line in [first_line] + rest:
        ops.append(f"BT /F2 11 Tf 90 {y} Td ({esc(line)}) Tj ET")
        y -= 20
    return "\n".join(ops)

pages = []
for n in range(1, 13):
    body = LINES[(n - 1) % len(LINES)]
    # The halves must be adjacent across the break: last line of one page, first
    # line of the next. Putting another line between them tests nothing.
    if n == 4:      first, rest = body, [SPLIT_A]             # page ends mid-sentence
    elif n == 5:    first, rest = SPLIT_B, [body]             # next page continues it
    else:           first, rest = body, [LINES[n % len(LINES)]]
    pages.append(page_ops(n, first, rest))

# Reserve the font object numbers up front: every page must point at the SAME
# two font objects. Deriving them inside the loop gave each page a different
# (and mostly non-existent) number, and pdftohtml then read only one page.
objs = [("1 0 obj", "<</Type/Catalog/Pages 2 0 R>>")]
F1 = 3 + len(pages) * 2
F2 = F1 + 1
kids, num, streams = [], 3, {}
for ops in pages:
    pg, ct = num, num + 1; num += 2
    kids.append(f"{pg} 0 R")
    objs.append((f"{ct} 0 obj", f"<</Length {len(ops)}>>")); streams[ct] = ops.encode()
    objs.append((f"{pg} 0 obj",
                 f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 432 842]"
                 f"/Resources<</Font<</F1 {F1} 0 R/F2 {F2} 0 R>>>>/Contents {ct} 0 R>>"))
objs.append((f"{F1} 0 obj", "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Oblique>>"))
objs.append((f"{F2} 0 obj", "<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>"))
objs.insert(1, ("2 0 obj", f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(pages)}>>"))

out = b"%PDF-1.4\n"; off = {}
for h, b in sorted(objs, key=lambda o: int(o[0].split()[0])):
    i = int(h.split()[0]); off[i] = len(out)
    out += (h + "\n" + b + "\n").encode("latin-1")
    if i in streams: out += b"stream\n" + streams[i] + b"\nendstream\n"
    out += b"endobj\n"
xp = len(out); mx = max(off) + 1
out += f"xref\n0 {mx}\n".encode() + b"0000000000 65535 f \n"
for i in range(1, mx):
    out += (f"{off[i]:010d} 00000 n \n".encode() if i in off else b"0000000000 65535 f \n")
out += f"trailer\n<</Size {mx}/Root 1 0 R>>\nstartxref\n{xp}\n%%EOF".encode()
open(sys.argv[1], "wb").write(out)
print("wrote", sys.argv[1])
