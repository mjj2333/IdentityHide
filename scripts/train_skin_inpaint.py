#!/usr/bin/env python3
"""
Train a U-Net model for skin inpainting (tattoo removal).

This script trains a compact neural network to reconstruct clean skin from
images with synthetic "tattoo-like" damage. The trained model is exported
to ONNX for browser-side inference via ONNX Runtime Web.

RECOMMENDED APPROACH (best quality):
    # Step 1: Export a pre-trained inpainting model (no training data needed)
    python export_lama.py

    # Step 2: Fine-tune on real skin images for skin-specific quality
    python export_lama.py --finetune --data-dir ./skin_photos --epochs 20

ALTERNATIVE (train from scratch, lower quality):
    python train_skin_inpaint.py --data-dir ./training_images --epochs 200

The --data-dir should contain ANY images with visible skin (portraits, body
photos, etc.). The script automatically finds and crops skin regions.
For best results, include 500+ diverse images covering different skin tones,
body parts, and lighting conditions.

Output: public/models/skin-inpaint.onnx (~30MB)
"""

import argparse
import math
import os
import random
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFilter
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms

# ──────────────────────────────────────────────────────────────────────────────
# Model Architecture: Compact U-Net with skip connections
# Input:  [B, 4, 512, 512]  (RGB image + binary mask)
# Output: [B, 3, 512, 512]  (reconstructed RGB)
# ~7M parameters, ~30MB ONNX
# ──────────────────────────────────────────────────────────────────────────────

