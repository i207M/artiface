#!/usr/bin/env python3
"""Render Artiface's A-nose face as installable-app PNG icons (standard library only)."""
from pathlib import Path
import math
import struct
import zlib

DEST = Path(__file__).resolve().parents[1] / "web" / "public" / "icons"
PAPER = (237, 244, 238)
TONE = (121, 180, 154)
INK = (24, 63, 53)
# Match favicon.svg, which is also used by the in-app Brand component.
EYES = ((43, 42, 43, 53), (91, 42, 91, 53))
NOSE = ((55, 76, 68, 44), (68, 44, 81, 76), (59.5, 65, 76.5, 65))
SMILE_POINTS = [(38 + 58 * t + t * t, 84 + 50 * t - 53 * t * t)
                for t in (i / 64 for i in range(65))]
SMILE = [(*a, *b) for a, b in zip(SMILE_POINTS, SMILE_POINTS[1:])]


def distance(x, y, line):
    x1, y1, x2, y2 = line
    dx, dy = x2 - x1, y2 - y1
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - x1 - t * dx, y - y1 - t * dy)


def pixel(x, y, maskable):
    if not maskable:
        cx, cy = min(90, max(38, x)), min(90, max(38, y))
        if math.hypot(x - cx, y - cy) > 26:
            return (0, 0, 0, 0)
    # Maskable and Apple icons have an opaque, full-bleed background.
    # The eyes, nose, and smile already fit inside the central 80% safe circle.
    color = TONE if x >= 84 - 31 * (y - 12) / 104 else PAPER
    if 39 <= y <= 56 and min(distance(x, y, line) for line in EYES) <= 2.75:
        color = INK
    if 52 <= x <= 84 and 41 <= y <= 79 and min(distance(x, y, line) for line in NOSE) <= 2.75:
        color = INK
    if 35 <= x <= 100 and 78 <= y <= 99 and min(distance(x, y, line) for line in SMILE) <= 2.75:
        color = INK
    return (*color, 255)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def render(filename, size, maskable=False):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel(12 + (x + dx) * 104 / size, 12 + (y + dy) * 104 / size, maskable)
                       for dx in (0.25, 0.75) for dy in (0.25, 0.75)]
            alpha = sum(sample[3] for sample in samples)
            # PNG stores straight alpha: transparent samples must not darken RGB.
            rows.extend(round(sum(sample[channel] * sample[3] for sample in samples) / alpha)
                        if alpha else 0 for channel in range(3))
            rows.append(round(alpha / 4))
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    (DEST / filename).write_bytes(data)


if __name__ == "__main__":
    DEST.mkdir(parents=True, exist_ok=True)
    render("icon-192.png", 192)
    render("icon-512.png", 512)
    render("maskable-512.png", 512, True)
    render("apple-touch-icon.png", 180, True)
