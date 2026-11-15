"""Download, clean and harmonize FIRMS hotspots.

    python pipeline.py --root data/mx --countries Mexico     # quick first pass
    python pipeline.py --root data/world                     # every country
    python pipeline.py --root data/world --trust-only        # only serve/trust.json, from the tables already built
    python pipeline.py --root data/world --sensors modis viirs-jpss1 viirs-snpp --api-zip firms_2026_api.zip --api-end 2026-11-01   # add the current year

Steps are resumable: a year that already has its Parquet file is skipped.
"""
import argparse
import datetime
import gzip
import json
import os
import re
import shutil
import struct
from array import array
import urllib.request
import zipfile
from pathlib import Path

import duckdb

import harmonize as H

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country/zips"
ZIPS = Path("data/zips")
SENSORS = {"modis": ("Terra", "Aqua"), "viirs-jpss1": ("N20",), "viirs-snpp": ("SNPP",)}
YEARS = {"modis": range(2000, 2026), "viirs-jpss1": range(2018, 2026), "viirs-snpp": range(2012, 2026)}
OVERLAP_END = 2021   # last year with a stable Aqua orbit
GAP_MIN = 200        # Terra pixels per day needed before a day is checked for an Aqua outage
MONTH = "CAST(date_trunc('month', local_date) AS DATE) AS month"


def connect(root, path=":memory:"):
    con = duckdb.connect(str(path))
    con.execute(f"SET memory_limit = '{os.environ.get('FIRE_MEM', '8GB')}'; SET preserve_insertion_order = false; SET enable_progress_bar = false; "
                f"SET temp_directory = '{(root / 'tmp_duck').as_posix()}'")
    return con


