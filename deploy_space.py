"""Publish FirePulse as a public Hugging Face Docker Space. The data goes to a dataset repository, the code to the Space.
Hugging Face creates a Docker Space only for accounts with a PRO plan (checked 15 Nov 2026: without it the request fails with error 402).

    hf auth login                        # once, with a token that can write
    python deploy_space.py --dry-run     # list what would be sent, send nothing
    python deploy_space.py               # code, serve tables, reference tables
    python deploy_space.py --archive     # also the hotspot archive (day view, detection downloads; several GB)

Run it again after a new build: only changed files are sent, and the Space builds again.
"""
import argparse
import shutil
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
CODE = ("app.py", "harmonize.py", "tiles.py", "pipeline.py", "requirements.txt", "Dockerfile", "static")
CARD = """---
title: FirePulse
emoji: 🔥
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---
FirePulse: satellite fire detections from MODIS and VIIRS in one comparable record, for any country, state or drawn area.
NASA Space Apps 2026. Data: NASA FIRMS.
"""


def data_files(data, archive):
    """The files the server reads, relative to the data folder."""
    keep = [p for p in (data / "world/serve").rglob("*") if p.is_file() and p.suffix != ".part"]
    keep += sorted((data / "reference").glob("*.parquet"))
    if archive:
        keep += sorted((data / "world/hotspots").glob("*/*.parquet"))
    return keep


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="map", help="name of the Space; the data repository is <name>-data")
    ap.add_argument("--data", type=Path, default=HERE / "data", help="folder that holds world/ and reference/")
    ap.add_argument("--archive", action="store_true", help="also send world/hotspots")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    files = data_files(args.data, args.archive)
    if not (args.data / "world/serve/monthly.parquet").exists():
        raise SystemExit(f"No built data in {args.data}/world")
    size = sum(p.stat().st_size for p in files)
    print(f"data: {len(files)} files, {size / 1e9:.2f} GB; code: {', '.join(CODE)}")
    if args.dry_run:
        for sub in ("world/serve", "world/serve/tiles", "reference", "world/hotspots"):
            part = [p for p in files if (args.data / sub) in p.parents]
            print(f"  {sub}: {len(part)} files, {sum(p.stat().st_size for p in part) / 1e9:.2f} GB")
        raise SystemExit
    from huggingface_hub import HfApi
    api = HfApi()
    user = api.whoami()["name"]
    data_id, space_id = f"{user}/{args.name}-data", f"{user}/{args.name}"
    api.create_repo(data_id, repo_type="dataset", exist_ok=True)
    patterns = ["world/serve/**", "reference/*.parquet"] + (["world/hotspots/*/*.parquet"] if args.archive else [])
    api.upload_folder(repo_id=data_id, repo_type="dataset", folder_path=args.data, allow_patterns=patterns, ignore_patterns=["*.part"],
                      delete_patterns=["world/serve/**"],   # tiles of an older build must not stay
                      commit_message="FirePulse data")
    commit = api.dataset_info(data_id).sha
    api.create_repo(space_id, repo_type="space", space_sdk="docker", exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for name in CODE:
            (shutil.copytree if (HERE / name).is_dir() else shutil.copy)(HERE / name, tmp / name)
        (tmp / "Dockerfile").write_bytes((HERE / "Dockerfile").read_bytes().replace(b"\r\n", b"\n"))   # a Windows checkout has CRLF; the Linux build needs LF
        (tmp / "README.md").write_text(CARD, encoding="utf-8")
        (tmp / "DATA_REPO").write_text(f"{data_id}@{commit}\n")
        api.upload_folder(repo_id=space_id, repo_type="space", folder_path=tmp, delete_patterns="*", commit_message="FirePulse")
    print(f"data:  https://huggingface.co/datasets/{data_id} ({commit[:8]})")
    print(f"space: https://huggingface.co/spaces/{space_id}  (the build takes a few minutes)")
