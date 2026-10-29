"""Fetch CC0 assets from Poly Haven (https://polyhaven.com) for local processing.

  python tools/polyhaven.py model <asset_id> <out_dir> [res]   # glTF + its textures, structure preserved
  python tools/polyhaven.py tex <asset_id> <out_dir> [res]     # diff / nor_gl / arm JPGs
  python tools/polyhaven.py info <asset_id>                    # summary of the glTF scene
"""
import json
import os
import sys
import urllib.request

UA = {"User-Agent": "waterscape-asset-pipeline/1.0"}


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        return r.read()


def files(asset: str) -> dict:
    return json.loads(get(f"https://api.polyhaven.com/files/{asset}"))


def model(asset: str, out: str, res: str = "1k") -> str:
    g = files(asset)["gltf"][res]["gltf"]
    os.makedirs(out, exist_ok=True)
    main = os.path.join(out, os.path.basename(g["url"]))
    with open(main, "wb") as f:
        f.write(get(g["url"]))
    for rel, info in g.get("include", {}).items():
        path = os.path.join(out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) == info["size"]:
            continue
        with open(path, "wb") as f:
            f.write(get(info["url"]))
    return main


def tex(asset: str, out: str, res: str = "1k"):
    d = files(asset)
    os.makedirs(out, exist_ok=True)
    for key, name in (("Diffuse", "diff"), ("nor_gl", "nor"), ("arm", "arm")):
        url = d[key][res]["jpg"]["url"]
        with open(os.path.join(out, f"{asset}_{name}.jpg"), "wb") as f:
            f.write(get(url))


def info(asset: str, res: str = "1k"):
    g = files(asset)["gltf"][res]["gltf"]
    doc = json.loads(get(g["url"]))
    print("nodes:", [n.get("name") for n in doc.get("nodes", [])][:20])
    print("meshes:", [(m.get("name"), len(m["primitives"])) for m in doc.get("meshes", [])][:20])
    print("materials:", [m.get("name") for m in doc.get("materials", [])])
    acc = doc.get("accessors", [])
    tris = 0
    for m in doc.get("meshes", []):
        for p in m["primitives"]:
            if "indices" in p:
                tris += acc[p["indices"]]["count"] // 3
    print("triangles (unique meshes):", tris)


if __name__ == "__main__":
    cmd, asset, *rest = sys.argv[1:]
    if cmd == "model":
        print(model(asset, rest[0], *(rest[1:] or ["1k"])))
    elif cmd == "tex":
        tex(asset, rest[0], *(rest[1:] or ["1k"]))
    else:
        info(asset)
