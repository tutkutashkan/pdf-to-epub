#!/usr/bin/env python3
"""Build a PDF from JPEGs. Optionally overlay a real text line on each page
(--with-text) so we can test a PDF that has BOTH text and figures."""
import sys, struct

def jpeg_dims(b):
    o = 2
    while o < len(b) - 8:
        if b[o] != 0xFF:
            o += 1; continue
        m = b[o+1]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            return struct.unpack(">H", b[o+7:o+9])[0], struct.unpack(">H", b[o+5:o+7])[0]
        o += 2 + struct.unpack(">H", b[o+2:o+4])[0]
    raise SystemExit("no SOF marker")

args = sys.argv[1:]
with_text = "--with-text" in args
args = [a for a in args if a != "--with-text"]
out_path, imgs = args[0], args[1:]

objs, kids, streams = [], [], {}
num = 3
font_no = None
pages = []
for p in imgs:
    data = open(p, "rb").read()
    w, h = jpeg_dims(data)
    pw, ph = w * 72 / 150, h * 72 / 150
    img_no, cont_no, page_no = num, num + 1, num + 2
    num += 3
    pages.append((page_no, img_no, cont_no, data, w, h, pw, ph))
    kids.append(f"{page_no} 0 R")
if with_text:
    font_no = num; num += 1

objs.append(("1 0 obj", "<</Type/Catalog/Pages 2 0 R>>"))
objs.append(("2 0 obj", f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(pages)}>>"))

for i, (page_no, img_no, cont_no, data, w, h, pw, ph) in enumerate(pages):
    objs.append((f"{img_no} 0 obj",
                 f"<</Type/XObject/Subtype/Image/Width {w}/Height {h}"
                 f"/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length {len(data)}>>"))
    streams[img_no] = data
    # Draw the image smaller so an added text line is clearly separate from it.
    if with_text:
        ops = (f"q {pw*0.6:.2f} 0 0 {ph*0.4:.2f} 40 60 cm /Im0 Do Q\n"
               f"BT /F1 22 Tf 40 {ph-60:.2f} Td (Real text line on page {i+1}) Tj ET").encode()
    else:
        ops = f"q {pw:.2f} 0 0 {ph:.2f} 0 0 cm /Im0 Do Q".encode()
    objs.append((f"{cont_no} 0 obj", f"<</Length {len(ops)}>>"))
    streams[cont_no] = ops
    res = f"<</XObject<</Im0 {img_no} 0 R>>"
    if with_text:
        res += f"/Font<</F1 {font_no} 0 R>>"
    res += ">>"
    objs.append((f"{page_no} 0 obj",
                 f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 {pw:.2f} {ph:.2f}]"
                 f"/Resources{res}/Contents {cont_no} 0 R>>"))

if with_text:
    objs.append((f"{font_no} 0 obj", "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"))

out = b"%PDF-1.4\n"; off = {}
for h_, b_ in sorted(objs, key=lambda o: int(o[0].split()[0])):
    n = int(h_.split()[0]); off[n] = len(out)
    out += (h_ + "\n" + b_ + "\n").encode("latin-1")
    if n in streams:
        out += b"stream\n" + streams[n] + b"\nendstream\n"
    out += b"endobj\n"
xp = len(out); mx = max(off) + 1
out += f"xref\n0 {mx}\n".encode() + b"0000000000 65535 f \n"
for i in range(1, mx):
    out += (f"{off[i]:010d} 00000 n \n".encode() if i in off else b"0000000000 65535 f \n")
out += f"trailer\n<</Size {mx}/Root 1 0 R>>\nstartxref\n{xp}\n%%EOF".encode()
open(out_path, "wb").write(out)
print("wrote", out_path, f"({len(pages)} pages, text={'yes' if with_text else 'no'})")
