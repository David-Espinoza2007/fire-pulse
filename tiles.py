"""Time tiles: every month of one map area in one small binary file.

    python tiles.py --root data/world --level 1      # build every missing tile of a level

Levels: 1 = 0.25 degree cells in 25 degree tiles, 2 = 0.1 in 10, 3 = 0.05 in 5 (always 100 x 100 cells).
With X = cell_x + 3600 and Y = cell_y + 1800 (0.05 degree cells): tx = X // tf, ty = Y // tf,
col = (X % tf) // f, row = (Y % tf) // f, idx = row * 100 + col.

File (gzip; little-endian after decoding; every block padded to a multiple of 4 bytes):
  uint32 N, then N bytes of JSON {level, tx, ty, cell, side, months, first, nnz, scale, night}
  Uint32[months + 1]  mstart: the entries of month t (0 = November 2000) are [mstart[t], mstart[t + 1])
  Uint16[nnz]         idx, ascending inside each month
  Uint16[nnz]         harm: adjusted detections times scale
  Uint16[nnz]         night: the night part, times scale (zeros when the data has no harm_night)
  Uint16[nnz]         raw: detections as reported by all satellites, not scaled
  Uint16[nnz]         vharm, Uint16[nnz] vnight: VIIRS units (all, night part) times vscale; only when "v" is true
                      (data built before VIIRS units has neither array). vscale = 1, 2, 4 at levels 1, 2, 3: VIIRS counts are ~6 times larger.
An entry exists when any stored value is above 0. Header: {level, tx, ty, cell, side, months, first, nnz, scale, night, v(, vscale)}.
An empty file marks a tile with no entry (the API answers 204).
"""
import argparse
import gzip
import json
import os
import struct
import sys
import threading
import time
from array import array
from pathlib import Path

import duckdb

LEVELS = {1: (5, 500, 4), 2: (2, 200, 10), 3: (1, 100, 20)}   # f (0.05 degree cells per cell side), tf (per tile side), scale
VSCALE = {1: 1, 2: 2, 3: 4}
OX, OY = 3600, 1800
FIRST = (2000, 11)


def tile_path(serve, level, tx, ty):
    return Path(serve) / "tiles" / str(level) / f"{tx}_{ty}.bin.gz"


def _pad(buf):
    return buf + b"\0" * (-len(buf) % 4)


def _u16(values):
    a = array("H", values)
    if sys.byteorder == "big":
        a.byteswap()
    return _pad(a.tobytes())


def build_tile(serve, level, tx, ty):
    """-> the tile as uncompressed bytes, or None when it has no entry."""
    f, tf, scale = LEVELS[level]
    src = f"read_parquet('{(Path(serve) / 'monthly.parquet').as_posix()}')"
    con = duckdb.connect()
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
    night, v = "harm_night" in cols, "vharm" in cols
    last = con.execute(f"SELECT max(month) FROM {src}").fetchone()[0]
    months = (last.year - FIRST[0]) * 12 + last.month - FIRST[1] + 1
    q = lambda col, k=scale: f"least(65535, CAST(round(sum({col}) * {k}) AS INTEGER))"
    rows = con.execute(f"""
      SELECT (year(month) - {FIRST[0]}) * 12 + month(month) - {FIRST[1]} AS t,
             ((cell_y + {OY} - {ty * tf}) // {f}) * 100 + (cell_x + {OX} - {tx * tf}) // {f} AS idx,
             {q('harm')} AS h, {q('harm_night') if night else '0'} AS n,
             least(65535, CAST(sum(raw_terra + raw_aqua + raw_n20 + raw_snpp) AS INTEGER)) AS r{f", {q('vharm', VSCALE[level])} AS vh, {q('vharm_night', VSCALE[level])} AS vn" if v else ""}
      FROM {src} WHERE month >= DATE '{FIRST[0]}-{FIRST[1]}-01' AND cell_y BETWEEN {ty * tf - OY} AND {ty * tf + tf - 1 - OY} AND cell_x BETWEEN {tx * tf - OX} AND {tx * tf + tf - 1 - OX}
      GROUP BY 1, 2 HAVING h > 0 OR n > 0 OR r > 0{" OR vh > 0 OR vn > 0" if v else ""} ORDER BY 1, 2""").fetchall()
    if not rows:
        return None
    t, idx, h, n, r, *vv = zip(*rows)
    start, k = [0] * (months + 1), 0
    for m in range(months):
        while k < len(t) and t[k] <= m:
            k += 1
        start[m + 1] = k
    head = json.dumps({"level": level, "tx": tx, "ty": ty, "cell": 0.05 * f, "side": 100, "months": months,
                       "first": f"{FIRST[0]}-{FIRST[1]:02d}", "nnz": len(rows), "scale": scale, "night": night, "v": v, **({"vscale": VSCALE[level]} if v else {})}).encode()
    a = array("I", start)
    if sys.byteorder == "big":
        a.byteswap()
    return b"".join((_pad(struct.pack("<I", len(head)) + head), a.tobytes(), _u16(idx), _u16(h), _u16(n), _u16(r), *map(_u16, vv)))


def ensure(serve, level, tx, ty):
    """-> path of the cached gzip tile, building it if needed; None when the tile is empty (an empty marker is cached)."""
    path = tile_path(serve, level, tx, ty)
    mp = Path(serve) / "monthly.parquet"
    mt = max(mp.stat().st_mtime, Path(__file__).stat().st_mtime)   # a tile made by older code lacks the newer arrays
    if not (path.exists() and path.stat().st_mtime >= mt):
        blob = build_tile(serve, level, tx, ty)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.part")
        tmp.write_bytes(gzip.compress(blob, 6, mtime=0) if blob else b"")
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:   # Windows: the target is open, by another writer or by the server sending it
                if path.exists() and path.stat().st_mtime >= mt:
                    tmp.unlink(missing_ok=True)   # another writer made the same tile
                    break
                if attempt == 5:
                    tmp.unlink(missing_ok=True)
                    raise
                time.sleep(0.05 * (attempt + 1))
    return path if path.stat().st_size else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", default="data/world")
    p.add_argument("--level", type=int, required=True, choices=LEVELS)
    a = p.parse_args()
    serve = Path(a.root) / "serve"
    f, tf, _ = LEVELS[a.level]
    todo = duckdb.connect().execute(f"""SELECT DISTINCT (cell_x + {OX}) // {tf}, (cell_y + {OY}) // {tf}
        FROM read_parquet('{(serve / 'monthly.parquet').as_posix()}') ORDER BY 1, 2""").fetchall()
    t0 = time.time()
    for i, (tx, ty) in enumerate(todo, 1):
        ensure(serve, a.level, tx, ty)
        if i % 10 == 0 or i == len(todo):
            print(f"level {a.level}: {i}/{len(todo)} tiles, {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
