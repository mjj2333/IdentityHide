#!/usr/bin/env python3
"""
Download skin crops from COCO dataset for training the inpainting model.

Downloads person bounding boxes from COCO 2017 val set, crops them,
and filters for visible skin using HSV color detection. Only keeps
crops where ≥25% of pixels are skin-colored.

Usage:
    pip install pycocotools Pillow numpy requests
    python download_skin_crops.py --output ./skin_photos --count 1000

This downloads the COCO val2017 annotations (~1MB), then fetches
individual images on demand — no need to download the full 19GB dataset.
"""

import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image


def download_annotations(cache_dir):
    """Download COCO 2017 val annotations if not cached."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    ann_path = cache_dir / "annotations" / "instances_val2017.json"
    if ann_path.exists():
        print(f"Annotations cached: {ann_path}")
        return ann_path

    zip_url = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
    zip_path = cache_dir / "annotations_trainval2017.zip"

    if not zip_path.exists():
        print("Downloading COCO annotations (~252MB, one-time)...")
        # Use curl for reliable fast download with progress
        import subprocess
        result = subprocess.run(
            ["curl", "-L", "-o", str(zip_path), "--progress-bar", zip_url],
            check=False,
        )
        if result.returncode != 0 or not zip_path.exists():
            print("curl failed, trying wget...")
            result = subprocess.run(
                ["wget", "-O", str(zip_path), "--show-progress", zip_url],
                check=False,
            )
        if not zip_path.exists():
            print("ERROR: Download failed. Please manually download:")
            print(f"  {zip_url}")
            print(f"  Save to: {zip_path}")
            sys.exit(1)

    print("Extracting annotations...")
    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(cache_dir)

    if ann_path.exists():
        return ann_path

    # Fallback: try train annotations
    train_path = cache_dir / "annotations" / "instances_train2017.json"
    if train_path.exists():
        return train_path

    print("ERROR: Could not find annotation files after extraction.")
    sys.exit(1)


def is_skin_pixel(r, g, b):
    """Check if an RGB pixel looks like skin using HSV heuristics."""
    # Convert to HSV manually (avoid per-pixel PIL overhead)
    r_, g_, b_ = r / 255.0, g / 255.0, b / 255.0
    cmax = max(r_, g_, b_)
    cmin = min(r_, g_, b_)
    diff = cmax - cmin

    # Brightness check
    if cmax < 0.10 or cmax > 0.95:
        return False

    # Saturation
    sat = 0 if cmax == 0 else diff / cmax
    if sat > 0.75:
        return False

    # Hue
    if diff < 0.001:
        return True  # Gray-ish, could be skin in shadow

    if cmax == r_:
        hue = 60 * ((g_ - b_) / diff % 6)
    elif cmax == g_:
        hue = 60 * ((b_ - r_) / diff + 2)
    else:
        hue = 60 * ((r_ - g_) / diff + 4)

    if hue < 0:
        hue += 360

    # Skin hue range: warm tones (0-55) or wrapping around (320-360)
    return (0 <= hue <= 55) or (320 <= hue <= 360)


def compute_skin_ratio(img_array):
    """Compute fraction of pixels that are skin-colored. Uses vectorized HSV."""
    if img_array.shape[2] == 4:
        img_array = img_array[:, :, :3]

    r, g, b = img_array[:, :, 0], img_array[:, :, 1], img_array[:, :, 2]
    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0

    cmax = np.maximum(np.maximum(rf, gf), bf)
    cmin = np.minimum(np.minimum(rf, gf), bf)
    diff = cmax - cmin

    # Brightness mask
    bright_ok = (cmax >= 0.10) & (cmax <= 0.95)

    # Saturation mask
    sat = np.where(cmax > 0, diff / cmax, 0)
    sat_ok = sat <= 0.75

    # Hue computation
    hue = np.zeros_like(rf)
    mask_r = (cmax == rf) & (diff > 0.001)
    mask_g = (cmax == gf) & (diff > 0.001) & ~mask_r
    mask_b = (diff > 0.001) & ~mask_r & ~mask_g

    hue[mask_r] = 60 * ((gf[mask_r] - bf[mask_r]) / diff[mask_r] % 6)
    hue[mask_g] = 60 * ((bf[mask_g] - rf[mask_g]) / diff[mask_g] + 2)
    hue[mask_b] = 60 * ((rf[mask_b] - gf[mask_b]) / diff[mask_b] + 4)
    hue[hue < 0] += 360

    # Gray pixels (low diff) count as potential skin
    gray_ok = diff < 0.001
    hue_ok = ((hue >= 0) & (hue <= 55)) | ((hue >= 320) & (hue <= 360)) | gray_ok

    skin_mask = bright_ok & sat_ok & hue_ok
    return np.mean(skin_mask)


def download_image(url):
    """Download an image from URL and return as PIL Image."""
    import io
    import requests
    try:
        resp = requests.get(url, timeout=10, stream=True)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="Download skin crops from COCO")
    parser.add_argument("--output", default="./skin_photos", help="Output directory")
    parser.add_argument("--count", type=int, default=1000, help="Target number of crops")
    parser.add_argument("--cache-dir", default="./coco_cache", help="Cache for annotations")
    parser.add_argument("--min-skin", type=float, default=0.25, help="Min skin pixel ratio (0-1)")
    parser.add_argument("--min-size", type=int, default=128, help="Min crop dimension in pixels")
    parser.add_argument("--target-size", type=int, default=512, help="Resize crops to this size")
    parser.add_argument("--use-train", action="store_true", help="Use train2017 (more images, slower)")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check how many we already have
    existing = list(output_dir.glob("*.jpg")) + list(output_dir.glob("*.png"))
    if len(existing) >= args.count:
        print(f"Already have {len(existing)} images in {output_dir}, target is {args.count}. Done!")
        return

    # Download annotations
    ann_path = download_annotations(args.cache_dir)

    # Also try train set if requested
    split = "train2017" if args.use_train else "val2017"
    if args.use_train:
        train_ann = Path(args.cache_dir) / "annotations" / "instances_train2017.json"
        if train_ann.exists():
            ann_path = train_ann

    print(f"Loading annotations from {ann_path}...")
    with open(ann_path) as f:
        coco_data = json.load(f)

    # Build image lookup
    images_by_id = {img["id"]: img for img in coco_data["images"]}

    # Filter person annotations (category_id=1) with decent bounding boxes
    person_anns = [
        a for a in coco_data["annotations"]
        if a["category_id"] == 1
        and a.get("bbox")
        and a["bbox"][2] >= args.min_size
        and a["bbox"][3] >= args.min_size
        and not a.get("iscrowd", 0)
    ]

    print(f"Found {len(person_anns)} person annotations with bbox >= {args.min_size}px")

    # Shuffle for variety
    import random
    random.shuffle(person_anns)

    saved = len(existing)
    downloaded_images = {}  # Cache: image_id -> PIL Image
    skipped_skin = 0
    skipped_download = 0
    checked = 0

    print(f"\nDownloading and filtering skin crops (target: {args.count})...\n")

    for ann in person_anns:
        if saved >= args.count:
            break

        img_id = ann["image_id"]
        img_info = images_by_id.get(img_id)
        if not img_info:
            continue

        # Download image if not cached
        if img_id not in downloaded_images:
            url = img_info.get("coco_url", "")
            if not url:
                continue
            img = download_image(url)
            if img is None:
                skipped_download += 1
                downloaded_images[img_id] = None
                continue
            downloaded_images[img_id] = img
        else:
            img = downloaded_images[img_id]
            if img is None:
                continue

        # Crop to bounding box with some margin
        x, y, w, h = ann["bbox"]
        img_w, img_h = img.size

        # Add 10% margin for context
        margin_x = int(w * 0.1)
        margin_y = int(h * 0.1)
        x0 = max(0, int(x) - margin_x)
        y0 = max(0, int(y) - margin_y)
        x1 = min(img_w, int(x + w) + margin_x)
        y1 = min(img_h, int(y + h) + margin_y)

        crop = img.crop((x0, y0, x1, y1))

        # Check skin ratio
        crop_arr = np.array(crop)
        skin_ratio = compute_skin_ratio(crop_arr)
        checked += 1

        if skin_ratio < args.min_skin:
            skipped_skin += 1
            if checked % 100 == 0:
                print(f"  Checked {checked} crops, saved {saved}, "
                      f"skipped {skipped_skin} (low skin), {skipped_download} (download fail)")
            continue

        # Resize to target size (maintain aspect ratio, pad if needed)
        crop = crop.resize((args.target_size, args.target_size), Image.LANCZOS)

        # Save
        out_path = output_dir / f"skin_{saved:04d}.jpg"
        crop.save(out_path, "JPEG", quality=90)
        saved += 1

        if saved % 50 == 0:
            print(f"  Saved {saved}/{args.count} crops "
                  f"(checked {checked}, skipped {skipped_skin} low-skin)")

        # Free memory: remove cached images we've fully processed
        if len(downloaded_images) > 200:
            downloaded_images.clear()

    print(f"\nDone! Saved {saved} skin crops to {output_dir}")
    print(f"  Checked: {checked} crops")
    print(f"  Skipped (low skin): {skipped_skin}")
    print(f"  Skipped (download fail): {skipped_download}")

    if saved < args.count:
        if not args.use_train:
            print(f"\nOnly got {saved}/{args.count}. Re-run with --use-train to use the larger training set.")
        else:
            print(f"\nOnly got {saved}/{args.count}. Try lowering --min-skin threshold.")


if __name__ == "__main__":
    main()
