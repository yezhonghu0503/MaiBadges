#!/usr/bin/env python3
"""Rebuild MaiBadges' original geometric examples and application icon.

Copyright (c) 2026 MaiBadges contributors. SPDX-License-Identifier: MIT
Requires Pillow; no network, fonts, original role images, or AI image service.
All drawing coordinates below were authored for this public example.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "plugins" / "work-badges" / "assets"
HOLO = ASSETS / "holo" / "demo"
SCALE = 3
INK = "#173F36"
PAPER = "#F4F1E5"
BLUE = "#769BD0"
WHITE = "#FFFFFF"


def rgba(value):
    if value is None:
        return None
    if isinstance(value, tuple):
        return value
    return tuple(bytes.fromhex(value.lstrip("#"))) + (255,)


def svg_paint(value):
    if value is None:
        return 'fill="none"'
    color = rgba(value)
    return f'fill="#{color[0]:02x}{color[1]:02x}{color[2]:02x}" fill-opacity="{color[3]/255:.6f}"'


class Canvas:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.image = Image.new("RGBA", (width*SCALE, height*SCALE), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.image)
        self.elements = []

    def coords(self, coords):
        return tuple(round(v*SCALE) for v in coords)

    def primitive(self, method, *args, fill, **kwargs):
        color = rgba(fill)
        if color[3] == 255:
            getattr(self.draw, method)(*args, fill=color, **kwargs)
        else:
            overlay = Image.new("RGBA", self.image.size)
            getattr(ImageDraw.Draw(overlay), method)(*args, fill=color, **kwargs)
            self.image = Image.alpha_composite(self.image, overlay)
            self.draw = ImageDraw.Draw(self.image)

    def rect(self, box, fill, radius=0):
        self.primitive("rounded_rectangle", self.coords(box), radius=round(radius*SCALE), fill=fill)
        x1, y1, x2, y2 = box
        self.elements.append(f'<rect x="{x1}" y="{y1}" width="{x2-x1}" height="{y2-y1}" rx="{radius}" {svg_paint(fill)}/>')

    def ellipse(self, box, fill):
        self.primitive("ellipse", self.coords(box), fill=fill)
        x1, y1, x2, y2 = box
        self.elements.append(f'<ellipse cx="{(x1+x2)/2}" cy="{(y1+y2)/2}" rx="{(x2-x1)/2}" ry="{(y2-y1)/2}" {svg_paint(fill)}/>')

    def polygon(self, points, fill):
        self.primitive("polygon", [self.coords(p) for p in points], fill=fill)
        coordinates = " ".join(f"{x},{y}" for x, y in points)
        self.elements.append(f'<polygon points="{coordinates}" {svg_paint(fill)}/>')

    def line(self, points, fill, width=1):
        self.primitive("line", [self.coords(p) for p in points], fill=fill, width=round(width*SCALE), joint="curve")
        coordinates = " ".join(f"{x},{y}" for x, y in points)
        color = rgba(fill)
        self.elements.append(f'<polyline points="{coordinates}" fill="none" stroke="#{color[0]:02x}{color[1]:02x}{color[2]:02x}" stroke-opacity="{color[3]/255:.6f}" stroke-width="{width}" stroke-linejoin="round"/>')

    def save(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.image.resize((self.width, self.height), Image.Resampling.LANCZOS).save(path, optimize=True)
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" '
               f'width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}">\n'
               '<!-- Original MaiBadges geometry. SPDX-License-Identifier: MIT -->\n'
               + "\n".join(self.elements) + "\n</svg>\n")
        path.with_suffix(".svg").write_text(svg, encoding="utf-8")


def badge_symbol(canvas, cx, cy, size, *, blue=BLUE):
    """An original clipped credential with a circle and two information strokes."""
    unit = size/100
    def box(x1, y1, x2, y2):
        return (cx+x1*unit, cy+y1*unit, cx+x2*unit, cy+y2*unit)
    canvas.rect(box(-41, -43, 41, 48), PAPER, radius=15*unit)
    canvas.rect(box(-17, -53, 17, -32), INK, radius=7*unit)
    canvas.rect(box(-9, -47, 9, -42), PAPER, radius=2.5*unit)
    canvas.ellipse(box(-25, -19, 1, 7), blue)
    canvas.rect(box(10, -15, 26, -9), INK, radius=3*unit)
    canvas.rect(box(10, -2, 26, 4), INK, radius=3*unit)
    canvas.rect(box(-25, 20, 26, 27), INK, radius=3.5*unit)
    canvas.rect(box(-25, 33, 11, 37), (23, 63, 54, 110), radius=2*unit)


def app_icon():
    icon = Canvas(1024, 1024)
    icon.rect((48, 48, 976, 976), INK, radius=214)
    icon.rect((66, 66, 958, 958), (30, 77, 65, 255), radius=198)
    # Offset inset planes create a subtle impression of a physical credential.
    icon.rect((295, 292, 795, 830), (11, 39, 34, 150), radius=86)
    badge_symbol(icon, 512, 503, 612)
    icon.ellipse((715, 703, 859, 847), BLUE)
    icon.line([(754, 775), (780, 801), (822, 753)], PAPER, width=14)
    icon.save(ASSETS / "maibadges.png")
    with Image.open(ASSETS / "maibadges.png") as image:
        image.save(ASSETS / "maibadges.icns", format="ICNS")
    # The brand mark is the same original symbol at a smaller, readable scale.
    brand = Canvas(96, 96)
    brand.rect((1, 1, 95, 95), INK, radius=23)
    badge_symbol(brand, 48, 48, 61)
    brand.save(ASSETS / "brand.png")


def portrait():
    """Generic fallback thumbnail. Emblem fits the upper photo crop as well."""
    image = Canvas(720, 720)
    image.rect((0, 0, 720, 720), "#E6EBE4")
    image.polygon([(0, 0), (720, 0), (720, 390), (0, 135)], "#D8E2DA")
    image.ellipse((181, 25, 539, 383), "#CCDCD1")
    image.ellipse((197, 35, 523, 361), INK)
    badge_symbol(image, 360, 194, 238)
    image.rect((124, 474, 596, 492), (23, 63, 54, 27), radius=9)
    image.rect((186, 515, 534, 526), (23, 63, 54, 18), radius=5)
    image.save(ASSETS / "demo.png")


def material():
    width, height = 530, 742
    background = Canvas(width, height)
    background.rect((0, 0, width, height), "#214E42")
    background.polygon([(0, 0), (530, 0), (530, 292), (0, 113)], "#315F50")
    background.polygon([(0, 197), (530, 386), (530, 441), (0, 252)], "#285545")
    background.polygon([(0, 565), (530, 407), (530, 742), (0, 742)], "#193E35")
    background.line([(0, 143), (530, 333)], (218, 230, 205, 45), width=2)
    background.line([(0, 577), (530, 419)], (218, 230, 205, 32), width=2)
    background.save(HOLO / "background.png")

    # The floating emblem is one opaque colored object on transparent canvas.
    character = Canvas(width, height)
    character.ellipse((124, 110, 424, 410), (6, 30, 25, 65))
    character.ellipse((113, 89, 407, 383), "#B5CEC6")
    character.ellipse((121, 97, 399, 375), "#7095C7")
    character.ellipse((130, 106, 390, 366), "#83A7D8")
    badge_symbol(character, 260, 230, 199, blue="#45745F")
    character.save(HOLO / "character.png")

    # Only an original thin boundary is baked; the live DOM renders all copy.
    ui = Canvas(width, height)
    ui.rect((9, 9, 521, 733), (234, 236, 213, 215), radius=31)
    # A transparent interior is drawn using a proper alpha mask.
    ui.draw.rounded_rectangle(ui.coords((12, 12, 518, 730)), radius=29*SCALE, fill=(0, 0, 0, 0))
    ui.elements = [
        '<rect x="10.5" y="10.5" width="509" height="721" rx="30" fill="none" stroke="#EAECD5" stroke-opacity="0.843137" stroke-width="3"/>'
    ]
    ui.save(HOLO / "ui.png")
    ui.save(HOLO / "ui-live.png")

    # Sparse actual-alpha contour for the shader, never an opaque black mask.
    structure = Canvas(width, height)
    arc = [(260+139*math.cos(t/120*math.tau), 236+139*math.sin(t/120*math.tau)) for t in range(121)]
    structure.line(arc, (255, 255, 255, 132), width=1.5)
    structure.line([(178, 144), (178, 139), (342, 139), (342, 145)], (255, 255, 255, 100), width=1)
    structure.save(HOLO / "structure.png")
    structure.save(HOLO / "contour-alpha.png")

    names = ("character.png", "background.png", "ui.png", "ui-live.png", "structure.png", "contour-alpha.png")
    manifest = {
        "version": 2,
        "name": "Original geometric demo",
        "license": "MIT",
        "sourceImageId": digest(ASSETS / "demo.png"),
        "sourceDimensions": [width, height],
        "files": {"foreground": "character.png", "contour": "contour-alpha.png",
                  "character": "character.png", "background": "background.png",
                  "ui": "ui-live.png", "structure": "structure.png"},
        "sha256": {name: digest(HOLO / name) for name in names},
    }
    (HOLO / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def provenance():
    files = [ASSETS / (name+ext) for name in ("demo", "brand", "maibadges") for ext in (".png", ".svg")]
    files += [ASSETS / "maibadges.icns"]
    files += sorted(HOLO.glob("*"))
    document = {
        "schemaVersion": 1,
        "title": "MaiBadges original generic example assets",
        "license": "MIT",
        "copyright": "Copyright (c) 2026 MaiBadges contributors",
        "method": "Original programmatic geometry, authored with Pillow and matching SVG sources.",
        "generator": "tools/generate_demo_assets.py",
        "requirements": ["Python 3", "Pillow"],
        "externalInputs": [],
        "content": "Abstract credential symbol; no person, personal name, brand portrait, or third-party logo.",
        "rebuild": "python3 tools/generate_demo_assets.py",
        "files": {str(path.relative_to(ASSETS)): {"sha256": digest(path), "bytes": path.stat().st_size} for path in files},
    }
    (ASSETS / "ASSET_PROVENANCE.json").write_text(json.dumps(document, indent=2)+"\n", encoding="utf-8")


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    HOLO.mkdir(parents=True, exist_ok=True)
    app_icon()
    portrait()
    material()
    provenance()
    print(json.dumps({"demoImageId": digest(ASSETS / "demo.png"), "assets": str(ASSETS)}, indent=2))


if __name__ == "__main__":
    main()
