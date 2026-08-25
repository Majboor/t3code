#!/usr/bin/env python3
"""Regenerates the LogicPacks brand icons: green "LP" on a black squircle.

Kept as a script rather than only committing the PNGs so the mark can be
retuned — colour, weight, letter spacing — without redrawing it by hand. Run:

    python3 scripts/make-lp-icon.py

It writes every production asset the desktop build and the web favicons read.
"""
from PIL import Image, ImageDraw, ImageFont
import pathlib

S = 1024
PAD = 96                      # matches the silhouette of the icon it replaces
RADIUS = 200
BLACK = (0, 0, 0, 255)
TOP = (91, 255, 157)          # bright green, reads at 16px
BOTTOM = (0, 200, 83)         # deeper green, gives the letters weight
SHADOW = (0, 61, 26, 255)

# Chosen by face name, not by index. Index order inside a .ttc is not stable
# across macOS versions, and picking blindly once silently produced an oblique.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Avenir Next.ttc", "Heavy"),
    ("/System/Library/Fonts/HelveticaNeue.ttc", "Bold"),
    ("/System/Library/Fonts/Helvetica.ttc", "Bold"),
]


def load_font(size):
    for path, style in FONT_CANDIDATES:
        for index in range(12):
            try:
                font = ImageFont.truetype(path, size, index=index)
            except Exception:
                break
            if font.getname()[1] == style:
                return font
    raise SystemExit("no upright bold face found")


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGBA", (1, size), top + (255,))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
            255,
        )
    return grad.resize((size, size))


def render(text="LP"):
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(icon).rounded_rectangle(
        [PAD, PAD, S - PAD, S - PAD], radius=RADIUS, fill=BLACK
    )

    # Grow the type until it fills the face, then step back one.
    inner = S - 2 * PAD
    target_w, target_h = inner * 0.74, inner * 0.52
    size = 100
    while size < 900:
        f = load_font(size + 10)
        box = f.getbbox(text)
        if (box[2] - box[0]) > target_w or (box[3] - box[1]) > target_h:
            break
        size += 10
    font = load_font(size)

    box = font.getbbox(text)
    tw, th = box[2] - box[0], box[3] - box[1]
    x = (S - tw) // 2 - box[0]
    y = (S - th) // 2 - box[1]

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).text((x, y), text, font=font, fill=255)

    # A darker copy underneath reads as depth, the way the old mark was bevelled.
    shade = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shade).text((x + 7, y + 7), text, font=font, fill=255)
    icon.paste(Image.new("RGBA", (S, S), SHADOW), (0, 0), shade)

    icon.paste(vertical_gradient(S, TOP, BOTTOM), (0, 0), mask)
    return icon


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    prod = root / "assets" / "prod"
    prod.mkdir(parents=True, exist_ok=True)
    icon = render()

    icon.save(prod / "lp-macos-1024.png")
    icon.save(prod / "lp-universal-1024.png")
    icon.resize((180, 180), Image.LANCZOS).save(prod / "lp-web-apple-touch-180.png")
    icon.resize((32, 32), Image.LANCZOS).save(prod / "lp-web-favicon-32x32.png")
    icon.resize((16, 16), Image.LANCZOS).save(prod / "lp-web-favicon-16x16.png")
    icon.save(prod / "lp-web-favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    icon.save(prod / "lp-windows.ico", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
    print("wrote LP icons to", prod)


if __name__ == "__main__":
    main()