class ConvBlock(nn.Module):
    """Two conv layers with batch norm and LeakyReLU."""
    def __init__(self, in_ch, out_ch):
        super().__init__()
        self.block = nn.Sequential(
            nn.Conv2d(in_ch, out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.LeakyReLU(0.2, inplace=True),
        )

    def forward(self, x):
        return self.block(x)


class SkinInpaintUNet(nn.Module):
    """U-Net for skin inpainting. 4 encoder levels, bottleneck, 4 decoder levels."""

    def __init__(self):
        super().__init__()
        # Encoder
        self.enc1 = ConvBlock(4, 64)
        self.enc2 = ConvBlock(64, 128)
        self.enc3 = ConvBlock(128, 256)
        self.enc4 = ConvBlock(256, 512)

        # Bottleneck
        self.bottleneck = ConvBlock(512, 1024)

        # Decoder (input channels = skip + upsampled)
        self.up4 = nn.ConvTranspose2d(1024, 512, 2, stride=2)
        self.dec4 = ConvBlock(1024, 512)
        self.up3 = nn.ConvTranspose2d(512, 256, 2, stride=2)
        self.dec3 = ConvBlock(512, 256)
        self.up2 = nn.ConvTranspose2d(256, 128, 2, stride=2)
        self.dec2 = ConvBlock(256, 128)
        self.up1 = nn.ConvTranspose2d(128, 64, 2, stride=2)
        self.dec1 = ConvBlock(128, 64)

        self.final = nn.Conv2d(64, 3, 1)

    def forward(self, x):
        # x: [B, 4, H, W] — RGB (channels 0-2) + mask (channel 3)
        e1 = self.enc1(x)                          # 512 -> 512
        e2 = self.enc2(F.max_pool2d(e1, 2))        # 512 -> 256
        e3 = self.enc3(F.max_pool2d(e2, 2))        # 256 -> 128
        e4 = self.enc4(F.max_pool2d(e3, 2))        # 128 -> 64

        b = self.bottleneck(F.max_pool2d(e4, 2))   # 64 -> 32

        d4 = self.dec4(torch.cat([self.up4(b), e4], dim=1))
        d3 = self.dec3(torch.cat([self.up3(d4), e3], dim=1))
        d2 = self.dec2(torch.cat([self.up2(d3), e2], dim=1))
        d1 = self.dec1(torch.cat([self.up1(d2), e1], dim=1))

        return torch.sigmoid(self.final(d1))


# ──────────────────────────────────────────────────────────────────────────────
# Perceptual Loss (VGG16 features)
# ──────────────────────────────────────────────────────────────────────────────

class PerceptualLoss(nn.Module):
    """Multi-scale perceptual loss using VGG16 features."""

    def __init__(self, device):
        super().__init__()
        from torchvision.models import vgg16, VGG16_Weights
        vgg = vgg16(weights=VGG16_Weights.DEFAULT).features.to(device).eval()
        for p in vgg.parameters():
            p.requires_grad = False

        # Extract features at relu1_2, relu2_2, relu3_3
        self.slices = nn.ModuleList([
            vgg[:4],   # relu1_2
            vgg[4:9],  # relu2_2
            vgg[9:16], # relu3_3
        ])
        self.weights = [1.0, 0.5, 0.25]

    def forward(self, pred, target):
        loss = 0
        x, y = pred, target
        for sl, w in zip(self.slices, self.weights):
            x = sl(x)
            y = sl(y)
            loss += w * F.l1_loss(x, y)
        return loss


# ──────────────────────────────────────────────────────────────────────────────
# Synthetic Tattoo Damage Generator
# ──────────────────────────────────────────────────────────────────────────────

def is_skin_pixel(r, g, b):
    """HSV-based skin detection heuristic."""
    brightness = r * 0.299 + g * 0.587 + b * 0.114
    if brightness < 25 or brightness > 240:
        return False
    if b > r + 40 or g > r + 40:
        return False
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == 0:
        return False
    sat = (mx - mn) / mx
    if sat > 0.8:
        return False
    delta = mx - mn
    if delta > 0:
        if mx == r:
            hue = 60 * (((g - b) / delta) % 6)
        elif mx == g:
            hue = 60 * ((b - r) / delta + 2)
        else:
            hue = 60 * ((r - g) / delta + 4)
        if hue < 0:
            hue += 360
        if 55 < hue < 320:
            return False
    return True


def find_skin_region(img, target_size=512):
    """Find the largest skin region in an image and crop a square patch."""
    arr = np.array(img)
    h, w = arr.shape[:2]
    if h < target_size // 2 or w < target_size // 2:
        return None

    # Downsample for speed
    scale = max(1, min(h, w) // 200)
    small = arr[::scale, ::scale]
    sh, sw = small.shape[:2]

    # Build skin mask
    skin = np.zeros((sh, sw), dtype=bool)
    for y in range(sh):
        for x in range(sw):
            r, g, b = int(small[y, x, 0]), int(small[y, x, 1]), int(small[y, x, 2])
            skin[y, x] = is_skin_pixel(r, g, b)

    # Find densest skin region using sliding window
    patch = target_size // scale
    if patch > sh or patch > sw:
        patch = min(sh, sw)

    best_score, best_pos = 0, None
    step = max(1, patch // 4)
    for y in range(0, sh - patch + 1, step):
        for x in range(0, sw - patch + 1, step):
            score = skin[y:y + patch, x:x + patch].sum()
            if score > best_score:
                best_score = score
                best_pos = (y * scale, x * scale)

    if best_score < (patch * patch * 0.3):
        return None  # Not enough skin

    cy, cx = best_pos
    # Crop from full-res image
    half = target_size // 2
    cy = max(half, min(h - half, cy + half))
    cx = max(half, min(w - half, cx + half))
    crop = img.crop((cx - half, cy - half, cx + half, cy + half))
    return crop.resize((target_size, target_size), Image.LANCZOS)


def random_bezier_points(n=4):
    """Generate random control points for a Bezier curve."""
    return [(random.random(), random.random()) for _ in range(n)]


def bezier_point(points, t):
    """Evaluate a Bezier curve at parameter t using De Casteljau's algorithm."""
    while len(points) > 1:
        points = [
            (p0[0] * (1 - t) + p1[0] * t, p0[1] * (1 - t) + p1[1] * t)
            for p0, p1 in zip(points[:-1], points[1:])
        ]
    return points[0]


def generate_tattoo_damage(size=512):
    """
    Generate a synthetic tattoo-like overlay and its mask.
    Returns (overlay_image, mask_image) as PIL Images.
    """
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    draw_overlay = ImageDraw.Draw(overlay)
    draw_mask = ImageDraw.Draw(mask)

    # Random ink color (dark blues, blacks, reds, greens — common tattoo colors)
    ink_palettes = [
        (20, 30, 60),    # dark blue
        (10, 10, 10),    # black
        (60, 15, 15),    # dark red
        (15, 45, 25),    # dark green
        (40, 20, 50),    # purple
        (30, 30, 30),    # dark gray
        (10, 40, 70),    # blue
    ]

    num_elements = random.randint(3, 12)

    for _ in range(num_elements):
        ink = random.choice(ink_palettes)
        alpha = random.randint(140, 230)
        element_type = random.choice(["curve", "blob", "lines", "fill"])

        if element_type == "curve":
            # Bezier curve strokes
            points = random_bezier_points(random.randint(3, 6))
            width = random.randint(3, max(4, size // 30))
            pts = []
            for t in [i / 60.0 for i in range(61)]:
                px, py = bezier_point(points, t)
                pts.append((int(px * size), int(py * size)))
            for j in range(len(pts) - 1):
                draw_overlay.line([pts[j], pts[j + 1]], fill=(*ink, alpha), width=width)
                draw_mask.line([pts[j], pts[j + 1]], fill=255, width=width)

        elif element_type == "blob":
            # Filled irregular shape
            n_pts = random.randint(5, 10)
            cx, cy = random.random() * size, random.random() * size
            r = random.randint(size // 15, size // 4)
            pts = []
            for k in range(n_pts):
                angle = 2 * math.pi * k / n_pts
                rr = r * (0.6 + 0.4 * random.random())
                pts.append((int(cx + rr * math.cos(angle)), int(cy + rr * math.sin(angle))))
            draw_overlay.polygon(pts, fill=(*ink, alpha))
            draw_mask.polygon(pts, fill=255)

        elif element_type == "lines":
            # Parallel or crossing lines
            n_lines = random.randint(2, 6)
            base_angle = random.random() * math.pi
            for _ in range(n_lines):
                angle = base_angle + random.gauss(0, 0.2)
                cx = random.random() * size
                cy = random.random() * size
                length = random.randint(size // 6, size // 2)
                width = random.randint(2, max(3, size // 40))
                x1 = int(cx - length * math.cos(angle) / 2)
                y1 = int(cy - length * math.sin(angle) / 2)
                x2 = int(cx + length * math.cos(angle) / 2)
                y2 = int(cy + length * math.sin(angle) / 2)
                draw_overlay.line([(x1, y1), (x2, y2)], fill=(*ink, alpha), width=width)
                draw_mask.line([(x1, y1), (x2, y2)], fill=255, width=width)

        elif element_type == "fill":
            # Large filled region
            x1 = random.randint(0, size // 2)
            y1 = random.randint(0, size // 2)
            x2 = x1 + random.randint(size // 4, size // 2)
            y2 = y1 + random.randint(size // 4, size // 2)
            draw_overlay.ellipse([(x1, y1), (x2, y2)], fill=(*ink, alpha))
            draw_mask.ellipse([(x1, y1), (x2, y2)], fill=255)

    # Blur overlay slightly for more realistic ink edges
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=random.uniform(0.5, 2.0)))
    # Dilate mask slightly to fully cover the overlay
    mask = mask.filter(ImageFilter.MaxFilter(5))

    return overlay, mask


class SkinInpaintDataset(Dataset):
    """
    Dataset that loads images, finds skin regions, and applies synthetic damage.
    Each item returns (damaged_input, clean_target, mask).
    """

    def __init__(self, image_dir, target_size=512, augment=True):
        self.target_size = target_size
        self.augment = augment

        # Find all image files
        exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
        self.image_paths = []
        for p in Path(image_dir).rglob("*"):
            if p.suffix.lower() in exts:
                self.image_paths.append(str(p))

        if not self.image_paths:
            raise ValueError(f"No images found in {image_dir}")

        print(f"Found {len(self.image_paths)} images in {image_dir}")

        # Pre-extract skin patches (cache to avoid re-scanning every epoch)
        print("Scanning for skin regions...")
        self.patches = []
        for i, path in enumerate(self.image_paths):
            try:
                img = Image.open(path).convert("RGB")
                patch = find_skin_region(img, target_size)
                if patch is not None:
                    self.patches.append(patch)
            except Exception:
                pass
            if (i + 1) % 50 == 0:
                print(f"  Scanned {i + 1}/{len(self.image_paths)}, found {len(self.patches)} skin patches")

        if not self.patches:
            raise ValueError("No skin regions found in any images. Use images with visible skin.")

        print(f"Extracted {len(self.patches)} skin patches")

        self.to_tensor = transforms.ToTensor()

    def __len__(self):
        return max(len(self.patches) * 4, 800)  # Oversample for variety

    def __getitem__(self, idx):
        # Pick a random skin patch
        patch = self.patches[idx % len(self.patches)].copy()

        # Augmentation
        if self.augment:
            if random.random() > 0.5:
                patch = patch.transpose(Image.FLIP_LEFT_RIGHT)
            if random.random() > 0.5:
                patch = patch.transpose(Image.FLIP_TOP_BOTTOM)
            angle = random.choice([0, 90, 180, 270])
            if angle:
                patch = patch.rotate(angle, expand=False)
            # Color jitter
            from torchvision.transforms import ColorJitter
            jitter = ColorJitter(brightness=0.15, contrast=0.15, saturation=0.1, hue=0.02)
            patch = jitter(patch)

        # Generate synthetic damage
        overlay, mask = generate_tattoo_damage(self.target_size)

        # Create damaged version
        damaged = patch.copy()
        damaged.paste(overlay, (0, 0), overlay)

        # Convert to tensors
        clean_t = self.to_tensor(patch)            # [3, H, W], range [0, 1]
        damaged_t = self.to_tensor(damaged)         # [3, H, W]
        mask_t = self.to_tensor(mask)               # [1, H, W], range [0, 1]

        # Model input: damaged RGB + mask (4 channels)
        # In masked regions, replace with neutral gray to help the model
        input_t = damaged_t.clone()
        input_t = input_t * (1 - mask_t) + 0.5 * mask_t  # Gray fill in mask
        input_t = torch.cat([input_t, mask_t], dim=0)     # [4, H, W]

        return input_t, clean_t, mask_t


# ──────────────────────────────────────────────────────────────────────────────
# Training Loop
# ──────────────────────────────────────────────────────────────────────────────

def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    # Dataset
    dataset = SkinInpaintDataset(args.data_dir, target_size=512)
    loader = DataLoader(
        dataset, batch_size=args.batch_size, shuffle=True,
        num_workers=args.workers, pin_memory=True, drop_last=True,
    )

    # Model
    model = SkinInpaintUNet().to(device)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {param_count:,} ({param_count * 4 / 1e6:.1f} MB float32)")

    # Losses
    l1_loss = nn.L1Loss()
    perceptual_loss = PerceptualLoss(device) if not args.no_perceptual else None

    # Optimizer
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_loss = float("inf")

    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_loss = 0
        n_batches = 0

        for batch_idx, (input_t, target_t, mask_t) in enumerate(loader):
            input_t = input_t.to(device)
            target_t = target_t.to(device)
            mask_t = mask_t.to(device)

            # Forward
            pred = model(input_t)

            # Losses — focus on masked region but also penalize unmasked (context)
            # Masked region loss (primary)
            mask_loss = l1_loss(pred * mask_t, target_t * mask_t)
            # Full image loss (keeps unmasked regions stable)
            full_loss = l1_loss(pred, target_t)
            # Perceptual loss
            perc_loss = perceptual_loss(pred, target_t) if perceptual_loss else 0

            loss = mask_loss * 3.0 + full_loss * 1.0 + perc_loss * 0.5

            # Backward
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            epoch_loss += loss.item()
            n_batches += 1

            if (batch_idx + 1) % 20 == 0:
                print(f"  Epoch {epoch}/{args.epochs}, batch {batch_idx + 1}/{len(loader)}, "
                      f"loss: {loss.item():.4f} (mask: {mask_loss.item():.4f}, "
                      f"full: {full_loss.item():.4f})")

        avg_loss = epoch_loss / max(n_batches, 1)
        scheduler.step()
        print(f"Epoch {epoch}/{args.epochs} — avg loss: {avg_loss:.4f}, lr: {scheduler.get_last_lr()[0]:.6f}")

        # Save best model
        if avg_loss < best_loss:
            best_loss = avg_loss
            torch.save(model.state_dict(), args.checkpoint)
            print(f"  Saved checkpoint (best loss: {best_loss:.4f})")

        # Save ONNX every 10 epochs
        if epoch % 10 == 0 or epoch == args.epochs:
            export_onnx(model, args.output, device)

    print(f"\nTraining complete. Best loss: {best_loss:.4f}")
    print(f"ONNX model saved to: {args.output}")


# ──────────────────────────────────────────────────────────────────────────────
# ONNX Export
# ──────────────────────────────────────────────────────────────────────────────

def export_onnx(model, output_path, device):
    """Export trained model to ONNX format for browser inference."""
    model.eval()
    dummy_input = torch.randn(1, 4, 512, 512).to(device)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        opset_version=17,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={
            "input": {2: "height", 3: "width"},
            "output": {2: "height", 3: "width"},
        },
    )

    size_mb = os.path.getsize(output_path) / 1e6
    print(f"  Exported ONNX model: {output_path} ({size_mb:.1f} MB)")


# ──────────────────────────────────────────────────────────────────────────────
# Entry Point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train skin inpainting model for tattoo removal")
    parser.add_argument("--data-dir", required=True, help="Directory containing training images (any photos with skin)")
    parser.add_argument("--output", default="public/models/skin-inpaint.onnx", help="Output ONNX model path")
    parser.add_argument("--checkpoint", default="skin_inpaint_best.pth", help="PyTorch checkpoint path")
    parser.add_argument("--epochs", type=int, default=200, help="Number of training epochs")
    parser.add_argument("--batch-size", type=int, default=4, help="Batch size (reduce if OOM)")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    parser.add_argument("--workers", type=int, default=4, help="Data loader workers")
    parser.add_argument("--no-perceptual", action="store_true", help="Disable perceptual loss (faster, lower quality)")
    parser.add_argument("--export-only", type=str, help="Export existing checkpoint to ONNX (skip training)")
    args = parser.parse_args()

    if args.export_only:
        model = SkinInpaintUNet()
        model.load_state_dict(torch.load(args.export_only, map_location="cpu"))
        export_onnx(model, args.output, torch.device("cpu"))
        return

    train(args)


if __name__ == "__main__":
    main()
