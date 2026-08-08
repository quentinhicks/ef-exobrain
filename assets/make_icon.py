import os
from PIL import Image, ImageDraw

# Regenerates assets/icon.ico from assets/blanket.webp (a folded tan/cream
# checkerboard plush blanket): square-crop the blanket body, round the corners
# for an app-icon look, save multi-size .ico. Requires Pillow.
# Also writes static/icon-{192,512}.png for the PWA manifest / Add to Home
# Screen — from the same crop, but SQUARE and opaque: iOS applies its own mask,
# and transparent corners get composited onto black there.
# Run: python assets/make_icon.py   (then rebuild via build_exe.bat)

HERE = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(HERE, "blanket.webp")
im = Image.open(src).convert("RGB")

# blanket is centered in the 800x1200 photo; crop a square around its body
box = (120, 350, 648, 878)
square = im.crop(box)

static_dir = os.path.join(os.path.dirname(HERE), "static")
for px in (192, 512):
    png = os.path.join(static_dir, f"icon-{px}.png")
    square.resize((px, px), Image.LANCZOS).save(png, format="PNG")
    print("wrote", png, os.path.getsize(png), "bytes")

crop = square.resize((256, 256), Image.LANCZOS).convert("RGBA")

# rounded-corner mask (transparent corners)
r = int(256 * 0.16)
mask = Image.new("L", (256, 256), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 255], radius=r, fill=255)
crop.putalpha(mask)

out = os.path.join(HERE, "icon.ico")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
crop.save(out, format="ICO", sizes=sizes)
print("wrote", out, os.path.getsize(out), "bytes")
