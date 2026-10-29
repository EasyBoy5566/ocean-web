"""Turns downloaded Poly Haven assets into web-ready files under public/assets.

  python tools/process_assets.py <ph_dir>

<ph_dir> contains tex/ (from `polyhaven.py tex`), models/ (from `polyhaven.py model`)
and baked/ (from `tools/bake.mjs`). Outputs:
  public/media/tex/<id>_albedo.jpg   colour with ambient occlusion folded in (sRGB)
  public/media/tex/<id>_nrm.jpg      RG = OpenGL normal, B = roughness (linear, 4:4:4)
  public/media/models/<id>.glb       simplified, meshopt-compressed, WebP textures
  public/media/trees/<name>_{color,normal}.webp + trees.json
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageChops, ImageFilter

PH = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "media")
TEX_SIZE = 1024

# id -> simplification error (fraction of the mesh extent) and texture size
MODELS = {
    "rock_moss_set_01": (0.004, 1024),
    "rock_moss_set_02": (0.004, 1024),
    "coast_rocks_03": (0.004, 1024),
    "coast_land_rocks_04": (0.004, 1024),
    "fern_02": (0.002, 512),
    "grass_medium_01": (0.003, 512),
    "grass_medium_02": (0.003, 512),
    "shrub_04": (0.003, 512),
}


def textures():
    src = os.path.join(PH, "tex")
    dst = os.path.join(OUT, "tex")
    os.makedirs(dst, exist_ok=True)
    ids = sorted({f.rsplit("_", 1)[0] for f in os.listdir(src) if f.endswith("_diff.jpg")})
    for tid in ids:
        diff = Image.open(os.path.join(src, f"{tid}_diff.jpg")).convert("RGB").resize((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
        arm = Image.open(os.path.join(src, f"{tid}_arm.jpg")).convert("RGB").resize((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
        nor = Image.open(os.path.join(src, f"{tid}_nor.jpg")).convert("RGB").resize((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
        ao, rough, _ = arm.split()
        # fold 70% of the occlusion into the colour: crevices stay dark under any light
        ao_soft = ao.point(lambda v: int(255 * (0.3 + 0.7 * v / 255)))
        albedo = ImageChops.multiply(diff, Image.merge("RGB", (ao_soft, ao_soft, ao_soft)))
        albedo.save(os.path.join(dst, f"{tid}_albedo.jpg"), quality=86, optimize=True)
        nr, ng, _ = nor.split()
        Image.merge("RGB", (nr, ng, rough)).save(os.path.join(dst, f"{tid}_nrm.jpg"), quality=92, subsampling=0, optimize=True)
        print("texture", tid)


def models():
    dst = os.path.join(OUT, "models")
    os.makedirs(dst, exist_ok=True)
    cli = os.path.join(os.path.dirname(__file__), "..", "node_modules", ".bin", "gltf-transform.cmd" if os.name == "nt" else "gltf-transform")
    for mid, (err, size) in MODELS.items():
        src = os.path.join(PH, "models", mid, f"{mid}_1k.gltf")
        if not os.path.exists(src):
            print("missing", mid)
            continue
        out = os.path.join(dst, f"{mid}.glb")
        subprocess.run(
            [cli, "optimize", src, out, "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", str(size),
             "--simplify-error", str(err), "--flatten", "false", "--join", "false", "--instance", "false", "--palette", "false"],
            check=True,
        )
        print("model", mid, os.path.getsize(out) // 1024, "KB")


def trees():
    src = os.path.join(PH, "baked")
    dst = os.path.join(OUT, "trees")
    if not os.path.isdir(src):
        print("no baked trees")
        return
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(src):
        if f.endswith(".png"):
            im = Image.open(os.path.join(src, f)).convert("RGBA")
            if f.endswith("_color.png"):
                # bleed colour into transparent texels (normalised blur of premultiplied colour)
                # so mipmapped edges keep the foliage colour instead of fringing black
                a = np.asarray(im, dtype=np.float32) / 255.0
                alpha = a[..., 3:4]
                prem = Image.fromarray((a[..., :3] * alpha * 255).astype(np.uint8))
                blur_c = np.asarray(prem.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32) / 255.0
                blur_a = np.asarray(Image.fromarray((alpha[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)[..., None] / 255.0
                fill = blur_c / np.maximum(blur_a, 1e-3)
                rgb = a[..., :3] * alpha + np.clip(fill, 0, 1) * (1 - alpha)
                out = np.concatenate([rgb, alpha], axis=-1)
                im = Image.fromarray((out * 255).round().astype(np.uint8), "RGBA")
            im.save(os.path.join(dst, f.replace(".png", ".webp")), quality=88, method=6)
    shutil.copy(os.path.join(src, "trees.json"), os.path.join(dst, "trees.json"))
    print("trees", json.load(open(os.path.join(dst, "trees.json"))).keys())


if __name__ == "__main__":
    textures()
    models()
    trees()
