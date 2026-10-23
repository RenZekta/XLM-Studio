#!/usr/bin/env python3
"""Draws the XLM Studio icon (assets/icon.svg, icon PNGs) and the release banner.

    python3 scripts/brand-assets.py [--font-bold PATH] [--font-regular PATH]

Needs Pillow and numpy. The banner lettering uses Poppins; pass the font files
if they are not in the default Linux location. Everything is drawn from the
same few numbers below, so changing the design means changing them here.
"""
import argparse
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ASSETS = os.path.join(ROOT, 'assets')
PUBLIC = os.path.join(ROOT, 'src', 'renderer', 'public')

BLUE = (47, 109, 255)
WHITE = (255, 255, 255)
# The tile is not black, so it stays visible on a black taskbar or dock: a
# light gradient from the top left, and a faint light edge.
TILE_LIGHT = (62, 62, 70)
TILE_DARK = (14, 14, 18)
EDGE = (255, 255, 255, 40)

MARGIN = 0.0625          # transparent border around the tile, of the canvas
RADIUS = 0.225           # corner radius, of the tile
LINE = 0.062             # stroke width of both lines, of the tile
KNOB = 0.078             # outer radius of the knob (its white ring), of the tile
RING = 0.028             # width of the white ring around the blue centre, of the tile
A = 0.27                 # the X spans A..1-A of the tile on both axes
KNOB_AT = 0.75           # position of the knob along the blue line


def tile_points():
    p0, p1 = A, 1 - A
    white = ((p0, p0), (p1, p1))
    blue = ((p0, p1), (p1, p0))
    knob = (blue[0][0] + KNOB_AT * (blue[1][0] - blue[0][0]),
            blue[0][1] + KNOB_AT * (blue[1][1] - blue[0][1]))
    return white, blue, knob


def icon(size, supersample=None):
    """The icon as an RGBA image of size x size."""
    ss = supersample or (8 if size <= 64 else 4 if size <= 256 else 2)
    n = size * ss
    tile = n * (1 - 2 * MARGIN)
    o = n * MARGIN
    # Strokes get heavier at small sizes so the X still reads at 16 px.
    boost = 1.5 if size <= 24 else 1.3 if size <= 48 else 1.0

    t = (np.add.outer(np.arange(n), np.arange(n)) / (2.0 * n)).clip(0, 1)
    grad = np.zeros((n, n, 4), dtype=np.float64)
    for c in range(3):
        grad[..., c] = TILE_LIGHT[c] + (TILE_DARK[c] - TILE_LIGHT[c]) * t
    grad[..., 3] = 255
    img = Image.fromarray(grad.round().astype(np.uint8), 'RGBA')

    mask = Image.new('L', (n, n), 0)
    box = (o, o, o + tile, o + tile)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=RADIUS * tile, fill=255)
    out = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)

    edge = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(box, radius=RADIUS * tile, outline=EDGE, width=max(1, round(0.012 * tile)))
    out = Image.alpha_composite(out, edge)

    d = ImageDraw.Draw(out)
    white, blue, knob = tile_points()
    px = lambda p: (o + p[0] * tile, o + p[1] * tile)

    def stroke(pts, color):
        w = LINE * boost * tile
        a, b = px(pts[0]), px(pts[1])
        d.line([a, b], fill=color, width=round(w))
        for x, y in (a, b):
            d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=color)

    stroke(white, WHITE)
    stroke(blue, BLUE)
    kx, ky = px(knob)
    r = KNOB * boost * tile
    d.ellipse((kx - r, ky - r, kx + r, ky + r), fill=WHITE)
    r -= RING * boost * tile
    d.ellipse((kx - r, ky - r, kx + r, ky + r), fill=BLUE)
    return out.resize((size, size), Image.LANCZOS)


def icon_svg():
    white, blue, knob = tile_points()
    t = 1024 * (1 - 2 * MARGIN)
    o = 1024 * MARGIN
    px = lambda p: (round(o + p[0] * t, 1), round(o + p[1] * t, 1))
    (wx0, wy0), (wx1, wy1) = map(px, white)
    (bx0, by0), (bx1, by1) = map(px, blue)
    kx, ky = px(knob)
    w = round(LINE * t, 1)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb{TILE_LIGHT}"/>
      <stop offset="1" stop-color="rgb{TILE_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="{o}" y="{o}" width="{t}" height="{t}" rx="{round(RADIUS * t, 1)}" fill="url(#tile)"/>
  <rect x="{o}" y="{o}" width="{t}" height="{t}" rx="{round(RADIUS * t, 1)}" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="{round(0.012 * t, 1)}"/>
  <path d="M{wx0} {wy0}L{wx1} {wy1}" stroke="#fff" stroke-width="{w}" stroke-linecap="round"/>
  <path d="M{bx0} {by0}L{bx1} {by1}" stroke="rgb{BLUE}" stroke-width="{w}" stroke-linecap="round"/>
  <circle cx="{kx}" cy="{ky}" r="{round(KNOB * t, 1)}" fill="#fff"/>
  <circle cx="{kx}" cy="{ky}" r="{round((KNOB - RING) * t, 1)}" fill="rgb{BLUE}"/>
</svg>
'''


def banner(font_bold, font_regular):
    """The picture at the top of every GitHub release: 1651 x 433."""
    w, h, ss = 1651, 433, 2
    img = Image.new('RGBA', (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=24 * ss, fill=(10, 10, 10, 255))
    mark = icon(240 * ss, supersample=1)
    img.alpha_composite(mark, (110 * ss, 96 * ss))

    title = ImageFont.truetype(font_bold, 124 * ss)
    x, base = 420 * ss, 250 * ss
    d.text((x, base), 'X', font=title, fill=BLUE, anchor='ls')
    d.text((x + title.getlength('X'), base), 'LM Studio', font=title, fill=WHITE, anchor='ls')
    tag = ImageFont.truetype(font_regular, 40 * ss)
    d.text((424 * ss, 318 * ss), 'A GUI for llama.cpp and Strata', font=tag, fill=(163, 163, 163), anchor='ls')
    return img.resize((w, h), Image.LANCZOS)


def main():
    fonts = '/usr/share/fonts/truetype/google-fonts'
    ap = argparse.ArgumentParser()
    ap.add_argument('--font-bold', default=os.path.join(fonts, 'Poppins-Bold.ttf'))
    ap.add_argument('--font-regular', default=os.path.join(fonts, 'Poppins-Regular.ttf'))
    args = ap.parse_args()

    os.makedirs(os.path.join(ASSETS, 'icons'), exist_ok=True)
    with open(os.path.join(ASSETS, 'icon.svg'), 'w') as f:
        f.write(icon_svg())
    icon(1024).save(os.path.join(ASSETS, 'icon_1024.png'))
    icon(256).save(os.path.join(ASSETS, 'icon_256.png'))
    icon(256).save(os.path.join(PUBLIC, 'icon.png'))
    # The Linux icon set: one file per size, named by it, for the launcher,
    # the taskbar and the window switcher.
    for s in (16, 24, 32, 48, 64, 128, 256, 512):
        icon(s).save(os.path.join(ASSETS, 'icons', f'{s}x{s}.png'))
    banner(args.font_bold, args.font_regular).save(os.path.join(ASSETS, 'github-banner.png'))


if __name__ == '__main__':
    main()
