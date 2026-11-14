"""Download, clean and harmonize FIRMS hotspots.

    python pipeline.py --root data/mx --countries Mexico     # quick first pass
    python pipeline.py --root data/world                     # every country

Steps are resumable: a year that already has its Parquet file is skipped.
"""
import argparse
import gzip
import json
import os
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
SENSORS = {"modis": ("Terra", "Aqua"), "viirs-snpp": ("SNPP",), "viirs-jpss1": ("N20",)}
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


def validate(con, pred, ref, window):
    """Held-out error of each method against the real reference satellite, per 5 degree tile and month."""
    con.execute(f"""CREATE OR REPLACE TEMP TABLE val AS
      WITH p AS (SELECT t5x, t5y, {MONTH}, sum(est_table) AS et, sum(est_ratio) AS er, sum(est_dn) AS ed, sum(est_global) AS eg,
                        sum(n_pixels) AS raw, sum(est_frp) AS ef FROM {pred} WHERE {window} GROUP BY ALL),
           a AS (SELECT t5x, t5y, month, sum(n_pixels) AS actual, sum(frp_sum) AS actual_frp
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_{ref} WHERE {window}) GROUP BY ALL)
      SELECT coalesce(p.t5x, a.t5x) AS t5x, coalesce(p.t5y, a.t5y) AS t5y, coalesce(p.month, a.month) AS month,
             CAST(coalesce(actual, 0) AS DOUBLE) AS actual, coalesce(et, 0) AS et, coalesce(er, 0) AS er, coalesce(ed, 0) AS ed,
             coalesce(eg, 0) AS eg, CAST(coalesce(raw, 0) AS DOUBLE) AS raw,
             coalesce(ef, 0) AS ef, CAST(coalesce(actual_frp, 0) AS DOUBLE) AS actual_frp
      FROM p FULL JOIN a ON p.t5x = a.t5x AND p.t5y = a.t5y AND p.month = a.month""")
    err = lambda c, a="actual": f"sum(abs({c} - {a})) / sum({a})"
    cols = (f"{err('raw')} AS raw, {err('eg')} AS global_factor, {err('er')} AS ratio, {err('et')} AS \"table\", {err('ed')} AS ratio_dn, "
            f"{err('ef', 'actual_frp')} AS frp, sum(et) / sum(actual) AS bias_table, sum(ed) / sum(actual) AS bias_ratio_dn, sum(actual) AS actual")
    # The same table error for the night part and the day part alone
    con.execute(f"""CREATE OR REPLACE TEMP TABLE val_dn AS
      WITH p AS (SELECT t5x, t5y, {MONTH}, daynight, sum(est_table) AS et, sum(est_dn) AS ed FROM {pred} WHERE {window} GROUP BY ALL),
           a AS (SELECT t5x, t5y, month, daynight, sum(n_pixels) AS actual
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_{ref} WHERE {window}) GROUP BY ALL)
      SELECT coalesce(p.month, a.month) AS month, coalesce(p.daynight, a.daynight) AS daynight,
             CAST(coalesce(actual, 0) AS DOUBLE) AS actual, coalesce(et, 0) AS et, coalesce(ed, 0) AS ed
      FROM p FULL JOIN a ON p.t5x = a.t5x AND p.t5y = a.t5y AND p.month = a.month AND p.daynight = a.daynight""")
    dn = ", ".join(f"sum(abs(et - actual)) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS {n}, "
                   f"sum(et) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS bias_{n}, "
                   f"sum(abs(ed - actual)) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS {n}_dn, "
                   f"sum(ed) FILTER (daynight = '{k}') / sum(actual) FILTER (daynight = '{k}') AS bias_{n}_dn"
                   for k, n in (("N", "night"), ("D", "day")))
    folds = {r.pop("year"): r for r in rows(con, f"SELECT year(month) AS year, {dn} FROM val_dn GROUP BY 1")}
    same = lambda c, d=0: f"avg(CASE WHEN abs({H.level_sql(c, 'b.q')} - {H.level_sql('actual', 'b.q')}) <= {d} THEN 1.0 ELSE 0 END)"
    return {
        "overall": {**rows(con, f"SELECT {cols} FROM val")[0], **rows(con, f"SELECT {dn} FROM val_dn")[0]},
        "folds": [{**r, **folds.get(r["year"], {})}
                  for r in rows(con, f"SELECT year(month) AS year, {cols} FROM val GROUP BY 1 HAVING sum(actual) > 0 ORDER BY 1")],
        "tiles": rows(con, f"""SELECT CAST(floor(t5x / 4.0) AS INT) AS t20x, CAST(floor(t5y / 4.0) AS INT) AS t20y, {cols}
                               FROM val GROUP BY 1, 2 HAVING sum(actual) > 0"""),
        "anomaly_agreement": rows(con, f"""SELECT {same('et')} AS "table", {same('et', 1)} AS table_within_one,
                                                  {same('er')} AS ratio, {same('ed')} AS ratio_dn, {same('ed', 1)} AS ratio_dn_within_one, count(*) AS months
          FROM val JOIN base5 b ON b.t5x = val.t5x AND b.t5y = val.t5y AND b.m = month(val.month) WHERE b.q[3] >= 5""")[0],
        "range": rows(con, H.range_sql("val", {"table": "et", "ratio": "er", "ratio_dn": "ed"}[H.METHOD], "actual")),
    }


