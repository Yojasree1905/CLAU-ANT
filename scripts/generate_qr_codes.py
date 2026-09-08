"""
Generates one QR code image per landmark, for printing and sticking up at
the physical location. Scanning one gives the app an unambiguous position
fix — replacing the unreliable color-fingerprint guessing (see
localization.js) with the "Anchor Point" approach: a real, verifiable
marker at each place, same idea as scanning a QR code at a building
entrance to calibrate an indoor AR system.

Encoded format: "NAVASSIST:<venueId>:<nodeId>"
e.g. "NAVASSIST:hblock3:lift"

Run: python3 scripts/generate_qr_codes.py
Output: qr-codes/<venueId>/<nodeId>.png, plus a printable index sheet.
"""
import json
import re
from pathlib import Path
import qrcode
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT = Path(__file__).parent.parent
OUT_DIR = PROJECT_ROOT / "qr-codes"

# Mirrors the node lists in js/venues/*.js — kept as plain data here so this
# script has no dependency on a JS runtime. If you add/rename nodes in the
# venue files, update this list too.
VENUES = {
    "sjt7": {
        "label": "SJT — 7th floor corner",
        "nodes": {
            "stairs": "The Staircase",
            "lobby": "The Entrance Lobby",
            "room_711_712": "Rooms 711 & 712",
            "faculty_cabins": "The Faculty Cabins",
            "water_cooler": "The Water Cooler",
            "washroom_women": "The Women's Washroom (714)",
            "room_715": "Room 715",
            "open_corridor": "The Open Corridor",
            "corridor_end": "Far End of Corridor",
        },
    },
    "hblock3": {
        "label": "H Block — 3rd floor",
        "nodes": {
            "lift": "The Lift",
            "stairs": "The Staircase",
            "water_cooler": "The Water Cooler",
            "washroom": "The Washroom",
            "corridor_start": "Main Corridor",
            "storage_pantry": "The Storage Room",
            "common_room": "The Common Room (Sofa)",
            "corridor_junction": "The Corridor Turn",
            "dormitory_rooms": "Dormitory Rooms",
            "balcony": "The Balcony",
        },
    },
}

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def make_sticker(payload, title, subtitle):
    qr = qrcode.QRCode(border=2, box_size=10, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(payload)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    # Compose a printable card: QR code + a human-readable label underneath,
    # so it's obvious which sticker goes where even without scanning it.
    pad = 30
    label_h = 90
    w = qr_img.width + pad * 2
    h = qr_img.height + pad * 2 + label_h
    card = Image.new("RGB", (w, h), "white")
    card.paste(qr_img, (pad, pad))
    draw = ImageDraw.Draw(card)

    def load_font(size, bold=True):
        name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
        try:
            return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)
        except Exception:
            return ImageFont.load_default()

    # Shrink the title font until it actually fits the card width — a fixed
    # size clipped "The Common Room (Sofa)" off the edge before this fix.
    max_text_w = w - 16
    title_size = 28
    font_title = load_font(title_size)
    while title_size > 14 and draw.textbbox((0, 0), title, font=font_title)[2] > max_text_w:
        title_size -= 2
        font_title = load_font(title_size)
    font_sub = load_font(18, bold=False)

    ty = pad + qr_img.height + 12
    draw.text((w / 2, ty), title, fill="black", font=font_title, anchor="ma")
    draw.text((w / 2, ty + 36), subtitle, fill="#555555", font=font_sub, anchor="ma")
    return card

def main():
    index_rows = []
    for venue_id, venue in VENUES.items():
        venue_dir = OUT_DIR / venue_id
        venue_dir.mkdir(parents=True, exist_ok=True)
        for node_id, label in venue["nodes"].items():
            payload = f"NAVASSIST:{venue_id}:{node_id}"
            card = make_sticker(payload, label, venue["label"])
            out_path = venue_dir / f"{node_id}.png"
            card.save(out_path)
            index_rows.append((venue["label"], label, str(out_path.relative_to(PROJECT_ROOT))))
            print(f"{payload} -> {out_path}")

    # A simple manifest so it's easy to see what's been generated / re-run diffing.
    (OUT_DIR / "index.json").write_text(json.dumps(
        [{"venue": v, "place": p, "file": f} for v, p, f in index_rows], indent=2
    ))
    print(f"\n{len(index_rows)} QR stickers generated in {OUT_DIR}/")

    make_printable_sheets()

def make_printable_sheets():
    """One PDF per venue, stickers laid out in a grid, ready to print and cut."""
    for venue_id, venue in VENUES.items():
        paths = sorted((OUT_DIR / venue_id).glob("*.png"))
        if not paths:
            continue
        cards = [Image.open(p) for p in paths]
        cols = 2
        cell_w = max(c.width for c in cards) + 40
        cell_h = max(c.height for c in cards) + 40
        rows_per_page = 3
        per_page = cols * rows_per_page
        pages = []
        for start in range(0, len(cards), per_page):
            chunk = cards[start:start + per_page]
            page = Image.new("RGB", (cell_w * cols, cell_h * rows_per_page), "white")
            for i, card in enumerate(chunk):
                x = (i % cols) * cell_w + (cell_w - card.width) // 2
                y = (i // cols) * cell_h + (cell_h - card.height) // 2
                page.paste(card, (x, y))
            pages.append(page)
        out_pdf = OUT_DIR / f"{venue_id}-print-sheet.pdf"
        pages[0].save(out_pdf, save_all=True, append_images=pages[1:])
        print(f"Printable sheet: {out_pdf} ({len(pages)} page(s))")

if __name__ == "__main__":
    main()