def copy_to(con, sql, out):
    """Write a query to Parquet through a .part file, so a crash never leaves a half file behind."""
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_suffix(".part")
    con.execute(f"COPY ({sql}) TO '{part.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
    os.replace(part, out)


def ingest(root, sensor, year, countries=None, delete_zip=False):
    """Yearly FIRMS zip -> hotspots/{sensor}/{year}.parquet with the columns the app needs."""
    out = root / "hotspots" / sensor / f"{year}.parquet"
    if out.exists():
        return
    zpath = ZIPS / f"{sensor}_{year}_all_countries.zip"
    if not zpath.exists():
        ZIPS.mkdir(parents=True, exist_ok=True)
        print("download", zpath.name, flush=True)
        urllib.request.urlretrieve(f"{BASE}/{zpath.name}", zpath.with_suffix(".part"))
        os.replace(zpath.with_suffix(".part"), zpath)
    tmp = root / "tmp" / f"{sensor}_{year}"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    prefix = f"{sensor}_{year}_"
    with zipfile.ZipFile(zpath) as z:
        for member in z.namelist():
            name = Path(member).name   # base name only: a zip entry can never be written outside tmp
            if not (name.startswith(prefix) and name.endswith(".csv")):
                continue
            if countries and name[len(prefix):-4].replace("_", " ").lower() not in countries:
                continue
            with z.open(member) as src, open(tmp / name, "wb") as dst:
                shutil.copyfileobj(src, dst)
    if any(tmp.iterdir()):
        print("ingest", sensor, year, flush=True)
        copy_to(connect(root), f"""
          SELECT CAST(latitude AS FLOAT) AS latitude, CAST(longitude AS FLOAT) AS longitude, acq_date,
                 CAST(acq_time AS SMALLINT) AS acq_time,
                 CASE satellite WHEN 'T' THEN 'Terra' WHEN 'A' THEN 'Aqua' WHEN 'N' THEN 'SNPP' ELSE satellite END AS satellite,
                 confidence, CAST(frp AS FLOAT) AS frp, daynight, CAST(type AS TINYINT) AS type,
                 replace(regexp_extract(filename, '_\\d{{4}}_(.+)\\.csv$', 1), '_', ' ') AS country
          FROM read_csv('{tmp.as_posix()}/*.csv', filename = true, union_by_name = true,
                        types = {{'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'confidence': 'VARCHAR',
                                  'satellite': 'VARCHAR', 'version': 'VARCHAR', 'daynight': 'VARCHAR'}})
          ORDER BY CAST(floor(latitude) AS INT), longitude""", out)
    shutil.rmtree(tmp)
    if delete_zip:
        zpath.unlink()


API_DIRS = {"modis": "modis", "viirs-snpp": "viirs-snpp", "viirs-noaa20": "viirs-jpss1"}   # folder in the zip -> our sensor name


def ingest_api(root, zpath, end):
    """A zip of daily world files from the FIRMS API (<sensor>/<SP|NRT>/YYYY-MM-DD.csv) -> hotspots/{sensor}/{year}.parquet,
    for the year the yearly country files do not hold yet. Only local solar dates before `end` are kept, so the record ends on a whole month.
    These files have no country and include the sea. The country comes from the 0.05 degree cell of the earlier years
    (serve/cell_country.parquet), or else from the most common country of its 0.5 degree cell; detections with neither are dropped.
    NRT files have no type column. Their detections get type 2 in a cell known for static sources: serve/static.parquet
    with reason 'type', and cells where the SP files of this zip are mostly static sources (this covers the sea)."""
    tmp = root / "tmp" / "api"
    shutil.rmtree(tmp, ignore_errors=True)
    years = set()
    with zipfile.ZipFile(zpath) as z:
        for member in z.namelist():
            m = re.fullmatch(r"(?:[^/]+/)?([a-z0-9-]+)/(SP|NRT)/((\d{4})-\d{2}-\d{2})\.csv", member)
            if not (m and m[1] in API_DIRS):
                continue
            years.add(int(m[4]))
            (tmp / API_DIRS[m[1]]).mkdir(parents=True, exist_ok=True)   # the name is built from the checked parts: never outside tmp
            with z.open(member) as src, open(tmp / API_DIRS[m[1]] / f"{m[2]}_{m[3]}.csv", "wb") as dst:
                shutil.copyfileobj(src, dst)
    if len(years) != 1:
        raise SystemExit(f"{zpath}: expected daily files of one year, found {sorted(years)}")
    year, serve, con = years.pop(), (root / "serve").as_posix(), connect(root)
    for i, sensor in enumerate(sorted(p.name for p in tmp.iterdir())):
        con.execute(("INSERT INTO api " if i else "CREATE TABLE api AS ") + f"""
          SELECT '{sensor}' AS sensor, CAST(latitude AS FLOAT) AS latitude, CAST(longitude AS FLOAT) AS longitude, acq_date,
                 CAST(acq_time AS SMALLINT) AS acq_time,
                 CASE satellite WHEN 'T' THEN 'Terra' WHEN 'A' THEN 'Aqua' WHEN 'N' THEN 'SNPP' ELSE satellite END AS satellite,
                 confidence, CAST(frp AS FLOAT) AS frp, daynight, CAST(type AS TINYINT) AS type
          FROM read_csv('{(tmp / sensor).as_posix()}/*.csv', union_by_name = true,
                        types = {{'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'confidence': 'VARCHAR',
                                  'satellite': 'VARCHAR', 'version': 'VARCHAR', 'daynight': 'VARCHAR'}})
          WHERE CAST(acq_date + to_minutes(CAST(CAST(acq_time AS INT) // 100 * 60 + CAST(acq_time AS INT) % 100
                                                + round(longitude * 4) AS BIGINT)) AS DATE) < DATE '{end}'""")
    cell = f"CAST(floor(longitude / {H.CELL}) AS INT) AS cell_x, CAST(floor(latitude / {H.CELL}) AS INT) AS cell_y"
    con.execute(f"""CREATE TABLE st AS
      SELECT cell_x, cell_y FROM read_parquet('{serve}/static.parquet') WHERE reason = 'type'
      UNION SELECT cell_x, cell_y FROM (SELECT {cell}, type FROM api WHERE type IS NOT NULL) GROUP BY ALL
            HAVING count(*) FILTER (type <> 0) >= 20 AND 2 * count(*) FILTER (type <> 0) >= count(*)""")
    con.execute(f"""CREATE TABLE cc10 AS SELECT gx, gy, arg_max(country, n) AS country
      FROM (SELECT CAST(floor(cell_x / 10.0) AS INT) AS gx, CAST(floor(cell_y / 10.0) AS INT) AS gy, country, count(*) AS n
            FROM read_parquet('{serve}/cell_country.parquet') WHERE country IS NOT NULL GROUP BY ALL) GROUP BY ALL""")
    con.execute(f"""CREATE TABLE api2 AS
      SELECT d.* EXCLUDE (type, cell_x, cell_y), CASE WHEN d.type IS NULL AND st.cell_x IS NOT NULL THEN 2 ELSE d.type END AS type,
             coalesce(c.country, c10.country) AS country, c.country IS NULL AS far
      FROM (SELECT *, {cell} FROM api) d
      LEFT JOIN st ON st.cell_x = d.cell_x AND st.cell_y = d.cell_y
      LEFT JOIN read_parquet('{serve}/cell_country.parquet') c ON c.cell_x = d.cell_x AND c.cell_y = d.cell_y
      LEFT JOIN cc10 c10 ON c10.gx = CAST(floor(d.cell_x / 10.0) AS INT) AND c10.gy = CAST(floor(d.cell_y / 10.0) AS INT)""")
    stats = rows(con, """SELECT sensor, count(*) AS rows, count(*) FILTER (country IS NULL) AS no_country,
                                count(*) FILTER (far AND country IS NOT NULL) AS country_from_50km, max(acq_date) AS last_utc_date
                         FROM api2 GROUP BY 1 ORDER BY 1""")
    for r in stats:
        print("api", year, r, flush=True)
        copy_to(con, f"""SELECT * EXCLUDE (sensor, far) FROM api2 WHERE sensor = '{r["sensor"]}' AND country IS NOT NULL
                         ORDER BY CAST(floor(latitude) AS INT), longitude""", root / "hotspots" / r["sensor"] / f"{year}.parquet")
    con.close()
    shutil.rmtree(tmp)
    shutil.rmtree(root / "tmp_duck", ignore_errors=True)
    return stats


def cell_passes(root, con, sensors):
    """hotspots -> cell_pass/{satellite}/{year}.parquet. Reads the neighbor years too,
    because a local solar date can fall in the UTC year before or after."""
    for sensor in sensors:
        files = {int(p.stem): p.as_posix() for p in (root / "hotspots" / sensor).glob("*.parquet")}
        for sat in SENSORS[sensor]:
            for year in sorted(files):
                out = root / "cell_pass" / sat / f"{year}.parquet"
                if out.exists():
                    continue
                near = [files[y] for y in (year - 1, year, year + 1) if y in files]
                src = (f"(SELECT * FROM read_parquet({near}) WHERE acq_date BETWEEN "
                       f"DATE '{year - 1}-12-31' AND DATE '{year + 1}-01-01')")
                print("cell_pass", sat, year, flush=True)
                copy_to(con, f"SELECT * FROM ({H.cell_pass_sql(src, sat)}) WHERE year(local_date) = {year} "
                             f"ORDER BY cell_y, cell_x", out)


def rows(con, sql):
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def validate(con, sat, window):
    """Held-out error of each method against real Aqua, per 5 degree tile and month."""
    con.execute(f"""CREATE OR REPLACE TEMP TABLE val AS
      WITH p AS (SELECT t5x, t5y, {MONTH}, sum(est_table) AS et, sum(est_ratio) AS er, sum(est_global) AS eg,
                        sum(n_pixels) AS raw, sum(est_frp) AS ef FROM pred_{sat} WHERE {window} GROUP BY ALL),
           a AS (SELECT t5x, t5y, month, sum(n_pixels) AS actual, sum(frp_sum) AS actual_frp
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_Aqua WHERE {window}) GROUP BY ALL)
      SELECT coalesce(p.t5x, a.t5x) AS t5x, coalesce(p.t5y, a.t5y) AS t5y, coalesce(p.month, a.month) AS month,
             CAST(coalesce(actual, 0) AS DOUBLE) AS actual, coalesce(et, 0) AS et, coalesce(er, 0) AS er,
             coalesce(eg, 0) AS eg, CAST(coalesce(raw, 0) AS DOUBLE) AS raw,
             coalesce(ef, 0) AS ef, CAST(coalesce(actual_frp, 0) AS DOUBLE) AS actual_frp
      FROM p FULL JOIN a ON p.t5x = a.t5x AND p.t5y = a.t5y AND p.month = a.month""")
    err = lambda c, a="actual": f"sum(abs({c} - {a})) / sum({a})"
    cols = (f"{err('raw')} AS raw, {err('eg')} AS global_factor, {err('er')} AS ratio, {err('et')} AS \"table\", "
            f"{err('ef', 'actual_frp')} AS frp, sum(et) / sum(actual) AS bias_table, sum(actual) AS actual")
    # The same table error for the night part and the day part alone
    con.execute(f"""CREATE OR REPLACE TEMP TABLE val_dn AS
      WITH p AS (SELECT t5x, t5y, {MONTH}, daynight, sum(est_table) AS et FROM pred_{sat} WHERE {window} GROUP BY ALL),
           a AS (SELECT t5x, t5y, month, daynight, sum(n_pixels) AS actual
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_Aqua WHERE {window}) GROUP BY ALL)
      SELECT coalesce(p.month, a.month) AS month, coalesce(p.daynight, a.daynight) AS daynight,
             CAST(coalesce(actual, 0) AS DOUBLE) AS actual, coalesce(et, 0) AS et
      FROM p FULL JOIN a ON p.t5x = a.t5x AND p.t5y = a.t5y AND p.month = a.month AND p.daynight = a.daynight""")
    dn = ", ".join(f"sum(abs(et - actual)) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS {n}, "
                   f"sum(et) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS bias_{n}"
                   for k, n in (("N", "night"), ("D", "day")))
    folds = {r.pop("year"): r for r in rows(con, f"SELECT year(month) AS year, {dn} FROM val_dn GROUP BY 1")}
    same = lambda c, d=0: f"avg(CASE WHEN abs({H.level_sql(c, 'b.q')} - {H.level_sql('actual', 'b.q')}) <= {d} THEN 1.0 ELSE 0 END)"
    return {
        "overall": {**rows(con, f"SELECT {cols} FROM val")[0], **rows(con, f"SELECT {dn} FROM val_dn")[0]},
        "folds": [{**r, **folds.get(r["year"], {})}
                  for r in rows(con, f"SELECT year(month) AS year, {cols} FROM val GROUP BY 1 HAVING sum(actual) > 0 ORDER BY 1")],
        "anomaly_agreement": rows(con, f"""SELECT {same('et')} AS "table", {same('et', 1)} AS table_within_one,
                                                  {same('er')} AS ratio, count(*) AS months
          FROM val JOIN base5 b ON b.t5x = val.t5x AND b.t5y = val.t5y AND b.m = month(val.month) WHERE b.q[3] >= 5""")[0],
        "range": rows(con, H.range_sql("val", "et", "actual")),
    }


def pack_globe(serve):
    """serve/globe.parquet -> serve/globe.bin.gz: every 0.5 degree cell and month as five Uint16 grids
    (harmonized, raw, night part of harmonized, the same two in VIIRS units). The page loads it once and can animate 25 years without asking for each month."""
    con, s = duckdb.connect(), serve.as_posix()
    con.execute(f"CREATE TEMP TABLE g AS SELECT * FROM read_parquet('{s}/globe.parquet')")
    countries = [r[0] for r in con.execute(f"SELECT country FROM read_parquet('{s}/countries.parquet') ORDER BY 1").fetchall()]
    con.execute(f"""CREATE TEMP TABLE c AS
      SELECT g.gx, g.gy, CAST(row_number() OVER (ORDER BY g.gy, g.gx) - 1 AS INT) AS u, k.country
      FROM (SELECT DISTINCT gx, gy FROM g) g
      LEFT JOIN (SELECT gx, gy, arg_max(country, n) AS country
                 FROM (SELECT CAST(floor(cell_x / 10.0) AS INT) AS gx, CAST(floor(cell_y / 10.0) AS INT) AS gy, country, count(*) AS n
                       FROM read_parquet('{s}/cell_country.parquet') WHERE country IS NOT NULL GROUP BY ALL)
                 GROUP BY ALL) k ON k.gx = g.gx AND k.gy = g.gy""")
    cells = con.execute("SELECT gx, gy, country FROM c ORDER BY u").fetchall()
    units, months = len(cells), con.execute("SELECT datediff('month', DATE '2000-11-01', max(month)) + 1 FROM g").fetchone()[0]
    grids = {"harm": "round(g.harm)", "raw": "g.raw_modis + g.raw_viirs", "night": "round(g.harm_night)",
             "vharm": "round(g.vharm)", "vnight": "round(g.vharm_night)"}
    data = [memoryview(bytearray(2 * units * months)).cast("H") for _ in grids]
    cur = con.execute(f"""SELECT c.u * {months} + datediff('month', DATE '2000-11-01', g.month),
                                 {', '.join(f'CAST(least({x}, 65535) AS INT)' for x in grids.values())}
                          FROM g JOIN c ON c.gx = g.gx AND c.gy = g.gy""")
    while chunk := cur.fetchmany(200_000):
        for i, *values in chunk:
            for grid, x in zip(data, values):
                grid[i] = x
    index = {name: i for i, name in enumerate(countries)}
    head = json.dumps({"units": units, "months": months, "first": "2000-11", "res": 0.5, "ncol": 720, "countries": countries,
                       "grids": list(grids)}).encode()
    pad = lambda b: b + b"\0" * (-len(b) % 4)   # the page reads typed arrays, which must start on 4-byte offsets
    part = serve / "globe.bin.part"
    with gzip.open(part, "wb", compresslevel=6) as f:
        f.write(pad(struct.pack("<I", len(head)) + head))
        f.write(array("I", [(gy + 180) * 720 + gx + 360 for gx, gy, _ in cells]).tobytes())
        f.write(pad(array("H", [index.get(c, 65535) for _, _, c in cells]).tobytes()))
        for grid in data:
            f.write(pad(grid.tobytes()))
    os.replace(part, serve / "globe.bin.gz")


PERSIST_DAYS, PERSIST_MONTHS, PERSIST_NIGHT = 30, 10, 0.4   # a flare burns all year, mostly at night; a wildfire or farm burn is seasonal or by day


def static_cells(root):
    """serve/static.parquet: cells that are not vegetation fire, with the reason 'type' (industrial, volcano or offshore source
    in at least half of all detections) or 'persistent' (in one year, detections on PERSIST_DAYS days and in PERSIST_MONTHS months, and a night share of PERSIST_NIGHT or more).
    The live file has no type column, so the app uses this mask to drop gas flares from the live layer."""
    files = [p.as_posix() for p in sorted((root / "hotspots").glob("*/*.parquet"))]
    con = connect(root)
    clean = "CASE WHEN satellite IN ('Terra', 'Aqua') THEN TRY_CAST(confidence AS INT) >= 30 ELSE lower(confidence[1]) <> 'l' END"
    copy_to(con, f"""
      WITH d AS (SELECT CAST(floor(longitude / {H.CELL}) AS INT) AS cell_x, CAST(floor(latitude / {H.CELL}) AS INT) AS cell_y,
                        type, acq_date, daynight, {clean} AS ok FROM read_parquet({files}, union_by_name = true)),
           t AS (SELECT cell_x, cell_y, count(*) FILTER (type IN (1, 2, 3)) AS n_static, count(*) FILTER (type = 0) AS n_fire, count(*) AS n,
                        avg(CASE WHEN daynight = 'N' THEN 1.0 ELSE 0.0 END) FILTER (ok) AS night
                 FROM d GROUP BY ALL),
           p AS (SELECT DISTINCT cell_x, cell_y FROM (
                   SELECT cell_x, cell_y FROM d WHERE ok GROUP BY cell_x, cell_y, year(acq_date)
                   HAVING count(DISTINCT acq_date) >= {PERSIST_DAYS} AND count(DISTINCT month(acq_date)) >= {PERSIST_MONTHS}))
      SELECT cell_x, cell_y, n_static, n_fire, night,
             CASE WHEN n_static >= 20 AND 2 * n_static >= n THEN 'type' ELSE 'persistent' END AS reason
      FROM t LEFT JOIN p USING (cell_x, cell_y)
      WHERE (n_static >= 20 AND 2 * n_static >= n) OR (p.cell_x IS NOT NULL AND night >= {PERSIST_NIGHT})
      ORDER BY cell_y, cell_x""", root / "serve" / "static.parquet")
    n = con.execute(f"SELECT reason, count(*) FROM read_parquet('{(root / 'serve' / 'static.parquet').as_posix()}') GROUP BY 1").fetchall()
    con.close()
    shutil.rmtree(root / "tmp_duck", ignore_errors=True)
    print("static cells", dict(n), flush=True)


TRUST_DEG, TRUST_MIN_N, TRUST_SHOW_N = 1, 200, 20   # unit size in degrees; fires needed to trust a unit; fires needed to show it
TRUST_SIZES = (20, 10, 5, 2, 1, 0.5)                 # unit sizes for by_size: the error grows as the area shrinks


def trust_cells(root):
    """serve/trust.json: held-out error of the adjusted count per unit of TRUST_DEG degrees, tests of all VIIRS satellites pooled,
    and under "viirs" the same for VIIRS units (MODIS estimate against measured VIIRS).
    Months that hold an Aqua outage day (and for "viirs" a Terra outage day) are left out. Needs serve/monthly.parquet and validation.json."""
    serve = root / "serve"
    val = json.loads((serve / "validation.json").read_text())
    sats = {s: v["window"] for s, v in val["satellites"].items()}

    def months(ranges):
        out = set()
        for a, b in ranges:
            y, m = int(a[:4]), int(a[5:7])
            while (y, m) <= (int(b[:4]), int(b[5:7])):
                out.add(f"{y}-{m:02d}")
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return out
    con = connect(root)
    con.execute(f"CREATE TEMP VIEW m AS SELECT * FROM read_parquet('{(serve / 'monthly.parquet').as_posix()}')")
    inside = lambda w, gaps: f"month >= date_trunc('month', DATE '{w[0]}') AND month <= DATE '{w[1]}' AND strftime(month, '%Y-%m') NOT IN {tuple(gaps) + ('',)}"

    def units(table, windows, gaps):
        """Error per unit from a table of (cell_x, cell_y, month, sat, a = actual, p = prediction, r = raw count)."""
        # totals per unit, month and satellite first: the error is of the monthly count of an area of that size
        um = lambda deg: (f"SELECT CAST(floor(cell_x / {deg * 20}) AS INT) AS ux, CAST(floor(cell_y / {deg * 20}) AS INT) AS uy, "
                          f"sum(a) AS a, sum(p) AS p, sum(r) AS r FROM {table} GROUP BY ux, uy, month, sat")
        cols = con.execute(f"""SELECT ux, uy, CAST(sum(a) AS BIGINT), sum(abs(p - a)) / sum(a), sum(abs(r - a)) / sum(a)
                               FROM ({um(TRUST_DEG)}) GROUP BY ux, uy HAVING sum(a) >= {TRUST_SHOW_N} ORDER BY uy, ux""").fetchall()
        by_size = [{"deg": d, "km": round(d * 111), "err": round(con.execute(f"SELECT sum(abs(p - a)) / sum(a) FROM ({um(d)})").fetchone()[0], 3)}
                   for d in TRUST_SIZES]
        years = con.execute(f"SELECT min(year(month)), max(year(month)) FROM {table}").fetchone()
        ux, uy, n, err, raw = (list(c) for c in zip(*cols))
        return {"deg": TRUST_DEG, "min_n": TRUST_MIN_N, "show_n": TRUST_SHOW_N, "years": list(years),
                "left_out": sorted(g for g in gaps if any(w[0][:7] <= g <= w[1][:7] for w in windows)),
                "ux": ux, "uy": uy, "n": n, "err": [round(x, 3) for x in err], "raw": [round(x, 2) for x in raw], "by_size": by_size}
    gaps = months(val["aqua_gaps"])
    con.execute("CREATE TEMP TABLE t AS " + " UNION ALL ".join(
        f"SELECT cell_x, cell_y, month, '{s}' AS sat, raw_aqua AS a, pred_{s.lower()} AS p, raw_{s.lower()} AS r FROM m WHERE {inside(w, gaps)}"
        for s, w in sats.items()))
    out = {"satellites": list(sats), **units("t", sats.values(), gaps)}
    if "viirs" in val:   # VIIRS units: the MODIS estimate against measured VIIRS; raw is Aqua's own count
        w, vgaps = val["viirs"]["window"], months(val["aqua_gaps"] + val["terra_gaps"])
        con.execute(f"CREATE TEMP TABLE tv AS SELECT cell_x, cell_y, month, 'V' AS sat, vharm AS a, vpred AS p, raw_aqua AS r FROM m WHERE {inside(w, vgaps)}")
        out["viirs"] = units("tv", [w], vgaps)
    part = serve / "trust.json.part"
    part.write_text(json.dumps(out, separators=(",", ":")))
    os.replace(part, serve / "trust.json")
    con.close()
    shutil.rmtree(root / "tmp_duck", ignore_errors=True)
    for k, t in (("Aqua units", out), ("VIIRS units", out.get("viirs"))):
        if t:
            print("trust units", k, len(t["n"]), "with n >=", TRUST_MIN_N, sum(x >= TRUST_MIN_N for x in t["n"]), t["by_size"], flush=True)


def build(root, sensors=tuple(SENSORS)):
    """cell-pass rows -> conversion tables, held-out proofs and the tables the app serves."""
    db = root / "build.duckdb"
    db.unlink(missing_ok=True)
    con = connect(root, db)
    cell_passes(root, con, sensors)
    sats = [s for sensor in sensors for s in SENSORS[sensor] if any((root / "cell_pass" / s).glob("*.parquet"))]
    for s in sats:
        con.execute(f"CREATE VIEW cp_{s} AS SELECT * FROM read_parquet('{root.as_posix()}/cell_pass/{s}/*.parquet')")
    viirs = [s for s in ("N20", "SNPP") if s in sats]
    primary = viirs[0]   # the satellite that continues the record after Aqua
    baseline = f"year(local_date) BETWEEN {H.BASELINE[0]} AND {H.BASELINE[1]}"
    out = {"unit": "MODIS-equivalent hotspots", "baseline": list(H.BASELINE), "primary": primary,
           "aqua_start": H.AQUA_START, "model_start": H.MODEL_START, "satellites": {}}
    serve = root / "serve"

    # Days when one MODIS did not record: the other saw normal activity, this one far less than its usual share.
    def outages(table, lost, other):
        con.execute(f"""CREATE TABLE {table} AS
          WITH d AS (SELECT g.local_date, coalesce(a.n, 0) AS a, coalesce(t.n, 0) AS t
                     FROM (SELECT CAST(unnest(generate_series(DATE '{H.AQUA_START}', DATE '{OVERLAP_END}-12-31', INTERVAL 1 DAY)) AS DATE) AS local_date) g
                     LEFT JOIN (SELECT local_date, sum(n_pixels) AS n FROM cp_{lost} GROUP BY 1) a ON a.local_date = g.local_date
                     LEFT JOIN (SELECT local_date, sum(n_pixels) AS n FROM cp_{other} GROUP BY 1) t ON t.local_date = g.local_date),
               w AS (SELECT *, median(t) OVER win AS tm, median(a / greatest(t, 1)) OVER win AS rm FROM d
                     WINDOW win AS (ORDER BY local_date ROWS BETWEEN 30 PRECEDING AND 30 FOLLOWING))
          SELECT local_date FROM w WHERE tm >= {GAP_MIN} AND t >= 0.5 * tm AND a < 0.25 * rm * t""")
        days = [r[0] for r in con.execute(f"SELECT local_date FROM {table} ORDER BY 1").fetchall()]
        return [[f"{a}", f"{b}"] for a, b in zip(
            [d for i, d in enumerate(days) if i == 0 or (d - days[i - 1]).days > 1],
            [d for i, d in enumerate(days) if i == len(days) - 1 or (days[i + 1] - d).days > 1])]
    out["aqua_gaps"], out["terra_gaps"] = outages("gaps", "Aqua", "Terra"), outages("tgaps", "Terra", "Aqua")
    gap, tgap = "local_date IN (SELECT local_date FROM gaps)", "local_date IN (SELECT local_date FROM tgaps)"
    baseline = f"{baseline} AND NOT {gap}"

    # Terra -> Aqua, for the months before Aqua
    H.fit_terra(con, "tr", "cp_Terra", "cp_Aqua", baseline)
    con.execute(f"CREATE TABLE pred_Terra AS {H.apply_terra('tr', 'cp_Terra', 'TRUE')}")

    # Baseline quantiles per 5 degree tile and calendar month, with zero months filled in
    quantiles = lambda table, src, where, years: con.execute(f"""CREATE TEMP TABLE {table} AS
      WITH a AS (SELECT t5x, t5y, month, sum(n_pixels) AS n
                 FROM (SELECT *, {H.T5}, {MONTH} FROM {src} WHERE {where}) GROUP BY ALL),
           g AS (SELECT t5x, t5y, month FROM (SELECT DISTINCT t5x, t5y FROM a)
                 CROSS JOIN (SELECT CAST(unnest(generate_series(DATE '{years[0]}-01-01', DATE '{years[1]}-12-01',
                                                                INTERVAL 1 MONTH)) AS DATE) AS month))
      SELECT g.t5x, g.t5y, month(g.month) AS m, quantile_cont(coalesce(a.n, 0), {H.QUANTILES}) AS q
      FROM g LEFT JOIN a ON a.t5x = g.t5x AND a.t5y = g.t5y AND a.month = g.month GROUP BY ALL""")
    quantiles("base5", "cp_Aqua", baseline, H.BASELINE)

    # VIIRS -> Aqua: leave one overlap year out for the proofs, then one fit on all overlap years
    starts = {}
    for sat in viirs:
        start = con.execute(f"SELECT date_trunc('month', min(local_date)) + INTERVAL 1 MONTH FROM cp_{sat}").fetchone()[0]
        starts[sat] = f"DATE '{start:%Y-%m-%d}'"
        window = f"local_date >= {starts[sat]} AND local_date <= DATE '{OVERLAP_END}-12-31'"
        for i, held in enumerate([*range(start.year, OVERLAP_END + 1), None]):
            print("fit", sat, "final" if held is None else f"without {held}", flush=True)
            train = f"{window} AND NOT {gap}" + ("" if held is None else f" AND year(local_date) <> {held}")
            where = f"local_date >= DATE '{H.MODEL_START}'" if held is None else f"{window} AND year(local_date) = {held}"
            H.fit(con, "f", f"cp_{sat}", "cp_Aqua", train)
            H.fit_frp(con, "f", f"cp_{sat}", "cp_Aqua", train)
            con.execute((f"INSERT INTO pred_{sat} " if i else f"CREATE TABLE pred_{sat} AS ")
                        + f"SELECT p.*, q.est_frp FROM ({H.apply('f', f'cp_{sat}', where)}) p "
                        + f"JOIN ({H.apply_frp('f', f'cp_{sat}', where)}) q USING ({H.KEY})")
            if held is None and sat == primary:   # keep the final tables: the app converts new detections with them
                for t in H.MODEL_TABLES:
                    copy_to(con, f"SELECT * FROM f_{t}", serve / "model" / f"{t}.parquet")
        out["satellites"][sat] = {"window": [f"{start:%Y-%m-%d}", f"{OVERLAP_END}-12-31"],
                                  **validate(con, sat, f"{window} AND NOT {gap}")}
    for t in ("pairs", "mu", "aq"):   # the last fit's work tables hold every overlap row: on the world they fill the memory the next steps need
        con.execute(f"DROP TABLE IF EXISTS f_{t}")

    # In-sample check of the Terra scaling, used for the range before Aqua
    con.execute(f"""CREATE TEMP TABLE val_t AS
      SELECT p.est, coalesce(a.actual, 0) AS actual
      FROM (SELECT t5x, t5y, {MONTH}, sum(est) AS est FROM pred_Terra WHERE {baseline} GROUP BY ALL) p
      LEFT JOIN (SELECT t5x, t5y, month, sum(n_pixels) AS actual
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_Aqua WHERE {baseline}) GROUP BY ALL) a
        ON a.t5x = p.t5x AND a.t5y = p.t5y AND a.month = p.month""")
    out["terra"] = {"error": con.execute("SELECT sum(abs(est - actual)) / sum(actual) FROM val_t").fetchone()[0],
                    "range": rows(con, H.range_sql("val_t", "est", "actual"))}

    if len(viirs) == 2:   # two identical instruments: their disagreement is the best any method can reach
        twin = lambda where: con.execute(f"""
          SELECT sum(abs(coalesce(a.e, 0) - coalesce(b.e, 0))) / (sum(coalesce(a.e, 0) + coalesce(b.e, 0)) / 2)
          FROM (SELECT t5x, t5y, {MONTH}, sum(est_table) AS e FROM pred_N20 WHERE {where} GROUP BY ALL) a
          FULL JOIN (SELECT t5x, t5y, {MONTH}, sum(est_table) AS e FROM pred_SNPP WHERE {where} GROUP BY ALL) b
            ON a.t5x = b.t5x AND a.t5y = b.t5y AND a.month = b.month""").fetchone()[0]
        n20_start = out["satellites"]["N20"]["window"][0]
        out["twin"] = {"overlap": twin(f"local_date >= DATE '{n20_start}' AND local_date <= DATE '{OVERLAP_END}-12-31'"),
                       "after": twin(f"local_date >= DATE '{H.MODEL_START}'")}

    # VIIRS units: one measured VIIRS series cp_V, with Aqua and Terra converted to it before VIIRS (see H.fit_up)
    ref, w = primary, H.W_AQUA
    ref_start, vstart_s = out["satellites"][ref]["window"][0], min(out["satellites"][s]["window"][0] for s in viirs)
    vstart, vwin = f"DATE '{vstart_s}'", f"local_date >= DATE '{vstart_s}' AND local_date <= DATE '{OVERLAP_END}-12-31'"
    e = lambda c: f"sum(abs({c} - actual)) / sum(actual)"
    viirs_out = {}
    if len(viirs) == 2:   # the older VIIRS scaled to ref, learned where both flew; the proof hides one year at a time
        other, both = viirs[1], f"local_date >= {starts[ref]}"
        last = con.execute(f"SELECT year(max(local_date)) FROM cp_{ref}").fetchone()[0]
        for i, held in enumerate([*range(int(ref_start[:4]), last + 1), None]):
            H.fit_terra(con, "tw", f"cp_{other}", f"cp_{ref}", both + ("" if held is None else f" AND year(local_date) <> {held}"))
            if held is not None:
                con.execute(("INSERT INTO pred_twin " if i else "CREATE TABLE pred_twin AS ")
                            + H.apply_terra("tw", f"cp_{other}", f"{both} AND year(local_date) = {held}"))
        con.execute(f"""CREATE TABLE cp_V AS
          SELECT cell_x, cell_y, local_date, daynight, est AS n_pixels FROM ({H.apply_terra('tw', f'cp_{other}', f'local_date < {starts[ref]}')})
          UNION ALL SELECT cell_x, cell_y, local_date, daynight, n_pixels FROM cp_{ref} WHERE {both}""")
        con.execute(f"""CREATE TEMP TABLE val_tw AS
          SELECT t5x, t5y, month, sum(r) AS r, sum(s) AS s, CAST(sum(a) AS DOUBLE) AS actual
          FROM (SELECT t5x, t5y, {MONTH}, n_pixels AS r, est AS s, 0 AS a FROM pred_twin
                UNION ALL SELECT t5x, t5y, {MONTH}, 0, 0, n_pixels FROM (SELECT *, {H.T5} FROM cp_{ref} WHERE {both})) GROUP BY ALL""")
        viirs_out["twin"] = {**rows(con, f"SELECT {e('r')} AS raw, {e('s')} AS scaled FROM val_tw")[0],
                             "range": rows(con, H.range_sql("val_tw", "s", "actual"))}
    else:
        con.execute(f"CREATE TABLE cp_V AS SELECT cell_x, cell_y, local_date, daynight, n_pixels FROM cp_{ref}")
    for sat, own in (("Aqua", gap), ("Terra", tgap)):   # leave one year out for the proof, then one fit on all overlap years
        for i, held in enumerate([*range(int(vstart_s[:4]), OVERLAP_END + 1), None]):
            print("fit up", sat, "final" if held is None else f"without {held}", flush=True)
            H.fit_up(con, "u", f"cp_{sat}", "cp_V", f"{vwin} AND NOT {own}" + ("" if held is None else f" AND year(local_date) <> {held}"))
            # the years before VIIRS go in one at a time: for the open range the planner expects no rows and builds its hash tables on all of them
            wheres = ([f"local_date < {vstart} AND year(local_date) = {y}" for y in range(2000, int(vstart_s[:4]) + 1)] if held is None
                      else [f"{vwin} AND year(local_date) = {held}"])
            for j, where in enumerate(wheres):
                con.execute((f"INSERT INTO pred_up_{sat} " if i or j else f"CREATE TABLE pred_up_{sat} AS ") + H.apply_up("u", f"cp_{sat}", where))
    vval = f"{vwin} AND NOT {gap} AND NOT {tgap}"
    con.execute(f"""CREATE TEMP TABLE val_v AS
      SELECT t5x, t5y, month, daynight, CAST(sum(a) AS DOUBLE) AS actual, sum(ua) AS ua, sum(ut) AS ut, {w} * sum(ua) + {1 - w:.6g} * sum(ut) AS ub
      FROM (SELECT t5x, t5y, {MONTH}, daynight, n_pixels AS a, 0 AS ua, 0 AS ut FROM (SELECT *, {H.T5} FROM cp_V WHERE {vval})
            UNION ALL SELECT t5x, t5y, {MONTH}, daynight, 0, est, 0 FROM pred_up_Aqua WHERE {vval}
            UNION ALL SELECT t5x, t5y, {MONTH}, daynight, 0, 0, est FROM pred_up_Terra WHERE {vval}) GROUP BY ALL""")
    con.execute("CREATE TEMP TABLE val_v5 AS SELECT t5x, t5y, month, sum(actual) AS actual, sum(ua) AS ua, sum(ut) AS ut, sum(ub) AS ub FROM val_v GROUP BY ALL")
    vbase = (int(vstart_s[:4]) + (vstart_s[5:7] != "01"), con.execute("SELECT year(max(local_date) + 1) - 1 FROM cp_V").fetchone()[0])
    quantiles("base_v", "cp_V", f"year(local_date) BETWEEN {vbase[0]} AND {vbase[1]}", vbase)
    same = lambda d: f"avg(CASE WHEN abs({H.level_sql('ub', 'b.q')} - {H.level_sql('actual', 'b.q')}) <= {d} THEN 1.0 ELSE 0 END)"
    single = lambda c: {**rows(con, f"SELECT {e(c)} AS error, sum({c}) / sum(actual) AS bias FROM val_v5")[0],
                        "range": rows(con, H.range_sql("val_v5", c, "actual"))}
    out["viirs"] = {
        "unit": "VIIRS-equivalent detections", "reference": ref, "start": vstart_s, "ref_start": ref_start,
        "window": [vstart_s, f"{OVERLAP_END}-12-31"], "baseline": list(vbase), "weight_aqua": w,
        "both": {**single("ub"), **rows(con, f"SELECT {e('ub')} AS night, sum(ub) / sum(actual) AS bias_night FROM val_v WHERE daynight = 'N'")[0],
                 "folds": rows(con, f"SELECT year(month) AS year, {e('ub')} AS error, sum(ub) / sum(actual) AS bias FROM val_v5 GROUP BY 1 HAVING sum(actual) > 0 ORDER BY 1"),
                 "tiles": rows(con, f"""SELECT CAST(floor(t5x / 4) AS INT) AS t20x, CAST(floor(t5y / 4) AS INT) AS t20y, sum(actual) AS actual,
                                               {e('ub')} AS error FROM val_v5 GROUP BY 1, 2 HAVING sum(actual) > 0 ORDER BY 2, 1"""),
                 "anomaly_agreement": rows(con, f"""SELECT {same(0)} AS same, {same(1)} AS within_one, count(*) AS months
                   FROM val_v5 v JOIN base_v b ON b.t5x = v.t5x AND b.t5y = v.t5y AND b.m = month(v.month) WHERE b.q[3] >= 5""")[0]},
        "aqua": single("ua"), "terra": single("ut"), **viirs_out}

    # Monthly table per cell: raw counts per satellite, harmonized value, out-of-sample predictions
    a, m = f"DATE '{H.AQUA_START}'", f"DATE '{H.MODEL_START}'"
    # Aqua gap days are filled with converted VIIRS, or with scaled Terra before VIIRS exists ("fill").
    cols = ("raw_terra", "raw_aqua", "raw_n20", "raw_snpp", "harm", "harm_ratio", "fill", "pred_n20", "pred_snpp", "frp", "harm_night",
            "vharm", "vharm_night", "vpred")
    # a *_night column is the same per-row value as its day-and-night column, kept for night rows only
    night = {"harm_night": "harm", "vharm_night": "vharm"}
    part = lambda src, **v: (f"SELECT cell_x, cell_y, {MONTH}, " + ", ".join(
        f"CASE WHEN daynight = 'N' THEN {v.get(night[c], 0)} ELSE 0 END AS {c}" if c in night else f"{v.get(c, 0)} AS {c}" for c in cols)
        + f" FROM {src}")
    when = lambda cond, c: f"CASE WHEN {cond} THEN {c} ELSE 0 END"
    old_gap, new_gap = f"{gap} AND local_date < {starts[primary]}", f"{gap} AND local_date >= {starts[primary]}"
    early = lambda c="est": when(f"local_date < {a} OR ({old_gap})", c)
    stable = lambda c="n_pixels": when(f"local_date >= {a} AND local_date < {m} AND NOT {gap}", c)
    parts = [part("pred_Terra", raw_terra="n_pixels", harm=early(), harm_ratio=early(), fill=when(old_gap, "est"), frp=early("est_frp")),
             part("cp_Aqua", raw_aqua="n_pixels", harm=stable(), harm_ratio=stable(), frp=stable("frp_sum"))]
    for sat in viirs:
        late = lambda c: when(f"local_date >= {m} OR ({new_gap})", c) if sat == primary else "0"
        parts += [part(f"cp_{sat}", **{f"raw_{sat.lower()}": "n_pixels"}),
                  part(f"pred_{sat}", harm=late("est_table"), harm_ratio=late("est_ratio"), frp=late("est_frp"),
                       fill=when(new_gap, "est_table") if sat == primary else "0", **{f"pred_{sat.lower()}": "est_table"})]
    # VIIRS units: measured from vstart; before it W_AQUA Aqua + the rest Terra, one alone when the other did not record
    wa = f"CASE WHEN local_date < {a} OR {gap} THEN 0 WHEN {tgap} THEN 1 ELSE {w} END"
    wt = f"CASE WHEN local_date < {a} OR {gap} THEN 1 WHEN {tgap} THEN 0 ELSE {1 - w:.6g} END"
    parts += [part("cp_V", vharm=when(f"local_date >= {vstart}", "n_pixels"))]
    parts += [part(f"pred_up_{s}", vharm=when(f"local_date < {vstart}", f"({k}) * est"), vpred=f"({k}) * est") for s, k in (("Aqua", wa), ("Terra", wt))]
    sums = ", ".join(f"sum({c}) AS {c}" for c in cols)
    con.execute(f"CREATE TABLE monthly AS SELECT cell_x, cell_y, month, {sums} FROM ({' UNION ALL '.join(parts)}) GROUP BY ALL")
    con.execute(f"""CREATE TABLE cell_country AS
      SELECT cell_x, cell_y, arg_max(country, n) AS country
      FROM (SELECT cell_x, cell_y, country, sum(n_pixels) AS n
            FROM ({' UNION ALL '.join(f'SELECT cell_x, cell_y, country, n_pixels FROM cp_{s}' for s in sats)}) GROUP BY ALL)
      GROUP BY ALL""")
    copy_to(con, "SELECT * FROM monthly ORDER BY cell_y, cell_x, month", serve / "monthly.parquet")
    copy_to(con, "SELECT * FROM cell_country ORDER BY cell_y, cell_x", serve / "cell_country.parquet")
    copy_to(con, f"SELECT country, month, {sums} FROM monthly JOIN cell_country USING (cell_x, cell_y) GROUP BY ALL ORDER BY country, month",
            serve / "monthly_country.parquet")
    copy_to(con, f"""SELECT country, min(cell_x) * {H.CELL} AS w, min(cell_y) * {H.CELL} AS s, (max(cell_x) + 1) * {H.CELL} AS e,
                            (max(cell_y) + 1) * {H.CELL} AS n FROM cell_country GROUP BY country ORDER BY country""",
            serve / "countries.parquet")
    copy_to(con, """SELECT CAST(floor(cell_x / 10.0) AS INT) AS gx, CAST(floor(cell_y / 10.0) AS INT) AS gy, month,
                           sum(raw_terra + raw_aqua) AS raw_modis, sum(raw_n20 + raw_snpp) AS raw_viirs, sum(harm) AS harm,
                           sum(harm_night) AS harm_night, sum(vharm) AS vharm, sum(vharm_night) AS vharm_night
                    FROM monthly GROUP BY ALL ORDER BY month""", serve / "globe.parquet")
    (serve / "validation.json").write_text(json.dumps(out, indent=1, default=str))
    con.close()
    pack_globe(serve)
    static_cells(root)
    trust_cells(root)
    db.unlink()
    shutil.rmtree(root / "tmp_duck", ignore_errors=True)
    print("built", serve, flush=True)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path("data/world"))
    ap.add_argument("--countries", help="comma-separated country names as in the FIRMS file names; default all")
    ap.add_argument("--sensors", nargs="+", default=["modis", "viirs-jpss1"], choices=list(SENSORS))
    ap.add_argument("--delete-zips", action="store_true", help="delete each zip after its Parquet file is written")
    ap.add_argument("--trust-only", action="store_true", help="only write serve/trust.json (no download, no build)")
    ap.add_argument("--api-zip", type=Path, help="zip of daily world files from the FIRMS API for the current year (see ingest_api); needs an earlier build in --root")
    ap.add_argument("--api-end", help="with --api-zip: keep local dates before this day, e.g. 2026-11-01 (the first day of the unfinished month)")
    args = ap.parse_args()
    if args.trust_only:
        raise SystemExit(trust_cells(args.root))
    wanted = {c.strip().lower() for c in args.countries.split(",")} if args.countries else None
    for sensor in args.sensors:
        for year in YEARS[sensor]:
            ingest(args.root, sensor, year, wanted, args.delete_zips)
    if args.api_zip:
        datetime.date.fromisoformat(args.api_end or "")   # a clear error before any work
        ingest_api(args.root, args.api_zip, args.api_end)
    result = build(args.root, args.sensors)
    for sat, v in result["satellites"].items():
        print(sat, "held-out error:", {k: round(x, 3) for k, x in v["overall"].items()})
    for k, v in result["viirs"].items():
        if isinstance(v, dict):
            print("viirs", k, "held-out error:", {x: round(y, 3) for x, y in v.items() if isinstance(y, float)})