def pack_globe(serve):
    """serve/globe.parquet -> serve/globe.bin.gz: every 0.5 degree cell and month as three Uint16 grids
    (harmonized, raw, night part of harmonized). The page loads it once and can animate 25 years without asking for each month."""
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
    harm, raw, night = (memoryview(bytearray(2 * units * months)).cast("H") for _ in range(3))
    cur = con.execute("""SELECT c.u, datediff('month', DATE '2000-11-01', g.month), CAST(least(round(g.harm), 65535) AS INT),
                                CAST(least(g.raw_modis + g.raw_viirs, 65535) AS INT), CAST(least(round(g.harm_night), 65535) AS INT)
                         FROM g JOIN c ON c.gx = g.gx AND c.gy = g.gy""")
    while chunk := cur.fetchmany(200_000):
        for u, t, h, r, n in chunk:
            harm[u * months + t], raw[u * months + t], night[u * months + t] = h, r, n
    index = {name: i for i, name in enumerate(countries)}
    head = json.dumps({"units": units, "months": months, "first": "2000-11", "res": 0.5, "ncol": 720, "countries": countries,
                       "grids": ["harm", "raw", "night"]}).encode()
    pad = lambda b: b + b"\0" * (-len(b) % 4)   # the page reads typed arrays, which must start on 4-byte offsets
    part = serve / "globe.bin.part"
    with gzip.open(part, "wb", compresslevel=6) as f:
        f.write(pad(struct.pack("<I", len(head)) + head))
        f.write(array("I", [(gy + 180) * 720 + gx + 360 for gx, gy, _ in cells]).tobytes())
        f.write(pad(array("H", [index.get(c, 65535) for _, _, c in cells]).tobytes()))
        f.write(pad(harm.tobytes()))
        f.write(pad(raw.tobytes()))
        f.write(pad(night.tobytes()))
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


def convert(con, src, ref, window, gap, before):
    """Convert one MODIS satellite to the reference. Writes pred_{src}: every overlap year predicted by tables
    that never saw it (the proofs), plus the months before the reference existed, from one fit on all overlap years."""
    first, last = con.execute(f"SELECT min(year(local_date)), max(year(local_date)) FROM cp_{ref} WHERE {window}").fetchone()
    for i, held in enumerate([*range(first, last + 1), None]):
        print("fit", src, "->", ref, "final" if held is None else f"without {held}", flush=True)
        train = f"{window} AND NOT {gap}" + ("" if held is None else f" AND year(local_date) <> {held}")
        H.fit(con, "f", f"cp_{src}", f"cp_{ref}", train)
        H.fit_frp(con, "f", f"cp_{src}", f"cp_{ref}", train)
        # one year at a time: the whole MODIS past in one statement does not fit in memory for the world
        years = [held] if held is not None else [r[0] for r in con.execute(
            f"SELECT DISTINCT year(local_date) FROM cp_{src} WHERE {before} ORDER BY 1").fetchall()]
        for j, year in enumerate(years):
            where = f"{before if held is None else window} AND year(local_date) = {year}"
            con.execute((f"INSERT INTO pred_{src} " if i or j else f"CREATE TABLE pred_{src} AS ")
                        + f"SELECT p.*, q.est_frp FROM ({H.apply('f', f'cp_{src}', where)}) p "
                        + f"JOIN ({H.apply_frp('f', f'cp_{src}', where)}) q USING ({H.KEY})")
    return first, last


