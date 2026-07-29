"""Draw the application icon.

Two artefacts, one drawing:

    app/icon.ico        embedded as a Windows resource - the file's icon in
                        Explorer and on the taskbar
    app/icon-64.rgba    raw pixels the shell hands to the window at startup -
                        the icon in the title bar, which does not come from
                        the resource because the window class is the toolkit's
                        own and defaults to the system application icon

Both come from here so they cannot drift apart. It is the same mark the page
uses for its favicon, so the taskbar, the window and the browser tab agree.

    python scripts\\make-icon.py

Needs Pillow. Run it after changing the drawing; the results are committed, so
building the shell does not depend on Python.
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO = os.path.join(ROOT, "app", "icon.ico")
RGBA = os.path.join(ROOT, "app", "icon-64.rgba")

ACCENT = (232, 165, 152, 255)   # --accent from style.css
BACKDROP = (20, 21, 27, 255)    # a touch lighter than --bg so it reads on black
SIZES = [256, 128, 64, 48, 32, 24, 16]
WINDOW_SIZE = 64

# Drawn large and downsampled: a ring drawn directly at 16px has no usable
# anti-aliasing on the curve.
SUPER = 8


def draw(size):
    s = size * SUPER
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)

    # Rounded square behind the mark: the ring is thin, and unfilled it nearly
    # disappears against a dark taskbar.
    pen.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BACKDROP)

    centre = s / 2.0
    ring_r = s * 0.29
    # Scaled with the icon so the ring keeps its weight at every size.
    pen.ellipse(
        [centre - ring_r, centre - ring_r, centre + ring_r, centre + ring_r],
        outline=ACCENT,
        width=max(SUPER, int(s * 0.062)),
    )

    dot_r = s * 0.108
    pen.ellipse([centre - dot_r, centre - dot_r, centre + dot_r, centre + dot_r], fill=ACCENT)

    return image.resize((size, size), Image.LANCZOS)


frames = [draw(size) for size in SIZES]
frames[0].save(ICO, format="ICO", sizes=[(s, s) for s in SIZES])
print("wrote %s (%d bytes, %s)" % (ICO, os.path.getsize(ICO), ", ".join(str(s) for s in SIZES)))

window = draw(WINDOW_SIZE).convert("RGBA")
with open(RGBA, "wb") as handle:
    handle.write(window.tobytes())
print("wrote %s (%dx%d, %d bytes)" % (RGBA, WINDOW_SIZE, WINDOW_SIZE, os.path.getsize(RGBA)))