def build(root, sensors=tuple(SENSORS)):
    """cell-pass rows -> conversion tables, held-out proofs and the tables the app serves."""
    db = root / "build.duckdb"
    db.unlink(missing_ok=True)
    con = connect(root, db)
    cell_passes(root, con, sensors)
    sats = [s for sensor in sensors for s in SENSORS[sensor] if any((root / "cell_pass" / s).glob("*.parquet"))]
    for s in sats:
        con.execute(f"CREATE VIEW cp_{s} AS SELECT * FROM read_parquet('{root.as_posix()}/cell_pass/{s}/*.parquet')")
    # first full month of every VIIRS satellite, oldest first
    begin = {s: con.execute(f"SELECT date_trunc('month', min(local_date)) + INTERVAL 1 MONTH FROM cp_{s}").fetchone()[0]
             for s in ("SNPP", "N20") if s in sats}
    viirs = sorted(begin, key=begin.get)
    starts = {s: f"DATE '{begin[s]:%Y-%m-%d}'" for s in viirs}
    ref = viirs[0]   # the VIIRS satellite with the longest overlap with stable Aqua: the tables are learned against it
    v1 = starts[ref]
    window = f"local_date >= {v1} AND local_date <= DATE '{OVERLAP_END}-12-31'"
    out = {"unit": "VIIRS-equivalent detections", "baseline": list(H.BASELINE), "primary": ref, "carrier": viirs[-1],
           "aqua_start": H.AQUA_START, "viirs_start": f"{begin[ref]:%Y-%m-%d}",
           "starts": {s: f"{begin[s]:%Y-%m-%d}" for s in viirs}, "shrink": H.SHRINK, "method": H.METHOD, "satellites": {}}
    serve = root / "serve"

    # Days when Aqua did not record: Terra saw normal activity, Aqua far less than its usual share.
    con.execute(f"""CREATE TABLE gaps AS
      WITH d AS (SELECT g.local_date, coalesce(a.n, 0) AS a, coalesce(t.n, 0) AS t
                 FROM (SELECT CAST(unnest(generate_series(DATE '{H.AQUA_START}', DATE '{OVERLAP_END}-12-31', INTERVAL 1 DAY)) AS DATE) AS local_date) g
                 LEFT JOIN (SELECT local_date, sum(n_pixels) AS n FROM cp_Aqua GROUP BY 1) a ON a.local_date = g.local_date
                 LEFT JOIN (SELECT local_date, sum(n_pixels) AS n FROM cp_Terra GROUP BY 1) t ON t.local_date = g.local_date),
           w AS (SELECT *, median(t) OVER win AS tm, median(a / greatest(t, 1)) OVER win AS rm FROM d
                 WINDOW win AS (ORDER BY local_date ROWS BETWEEN 30 PRECEDING AND 30 FOLLOWING))
      SELECT local_date FROM w WHERE tm >= {GAP_MIN} AND t >= 0.5 * tm AND a < 0.25 * rm * t""")
    gap, days = "local_date IN (SELECT local_date FROM gaps)", [r[0] for r in con.execute("SELECT local_date FROM gaps ORDER BY 1").fetchall()]
    out["aqua_gaps"] = [[f"{a}", f"{b}"] for a, b in zip(
        [d for i, d in enumerate(days) if i == 0 or (d - days[i - 1]).days > 1],
        [d for i, d in enumerate(days) if i == len(days) - 1 or (days[i + 1] - d).days > 1])]
    clean = f"{window} AND NOT {gap}"

    # Quantiles of the reference per 5 degree tile and calendar month in the overlap years, with zero months filled in
    con.execute(f"""CREATE TEMP TABLE base5 AS
      WITH a AS (SELECT t5x, t5y, month, sum(n_pixels) AS n
                 FROM (SELECT *, {H.T5}, {MONTH} FROM cp_{ref} WHERE {clean}) GROUP BY ALL),
           g AS (SELECT t5x, t5y, month FROM (SELECT DISTINCT t5x, t5y FROM a)
                 CROSS JOIN (SELECT CAST(unnest(generate_series({v1}, DATE '{OVERLAP_END}-12-01', INTERVAL 1 MONTH)) AS DATE) AS month))
      SELECT g.t5x, g.t5y, month(g.month) AS m, quantile_cont(coalesce(a.n, 0), {H.QUANTILES}) AS q
      FROM g LEFT JOIN a ON a.t5x = g.t5x AND a.t5y = g.t5y AND a.month = g.month GROUP BY ALL""")

    # MODIS -> VIIRS. Aqua carries the years before VIIRS, Terra the months before Aqua and the days Aqua missed.
    first, last = convert(con, "Aqua", ref, window, gap, f"local_date < {v1}")
    out["satellites"][ref] = {"window": [f"{begin[ref]:%Y-%m-%d}", f"{OVERLAP_END}-12-31"], **validate(con, "pred_Aqua", ref, clean)}
    convert(con, "Terra", ref, window, gap, f"local_date < {v1}")
    terra = validate(con, "pred_Terra", ref, clean)
    out["terra"] = {"error": terra["overall"][H.METHOD], **{k: terra["overall"][k] for k in H.ESTIMATE}, "range": terra["range"]}

    # The same test done the way the record is used: learn from the later overlap years, predict the earlier ones.
    # The real record goes further back (to 2000), so this is the closest proof the data allows.
    mid = (first + last + 1) // 2
    if first < mid <= last:
        H.fit(con, "f", "cp_Aqua", f"cp_{ref}", f"{clean} AND year(local_date) >= {mid}")
        H.fit_frp(con, "f", "cp_Aqua", f"cp_{ref}", f"{clean} AND year(local_date) >= {mid}")
        con.execute(f"""CREATE TEMP TABLE pred_back AS SELECT p.*, q.est_frp
                        FROM ({H.apply('f', 'cp_Aqua', f'{window} AND year(local_date) < {mid}')}) p
                        JOIN ({H.apply_frp('f', 'cp_Aqua', f'{window} AND year(local_date) < {mid}')}) q USING ({H.KEY})""")
        back = validate(con, "pred_back", ref, f"{clean} AND year(local_date) < {mid}")["overall"]
        out["satellites"][ref]["backward"] = {"train": [mid, last], "test": [first, mid - 1],
                                              **{k: back[k] for k in ("raw", "global_factor", "ratio", "ratio_dn", "table", "bias_table", "bias_ratio_dn")}}

    if len(viirs) == 2:   # two identical instruments: how far apart their raw counts are, and whether one runs high
        both = f"local_date >= {starts[viirs[1]]}"
        side = lambda s: f"(SELECT t5x, t5y, month, sum(n_pixels) AS n FROM (SELECT *, {H.T5}, {MONTH} FROM cp_{s} WHERE {both}) GROUP BY ALL)"
        err, bias = con.execute(f"""
          SELECT sum(abs(coalesce(a.n, 0) - coalesce(b.n, 0))) / (sum(coalesce(a.n, 0) + coalesce(b.n, 0)) / 2),
                 sum(coalesce(b.n, 0)) / sum(coalesce(a.n, 0))
          FROM {side(viirs[0])} a FULL JOIN {side(viirs[1])} b ON a.t5x = b.t5x AND a.t5y = b.t5y AND a.month = b.month""").fetchone()
        out["twin"] = {"overlap": err, "bias": bias}

    # Monthly table per cell: raw counts per satellite, harmonized value, out-of-sample predictions.
    # Before Aqua: converted Terra. Then converted Aqua (Terra on the days Aqua missed, "fill"). From the first
    # full VIIRS month: VIIRS as measured, each date from the newest VIIRS satellite flying.
    a = f"DATE '{H.AQUA_START}'"
    cols = ("raw_terra", "raw_aqua", "raw_n20", "raw_snpp", "harm", "harm_ratio", "fill", "pred_n20", "pred_snpp", "frp", "harm_night")
    # harm_night is the same per-row value as harm, kept for night rows only
    part = lambda src, **v: (f"SELECT cell_x, cell_y, {MONTH}, " + ", ".join(f"{v.get(c, 0)} AS {c}" for c in cols if c != "harm_night")
                             + f", CASE WHEN daynight = 'N' THEN {v.get('harm', 0)} ELSE 0 END AS harm_night FROM {src}")
    est = H.ESTIMATE[H.METHOD]
    when = lambda cond, c: f"CASE WHEN {cond} THEN {c} ELSE 0 END"
    old_gap = f"{gap} AND local_date < {v1}"
    early = lambda c: when(f"local_date < {a} OR ({old_gap})", c)
    aqua = lambda c: when(f"local_date >= {a} AND local_date < {v1} AND NOT {gap}", c)
    parts = [part("cp_Terra", raw_terra="n_pixels"), part("cp_Aqua", raw_aqua="n_pixels"),
             part("pred_Terra", harm=early(est), harm_ratio=early("est_ratio"), fill=when(old_gap, est), frp=early("est_frp")),
             part("pred_Aqua", harm=aqua(est), harm_ratio=aqua("est_ratio"), frp=aqua("est_frp"),
                  **{f"pred_{ref.lower()}": when(f"local_date >= {v1}", est)})]   # converted Aqua in the test years, to compare with real VIIRS
    for i, sat in enumerate(viirs):
        live = f"local_date >= {starts[sat]}" + (f" AND local_date < {starts[viirs[i + 1]]}" if i + 1 < len(viirs) else "")
        parts.append(part(f"cp_{sat}", harm=when(live, "n_pixels"), harm_ratio=when(live, "n_pixels"), frp=when(live, "frp_sum"),
                          **{f"raw_{sat.lower()}": "n_pixels"}))
    sums = ", ".join(f"sum({c}) AS {c}" for c in cols)
    con.execute(f"CREATE TABLE monthly AS SELECT cell_x, cell_y, month, {sums} FROM ({' UNION ALL '.join(parts)}) GROUP BY ALL")

    # The jump when VIIRS starts: mean yearly total of the years after over the years before. Aqua alone flew
    # through both with a stable orbit, so its number is the real change; the harmonized record should match it.
    y1 = begin[ref].year
    before, after = f"year(month) BETWEEN {max(y1 - 9, 2003)} AND {y1 - 1}", f"year(month) BETWEEN {y1 + 1} AND {OVERLAP_END}"
    step = lambda c: f"(sum({c}) FILTER ({after}) / nullif(count(DISTINCT year(month)) FILTER ({after}), 0)) / nullif(sum({c}) FILTER ({before}) / nullif(count(DISTINCT year(month)) FILTER ({before}), 0), 0)"
    out["step"] = dict(zip(("raw", "harmonized", "aqua"), con.execute(
        f"SELECT {step('raw_terra + raw_aqua + raw_n20 + raw_snpp')}, {step('harm')}, {step('raw_aqua')} FROM monthly").fetchone()))
    out["step"]["years"] = [[max(y1 - 9, 2003), y1 - 1], [y1 + 1, OVERLAP_END]]

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
                           sum(harm_night) AS harm_night
                    FROM monthly GROUP BY ALL ORDER BY month""", serve / "globe.parquet")
    (serve / "validation.json").write_text(json.dumps(out, indent=1, default=str))
    con.close()
    pack_globe(serve)
    static_cells(root)
    db.unlink()
    shutil.rmtree(root / "tmp_duck", ignore_errors=True)
    print("built", serve, flush=True)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path("data/world"))
    ap.add_argument("--countries", help="comma-separated country names as in the FIRMS file names; default all")
    ap.add_argument("--sensors", nargs="+", default=list(SENSORS), choices=list(SENSORS))
    ap.add_argument("--delete-zips", action="store_true", help="delete each zip after its Parquet file is written")
    args = ap.parse_args()
    wanted = {c.strip().lower() for c in args.countries.split(",")} if args.countries else None
    for sensor in args.sensors:
        for year in YEARS[sensor]:
            ingest(args.root, sensor, year, wanted, args.delete_zips)
    result = build(args.root, args.sensors)
    for sat, v in result["satellites"].items():
        print(sat, "held-out error:", {k: round(x, 3) for k, x in v["overall"].items()})
