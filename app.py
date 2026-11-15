"""API and web page for the harmonized fire calendar.

    uvicorn app:app --port 8000

Reads the tables that pipeline.py wrote under data/world (or data/mx, or $FIRE_DATA).
"""
import csv
import gzip
import datetime
import io
import json
import calendar as cal
import math
import os
import re
import struct
import threading
import time
import urllib.request
from pathlib import Path

import duckdb
from array import array

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import harmonize as H
import tiles as T

HERE = Path(__file__).parent
ROOT = Path(os.environ.get("FIRE_DATA") or next(
    (p for p in (HERE / "data/world", HERE / "data/mx") if (p / "serve/monthly.parquet").exists()), HERE / "data/world"))
if not (ROOT / "serve/monthly.parquet").exists():
    raise SystemExit(f"No data in {ROOT}. Run: python pipeline.py --root data/mx --countries Mexico")

VAL = json.loads((ROOT / "serve/validation.json").read_text())
PRIMARY = VAL["primary"]
db = duckdb.connect()
for t in ("monthly", "monthly_country", "globe"):
    db.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{(ROOT / 'serve').as_posix()}/{t}.parquet')")
try:   # polygons need the spatial extension; without it a polygon is treated as its bounding box
    db.execute("INSTALL spatial; LOAD spatial")
    SPATIAL = True
except Exception:
    SPATIAL = False
FIRST = "2000-11-01"
LAST = db.execute("SELECT max(month) FROM monthly_country").fetchone()[0].isoformat()
PROVISIONAL = VAL.get("provisional")   # first month built from FIRMS near-real-time files (pipeline.build): first numbers from here on
BOXES = {c: [round(v, 2) for v in box] for c, *box in db.execute(
    f"SELECT * FROM read_parquet('{(ROOT / 'serve').as_posix()}/countries.parquet')").fetchall()}
COUNTRIES = list(BOXES)
COLS = {r[0] for r in db.execute("DESCRIBE monthly").fetchall()}
NIGHT, FRP = "harm_night" in COLS, "frp" in COLS   # data built before day/night and FRP existed lacks these columns
VV = VAL.get("viirs") if "vharm" in COLS else None   # VIIRS units; data built before them offers the unit aqua only
UNITS = ["viirs", "aqua"] if VV else ["aqua"]
REF = HERE / "data/reference"   # Natural Earth states and places, shared by every data root (see reference.py)
for t in ("states", "places"):
    if (REF / f"{t}.parquet").exists():
        db.execute(f"CREATE VIEW ref_{t} AS SELECT * FROM read_parquet('{(REF / f'{t}.parquet').as_posix()}')")
HAS = {t: (REF / f"{t}.parquet").exists() for t in ("states", "places")}
RAW = ("raw_terra", "raw_aqua", "raw_n20", "raw_snpp", "pred_n20", "pred_snpp", "fill") + (("vpred",) if VV else ())
MAX_EXPORT = 500_000

# Live layer: the public FIRMS file with the last 7 days of NOAA-20 detections (no key needed),
# converted with the tables the pipeline saved. Near-real-time data, so the result is provisional.
LIVE_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv"
# every model table must be there: data built before a table was added must not stop the server
LIVE_OK = (PRIMARY == "N20" and (ROOT / "serve/cell_country.parquet").exists()
           and all((ROOT / "serve/model" / f"{t}.parquet").exists() for t in H.MODEL_TABLES))
if LIVE_OK:
    for t in H.MODEL_TABLES:
        db.execute(f"CREATE VIEW m_{t} AS SELECT * FROM read_parquet('{(ROOT / 'serve/model').as_posix()}/{t}.parquet')")
    db.execute(f"CREATE VIEW cell_country AS SELECT * FROM read_parquet('{(ROOT / 'serve').as_posix()}/cell_country.parquet')")
LIVE_FILE = ROOT / "live.csv"
STATIC_FILE = ROOT / "serve/static.parquet"   # from pipeline.static_cells; absent on data built before it existed
SEA_C = "(SELECT * FROM live_sea LEFT JOIN cell_country USING (cell_x, cell_y))"
GONE_C = "(SELECT * FROM live_gone LEFT JOIN cell_country USING (cell_x, cell_y))"
LIVE_C = "(SELECT * FROM live LEFT JOIN cell_country USING (cell_x, cell_y))"
DET_C = "(SELECT * FROM live_det LEFT JOIN cell_country USING (cell_x, cell_y))"
TIMES = {"all": None, "day": "daynight = 'D'", "night": "daynight = 'N'"}
live_lock, live_state = threading.Lock(), {"loaded": 0.0}
MEMO = {}


def memo(fresh=False):
    """Keep the answers for the last 256 areas. A page that asks for the same area in a loop, or many viewers of
    one country, then cost nothing. On 15 Nov 2026 one such page made every other request take 30 to 55 seconds."""
    def deco(fn):
        def inner(*args):
            if fresh:
                load_live()   # renews the last 7 days when they are over an hour old; the key below then changes
            key = (fn.__name__, live_state["loaded"] if fresh else 0, json.dumps(args, sort_keys=True))
            if key not in MEMO:
                r = fn(*args)
                if isinstance(r, Response):   # a CSV download: not kept
                    return r
                if len(MEMO) >= 256:
                    MEMO.pop(next(iter(MEMO)), None)
                MEMO[key] = r
            return MEMO[key]
        return inner
    return deco


def load_live():
    """Download (at most once per hour) and convert the last 7 days. -> {"from": date, "to": date}"""
    if not LIVE_OK:
        raise HTTPException(404, "live layer needs the saved conversion tables for NOAA-20")
    with live_lock:
        if time.time() - live_state["loaded"] > 3600:
            path = LIVE_FILE
            try:
                urllib.request.urlretrieve(LIVE_URL, path.with_suffix(".part"))
                os.replace(path.with_suffix(".part"), path)
            except OSError:
                if not path.exists():   # offline and nothing cached
                    raise HTTPException(503, "FIRMS live file not reachable")
            cur = db.cursor()
            # the live file has no type column: drop cells that the archive shows are gas flares, volcanoes or other static sources
            gone = f"(cx, cy) IN (SELECT cell_x, cell_y FROM read_parquet('{STATIC_FILE.as_posix()}'))" if STATIC_FILE.exists() else "false"
            cur.execute(f"""CREATE OR REPLACE TABLE live_raw AS
              SELECT *, CAST(floor(longitude / {H.CELL}) AS INT) AS cx, CAST(floor(latitude / {H.CELL}) AS INT) AS cy FROM (
                SELECT latitude, longitude, acq_date, CAST(acq_time AS SMALLINT) AS acq_time, 'N20' AS satellite, confidence,
                       frp, daynight, CAST(NULL AS TINYINT) AS type, CAST(NULL AS VARCHAR) AS country
                FROM read_csv('{path.as_posix()}', types = {{'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'confidence': 'VARCHAR'}}))""")
            cur.execute(f"ALTER TABLE live_raw ADD COLUMN gone BOOLEAN; UPDATE live_raw SET gone = {gone}")
            cur.execute(f"CREATE OR REPLACE TABLE live_gone AS SELECT cx AS cell_x, cy AS cell_y FROM live_raw WHERE gone AND {H.CLEAN}")
            # the record covers land only: a detection outside every known land cell must lie in (or within ~5 km of) a first-level region
            # (a 0.1 degree box prefilters; ST_DWithin works in degrees, so the margin shrinks toward the poles)
            sea = "false"
            if SPATIAL and HAS["states"]:
                cur.execute(f"""CREATE OR REPLACE TEMP TABLE live_land AS
                  SELECT DISTINCT p.lon, p.lat FROM (SELECT DISTINCT longitude AS lon, latitude AS lat FROM live_raw
                    WHERE NOT gone AND (cx, cy) NOT IN (SELECT cell_x, cell_y FROM cell_country)) p
                  JOIN (SELECT w, s, e, n, ST_GeomFromGeoJSON(geojson) AS g FROM ref_states) r
                    ON p.lon BETWEEN r.w - 0.1 AND r.e + 0.1 AND p.lat BETWEEN r.s - 0.1 AND r.n + 0.1
                  WHERE ST_DWithin(r.g, ST_Point(p.lon, p.lat), 0.05)""")
                sea = "(cx, cy) NOT IN (SELECT cell_x, cell_y FROM cell_country) AND (longitude, latitude) NOT IN (SELECT lon, lat FROM live_land)"
            cur.execute(f"ALTER TABLE live_raw ADD COLUMN sea BOOLEAN; UPDATE live_raw SET sea = NOT gone AND {sea}")
            cur.execute(f"CREATE OR REPLACE TABLE live_sea AS SELECT cx AS cell_x, cy AS cell_y FROM live_raw WHERE sea AND {H.CLEAN}")
            src = "(SELECT * EXCLUDE (cx, cy, gone, sea) FROM live_raw WHERE NOT gone AND NOT sea)"
            cur.execute(f"CREATE OR REPLACE TABLE live_cp AS {H.cell_pass_sql(src, 'N20')}")
            cur.execute(f"""CREATE OR REPLACE TABLE live AS
                            SELECT cell_x, cell_y, daynight, n_pixels, est_table AS harm FROM ({H.apply('m', 'live_cp', 'TRUE')})""")
            # one row per detection, cleaned like H.CLEAN; local solar time = UTC + longitude / 15 hours
            cur.execute(f"""CREATE OR REPLACE TABLE live_det AS
              SELECT d.*, y.days FROM (
                SELECT longitude AS lon, latitude AS lat, CAST(ts AS DATE) AS d, strftime(ts, '%H:%M') AS t, frp, daynight,
                       CAST(floor(longitude / {H.CELL}) AS INT) AS cell_x, CAST(floor(latitude / {H.CELL}) AS INT) AS cell_y
                FROM (SELECT *, acq_date + to_minutes(CAST(acq_time // 100 * 60 + acq_time % 100 + round(longitude * 4) AS BIGINT)) AS ts
                      FROM {src} WHERE satellite = 'N20' AND {H.CLEAN})) d
              JOIN (SELECT cell_x, cell_y, count(DISTINCT d) AS days FROM (
                      SELECT CAST(floor(longitude / {H.CELL}) AS INT) AS cell_x, CAST(floor(latitude / {H.CELL}) AS INT) AS cell_y,
                             CAST(acq_date + to_minutes(CAST(acq_time // 100 * 60 + acq_time % 100 + round(longitude * 4) AS BIGINT)) AS DATE) AS d
                      FROM {src} WHERE satellite = 'N20' AND {H.CLEAN}) GROUP BY 1, 2) y USING (cell_x, cell_y)""")
            strong = cur.execute("SELECT round(quantile_cont(frp, 0.9)) FROM live_det").fetchone()[0]
            first, last = cur.execute("SELECT min(acq_date), max(acq_date) FROM live_raw").fetchone()
            live_state.update(loaded=time.time(), bin=None, strong_mw=strong or 0, masked=STATIC_FILE.exists(), sea=sea != "false", **{"from": first.isoformat(), "to": last.isoformat()})
    return {"from": live_state["from"], "to": live_state["to"]}

app = FastAPI(title="Fire calendar")


def parse_bbox(text):
    try:
        w, s, e, n = (float(x) for x in text.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be west,south,east,north")
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise HTTPException(422, "bbox must satisfy -180 <= west < east <= 180 and -90 <= south < north <= 90")
    return w, s, e, n


def parse_month(text, name):
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", text):
        raise HTTPException(422, f"{name} must be YYYY-MM")
    return text + "-01"


def poly_points(geom):
    """-> (xs, ys) over all coordinates of a Polygon or MultiPolygon, or HTTP 422."""
    try:
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        assert geom["type"] in ("Polygon", "MultiPolygon") and polys and all(polys)
        assert all(len(ring) >= 4 for poly in polys for ring in poly)
        pts = [p for poly in polys for ring in poly for p in ring]
        assert len(pts) <= 20000
        xs, ys = [float(p[0]) for p in pts], [float(p[1]) for p in pts]
        assert all(map(math.isfinite, xs + ys))
    except (KeyError, IndexError, TypeError, ValueError, AssertionError):
        raise HTTPException(422, "polygon must be a GeoJSON Polygon or MultiPolygon with at most 20000 points")
    return xs, ys


def area(country, bbox, polygon, cells="monthly", by_country="monthly_country"):
    """-> (table and WHERE clause, parameters) for the selected area."""
    if country == "World":
        return by_country, []
    if country:
        if country not in COUNTRIES:
            raise HTTPException(404, "unknown country")
        return f"{by_country} WHERE country = ?", [country]
    if polygon:
        xs, ys = poly_points(polygon)
        bbox = f"{min(xs)},{min(ys)},{max(xs)},{max(ys)}"
    if not bbox:
        raise HTTPException(422, "give a country, a bbox or a polygon")
    w, s, e, n = parse_bbox(bbox)
    cx, cy = f"(cell_x + 0.5) * {H.CELL}", f"(cell_y + 0.5) * {H.CELL}"   # a cell belongs to the area that holds its center
    sql = (f"{cells} WHERE cell_y BETWEEN ? AND ? AND cell_x BETWEEN ? AND ? "
           f"AND {cx} >= ? AND {cx} < ? AND {cy} >= ? AND {cy} < ?")
    params = [math.floor(s / H.CELL) - 1, math.floor(n / H.CELL) + 1, math.floor(w / H.CELL) - 1,
              math.floor(e / H.CELL) + 1, w, e, s, n]
    if polygon and SPATIAL:
        sql += f" AND ST_Contains(ST_GeomFromGeoJSON(?), ST_Point({cx}, {cy}))"
        params.append(json.dumps({"type": polygon["type"], "coordinates": polygon["coordinates"]}))
    return sql, params


def add(src, *conds):
    """Append conditions to the output of area()."""
    for c in conds:
        if c:
            src += (" AND " if " WHERE " in src else " WHERE ") + c
    return src


def run(sql, params=(), polygon=None):
    try:
        return db.cursor().execute(sql, list(params))
    except duckdb.Error as err:
        if polygon:
            raise HTTPException(422, f"polygon could not be used: {str(err)[:120]}")
        raise


def parse_time(text):
    if text not in TIMES:
        raise HTTPException(422, "time must be all, day or night")
    return text


def bounds(value, table):
    """Range of a converted value, from the spread seen on held-out data for values of this size."""
    row = next((r for r in reversed(table) if r["lo"] <= value), None)
    return (value * row["q10"], value * row["q90"]) if row else (value, value)


def parse_unit(unit):
    """-> (unit, its columns): value, night part, live column and baseline years."""
    unit = unit or UNITS[0]
    if unit not in ("viirs", "aqua"):
        raise HTTPException(422, "unit must be viirs or aqua")
    if unit not in UNITS:
        raise HTTPException(409, "Rebuild the data to use this unit")
    if unit == "viirs":
        return unit, {"col": "vharm", "night": "vharm_night", "live": "n_pixels", "base": tuple(VV["baseline"]), "name": VV["unit"]}
    return unit, {"col": "harm", "night": "harm_night" if NIGHT else None, "live": "harm", "base": H.BASELINE, "name": VAL["unit"]}


def viirs_month(iso, v):
    """-> (source, measured, range table) of a month (YYYY-MM-DD) in VIIRS units; v is validation.json["viirs"]."""
    if iso < H.AQUA_START:
        source, table = "terra_up", v["terra"]["range"]
    elif iso < v["start"]:
        source, table = "modis_up", v["both"]["range"]
    elif iso < v["ref_start"]:   # the older VIIRS satellite, scaled to the reference
        source, table = "snpp_scaled", v.get("twin", {}).get("range", [])
    else:
        source, table = v["reference"].lower(), []
    return source, iso >= v["start"], table


@memo()
def calendar(country, bbox, polygon, start, end, method, fmt, time="all", unit=None):
    if method not in ("table", "ratio"):
        raise HTTPException(422, "method must be table or ratio")
    parse_time(time)
    unit, U = parse_unit(unit)
    if method == "ratio" and (time != "all" or unit != "aqua"):
        raise HTTPException(422, "method ratio works with time all and unit aqua only")
    if time != "all" and not U["night"]:
        raise HTTPException(409, "Rebuild the data to use this filter")
    src, params = area(country, bbox, polygon)
    start, end = parse_month(start, "start"), parse_month(end, "end")
    col, nc, base = U["col"], U["night"], U["base"]
    value = {"all": col if method == "table" else "harm_ratio", "night": nc, "day": f"{col} - {nc}"}[time]
    extra = f"{f'sum({nc})' if nc else '0'} AS night, {'sum(frp)' if FRP else '0'} AS frp"
    cur = db.cursor().execute(f"""
      WITH a AS (SELECT month, sum({value}) AS v, {extra}, {', '.join(f'sum({c}) AS {c}' for c in RAW)} FROM {src} GROUP BY month),
           s AS (SELECT g.month, coalesce(a.v, 0) AS v, coalesce(a.night, 0) AS night, coalesce(a.frp, 0) AS frp,
                        {', '.join(f'coalesce(a.{c}, 0) AS {c}' for c in RAW)}
                 FROM (SELECT CAST(unnest(generate_series(DATE '{FIRST}', DATE '{LAST}', INTERVAL 1 MONTH)) AS DATE) AS month) g
                 LEFT JOIN a ON a.month = g.month),
           r AS (SELECT *, rank() OVER (PARTITION BY month(month) ORDER BY v DESC) AS rank FROM s),
           b AS (SELECT month(month) AS m, quantile_cont(v, {H.QUANTILES}) AS q, median(night) AS night_median, median(frp) AS frp_median FROM s
                 WHERE year(month) BETWEEN {base[0]} AND {base[1]} GROUP BY 1)
      SELECT r.*, b.q[3] AS median, b.night_median, b.frp_median, {H.anomaly_sql('r.v', 'b.q')} AS anomaly
      FROM r JOIN b ON b.m = month(r.month) WHERE r.month BETWEEN ? AND ? ORDER BY r.month""", params + [start, end])
    names = [d[0] for d in cur.description]
    months = []
    for rec in (dict(zip(names, row)) for row in cur.fetchall()):
        iso = rec["month"].isoformat()
        if unit == "viirs":
            source, measured, table = viirs_month(iso, VV)
        else:
            source = "terra_scaled" if iso < H.AQUA_START else "aqua" if iso < H.MODEL_START else f"{PRIMARY.lower()}_model"
            table, measured = {"terra_scaled": VAL["terra"]["range"], "aqua": []}.get(source, VAL["satellites"][PRIMARY]["range"]), source == "aqua"
        low, high = bounds(rec["v"], table)
        months.append({"month": iso[:7], "harmonized": round(rec["v"], 1), "low": round(low, 1), "high": round(high, 1),
                       "median": round(rec["median"], 1), "anomaly": rec["anomaly"], "rank": rec["rank"], "source": source, "measured": measured,
                       "night": round(rec["night"], 1) if nc else None, "night_median": round(rec["night_median"], 1) if nc else None,
                       "frp": round(rec["frp"], 1) if FRP else None, "frp_median": round(rec["frp_median"], 1) if FRP else None,
                       "filled": round(rec["fill"], 1) if unit == "aqua" else 0,   # part that replaces days when Aqua did not record
                       "raw": {k[4:]: int(rec[k]) for k in RAW[:4]},
                       "pred": {"modis": round(rec["vpred"], 1)} if unit == "viirs" else {k[5:]: round(rec[k], 1) for k in RAW[4:6]}})
    if fmt == "csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["month", "harmonized", "low", "high", "median", "anomaly", "source", "measured", "unit",
                    "raw_terra", "raw_aqua", "raw_n20", "raw_snpp"])
        for m in months:
            w.writerow([m["month"], m["harmonized"], m["low"], m["high"], m["median"], m["anomaly"], m["source"], m["measured"], unit, *m["raw"].values()])
        return Response(out.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": "attachment; filename=fire_calendar.csv"})
    return {"unit": unit, "unit_name": U["name"], "baseline": list(base), "method": method,
            "polygon_exact": bool(polygon and SPATIAL), "time": time, "months": months}


@app.get("/api/calendar")
def calendar_get(country: str | None = None, bbox: str | None = None, start: str = FIRST[:7], end: str = LAST[:7],
                 method: str = "table", format: str = "json", time: str = "all", unit: str | None = None):
    return calendar(country, bbox, None, start, end, method, format, time, unit)


@app.post("/api/calendar")
def calendar_post(body: dict = Body(...)):
    return calendar(None, None, body.get("polygon"), body.get("start", FIRST[:7]), body.get("end", LAST[:7]),
                    body.get("method", "table"), body.get("format", "json"), body.get("time", "all"), body.get("unit"))


@memo(fresh=True)
def live(country, bbox, polygon, time="all", unit=None):
    state = load_live()
    tc = TIMES[parse_time(time)]
    unit, U = parse_unit(unit)
    src, params = area(country, bbox, polygon, "live", LIVE_C)
    raw, harm, night = run(f"""SELECT coalesce(sum(n_pixels), 0), coalesce(sum({U['live']}), 0),
                               coalesce(sum(n_pixels) FILTER (daynight = 'N'), 0) FROM {add(src, tc)}""", params, polygon).fetchone()
    src, params = area(country, bbox, polygon, "live_det", DET_C)
    strong = run(f"SELECT count(*) FROM {add(src, tc, 'frp >= ?')}", params + [live_state["strong_mw"]], polygon).fetchone()[0]
    src, params = area(country, bbox, polygon, "live_gone", GONE_C)
    removed = run(f"SELECT count(*) FROM {src}", params, polygon).fetchone()[0] if live_state["masked"] else None   # inside the selected area
    src, params = area(country, bbox, polygon, "live_sea", SEA_C)
    sea = run(f"SELECT count(*) FROM {src}", params, polygon).fetchone()[0] if live_state["sea"] else None
    return {**state, "unit": unit, "static_removed": removed, "sea_removed": sea, "raw": int(raw), "harmonized": round(harm, 1), "sensor": "VIIRS NOAA-20, near-real-time",
            "night_share": round(night / raw, 3) if raw else 0, "strong": strong, "strong_mw": live_state["strong_mw"]}


@app.get("/api/live")
def live_get(country: str | None = None, bbox: str | None = None, time: str = "all", unit: str | None = None):
    """Last 7 days in the selected area: raw detections and the count in the unit (viirs: the same number)."""
    return live(country, bbox, None, time, unit)


@app.post("/api/live")
def live_post(body: dict = Body(...)):
    return live(None, None, body.get("polygon"), body.get("time", "all"), body.get("unit"))


@app.get("/api/live/cells")
def live_cells(time: str = "all", unit: str | None = None):
    """Last 7 days as 0.5 degree cells: [west, south, raw detections, count in the unit]."""
    state = load_live()
    tc, (_, U) = TIMES[parse_time(time)], parse_unit(unit)
    cur = db.cursor().execute(f"""SELECT floor(cell_x / 10.0) * 0.5, floor(cell_y / 10.0) * 0.5, sum(n_pixels), round(sum({U['live']}), 1)
                                 FROM {add('live', tc)} GROUP BY 1, 2""")
    return {**state, "cells": cur.fetchall()}


MAX_POINTS = 20000


def live_points(country, bbox, polygon, time, strong):
    state = load_live()
    if strong not in (0, 1, "0", "1", True, False):
        raise HTTPException(422, "strong must be 0 or 1")
    src, params = area(country, bbox, polygon, "live_det", DET_C)
    src = add(src, TIMES[parse_time(time)], "frp >= ?" if int(strong) else None)
    if int(strong):
        params = params + [live_state["strong_mw"]]
    rows = run(f"""SELECT round(lon, 4), round(lat, 4), CAST(d AS VARCHAR), t, round(frp, 1), daynight, days FROM {src}
                   ORDER BY frp DESC NULLS LAST LIMIT {MAX_POINTS + 1}""", params, polygon).fetchall()
    return {"from": state["from"], "to": state["to"], "truncated": len(rows) > MAX_POINTS, "points": [list(r) for r in rows[:MAX_POINTS]]}


def pack_points():
    """Every detection of the last 7 days as one gzip file, sorted by 0.5 degree bucket.

    Little-endian, every block padded to a multiple of 4 bytes: uint32 N and N bytes of JSON
    {n, from, to, first_day, days, strong_mw, buckets}; Float32[n] lon, lat, frp (MW); Uint16[n] minute of the
    local solar day; Uint8[n] day (local date minus first_day); Uint8[n] flags (bit 0 = night); Uint8[n] days
    burning; Uint32[buckets] bucket ids (row * 720 + column) and Uint32[buckets + 1] starts into the points."""
    rows = db.cursor().execute("SELECT lon, lat, coalesce(frp, 0), t, d, daynight, days FROM live_det").fetchall()
    keyed = sorted(((math.floor((r[1] + 90) / 0.5) * 720 + math.floor((r[0] + 180) / 0.5), r) for r in rows), key=lambda k: k[0])
    ids, starts = [], []
    for i, (b, _) in enumerate(keyed):
        if not ids or ids[-1] != b:
            ids.append(b)
            starts.append(i)
    starts.append(len(keyed))
    pts = [r for _, r in keyed]
    first = min((r[4] for r in pts), default=None)
    head = json.dumps({"n": len(pts), "from": live_state["from"], "to": live_state["to"], "first_day": first.isoformat() if first else live_state["from"],
                       "days": len({r[4] for r in pts}), "strong_mw": live_state["strong_mw"], "buckets": len(ids)}).encode()
    arr = lambda code, v: array(code, v).tobytes()   # little-endian machines only, like the page
    parts = [T._pad(struct.pack("<I", len(head)) + head), arr("f", [r[0] for r in pts]), arr("f", [r[1] for r in pts]), arr("f", [r[2] for r in pts]),
             T._pad(arr("H", [int(r[3][:2]) * 60 + int(r[3][3:]) for r in pts])),
             T._pad(arr("B", [(r[4] - first).days for r in pts])), T._pad(arr("B", [r[5] == "N" for r in pts])),
             T._pad(arr("B", [min(r[6], 255) for r in pts])), arr("I", ids), arr("I", starts)]
    return gzip.compress(b"".join(parts), 6, mtime=0)


def bin_response(request, data, etag, media="application/octet-stream"):
    heads = {"Content-Encoding": "gzip", "Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=heads)
    return Response(data, media_type=media, headers=heads)


@app.get("/api/live/points.bin")
def live_points_bin(request: Request):
    """All detections of the last 7 days in one binary file; the page filters and draws them locally."""
    load_live()
    with live_lock:
        if live_state["bin"] is None:
            live_state["bin"] = pack_points()
        data = live_state["bin"]
    return bin_response(request, data, f'"live-{live_state["loaded"]:.0f}-{len(data)}"')


TRUST_FILE, trust_state = ROOT / "serve/trust.json", {"mtime": None}


@app.get("/api/trust")
def trust(request: Request):
    """serve/trust.json (see pipeline.trust_cells), gzipped once and kept until the file changes."""
    try:
        st = TRUST_FILE.stat()
    except FileNotFoundError:
        raise HTTPException(404, "no trust.json: run python pipeline.py --root <data> --trust-only")
    with live_lock:
        if trust_state["mtime"] != st.st_mtime_ns:
            trust_state.update(mtime=st.st_mtime_ns, data=gzip.compress(TRUST_FILE.read_bytes(), 6, mtime=0))
        data = trust_state["data"]
    return bin_response(request, data, f'"{st.st_mtime_ns:x}-{len(data):x}"', "application/json")


@app.get("/api/tiles/{level}/{tx}/{ty}")
def tile(request: Request, level: int, tx: int, ty: int):
    """One map tile with every month (layout in tiles.py), built on first request and cached on disk."""
    if level not in T.LEVELS or not (0 <= tx < -(-7200 // T.LEVELS[level][1])) or not (0 <= ty < -(-3600 // T.LEVELS[level][1])):
        raise HTTPException(422, "level must be 1, 2 or 3 and tx, ty inside the world")
    path = T.ensure(ROOT / "serve", level, tx, ty)
    if not path:
        return Response(status_code=204)
    st = path.stat()
    return bin_response(request, path.read_bytes(), f'"{st.st_mtime_ns:x}-{st.st_size:x}"')


MAX_MONTH_POINTS = 300_000


@app.get("/api/points.bin")
def month_points(request: Request, month: str, bbox: str, day: int | None = None):
    """The detections the record counts (H.CLEAN), from all satellites, of one month (or one `day` of it) of local solar dates inside a box.

    Gzip; little-endian, every block padded to a multiple of 4 bytes: uint32 N and N bytes of JSON {n, month, day, truncated, sats};
    Float32[n] lon, lat, frp (MW); Uint16[n] minute of the local solar day; Uint8[n] day of the month; Uint8[n] flags
    (bit 0 = night, the other bits = index into sats). Strongest first, at most MAX_MONTH_POINTS."""
    w, s, e, n = parse_bbox(bbox)
    first = datetime.date.fromisoformat(parse_month(month, "month"))
    ndays = cal.monthrange(first.year, first.month)[1]
    if day is not None and not 1 <= day <= ndays:
        raise HTTPException(422, f"day must be 1 to {ndays} for {month}")
    lo = first.replace(day=day) if day else first
    hi = lo + datetime.timedelta(1 if day else ndays)
    years = {str((first - datetime.timedelta(1)).year), str((first + datetime.timedelta(32)).year)}   # a local date can be the UTC date of the next or last year
    files = [p for p in (ROOT / "hotspots").glob("*/*.parquet") if p.stem in years]
    if not files:
        raise HTTPException(404, "no hotspot files for this month")
    etag = f'"{max(p.stat().st_mtime_ns for p in files):x}-{month}-{day or 0}-{w},{s},{e},{n}"'
    if request.headers.get("if-none-match") == etag:
        return bin_response(request, b"", etag)   # 304 without running the query
    rows = db.cursor().execute(f"""
      SELECT longitude, latitude, coalesce(frp, 0), hour(ts) * 60 + minute(ts), day(ts), coalesce(satellite, '?'), daynight
      FROM (SELECT *, acq_date + to_minutes(CAST(acq_time // 100 * 60 + acq_time % 100 + round(longitude * 4) AS BIGINT)) AS ts
            FROM read_parquet({[p.as_posix() for p in files]}, union_by_name = true)
            WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND acq_date BETWEEN ? AND ? AND {H.CLEAN})
      WHERE ts >= ? AND ts < ?
      ORDER BY 3 DESC LIMIT {MAX_MONTH_POINTS + 1}""", [s, n, w, e, lo - datetime.timedelta(1), hi, lo, hi]).fetchall()   # local time is UTC +-12 h, so the UTC date is within a day
    cut = rows[:MAX_MONTH_POINTS]
    sats = sorted({r[5] for r in cut})
    head = json.dumps({"n": len(cut), "month": month, "day": day, "truncated": len(rows) > len(cut), "sats": sats}).encode()
    arr = lambda code, v: T._pad(array(code, v).tobytes())   # little-endian machines only, like the page
    data = b"".join((T._pad(struct.pack("<I", len(head)) + head), *(arr("f", [r[i] for r in cut]) for i in range(3)), arr("H", [r[3] for r in cut]),
                     arr("B", [r[4] for r in cut]), arr("B", [(r[6] == "N") | sats.index(r[5]) << 1 for r in cut])))
    return bin_response(request, gzip.compress(data, 4, mtime=0), etag)


@app.get("/api/live/points")
def live_points_get(country: str | None = None, bbox: str | None = None, time: str = "all", strong: int = 0):
    """Every detection of the last 7 days in the area: [lon, lat, local date, local time, FRP in MW, D or N, days burning]."""
    return live_points(country, bbox, None, time, strong)


@app.post("/api/live/points")
def live_points_post(body: dict = Body(...)):
    return live_points(None, None, body.get("polygon"), body.get("time", "all"), body.get("strong", 0))


COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def km_between(lon1, lat1, lon2, lat2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def label_for(lon, lat):
    """'12 km NE of Ocosingo' for the nearest populated place within 150 km, else None."""
    if not HAS["places"]:
        return None
    dx = 1.6 / max(math.cos(math.radians(lat)), 0.2)
    best = min(((km_between(lon, lat, x, y), name, x, y) for name, x, y in db.cursor().execute(
        "SELECT name, lon, lat FROM ref_places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
        [lat - 1.6, lat + 1.6, lon - dx, lon + dx]).fetchall()), default=None)
    if not best or best[0] > 150:
        return None
    km, name, x, y = best
    if km < 5:
        return f"Near {name}"
    bearing = math.degrees(math.atan2((lon - x) * math.cos(math.radians(y)), lat - y)) % 360
    return f"{round(km)} km {COMPASS[round(bearing / 45) % 8]} of {name}"


@memo(fresh=True)
def live_places(country, bbox, polygon, time, unit=None):
    state = load_live()
    tc = TIMES[parse_time(time)]
    unit, U = parse_unit(unit)
    src, params = area(country, bbox, polygon, "live_det", DET_C)
    cells = {(x, y): (n, fmax or 0, nn, set(ds)) for x, y, n, fmax, nn, ds in run(
        f"""SELECT cell_x, cell_y, count(*), max(frp), count(*) FILTER (daynight = 'N'), list(DISTINCT d) FROM {add(src, tc)}
            GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3000""", params, polygon).fetchall()}
    src, params = area(country, bbox, polygon, "live", LIVE_C)
    harm = dict(((x, y), h) for x, y, h in run(f"SELECT cell_x, cell_y, sum({U['live']}) FROM {add(src, tc)} GROUP BY 1, 2", params, polygon).fetchall())
    groups, seen = [], set()   # touching cells (8 neighbors)
    for start in cells:
        if start in seen:
            continue
        seen.add(start)
        stack, members = [start], []
        while stack:
            x, y = stack.pop()
            members.append((x, y))
            for nb in ((x + i, y + j) for i in (-1, 0, 1) for j in (-1, 0, 1)):
                if nb in cells and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        n = sum(cells[c][0] for c in members)
        groups.append({"cells": members, "detections": n, "days": len(set().union(*(cells[c][3] for c in members))),
                       "frp_max": max(cells[c][1] for c in members), "night": sum(cells[c][2] for c in members) * 2 > n,
                       "harmonized": sum(harm.get(c, 0) for c in members),
                       "lon": sum((c[0] + 0.5) * H.CELL * cells[c][0] for c in members) / n,
                       "lat": sum((c[1] + 0.5) * H.CELL * cells[c][0] for c in members) / n})
    groups.sort(key=lambda g: (-g["days"], -g["frp_max"], -g["detections"]))
    groups = groups[:40]
    month = int(state["to"][5:7])
    recent_months = {}   # months of the last year on record with any fire, per cell
    years = {}   # years in which each cell had any fire in this calendar month
    allc = sorted({c for g in groups for c in g["cells"]})
    if allc:
        for x, y, yr in db.cursor().execute(f"""
            SELECT DISTINCT cell_x, cell_y, year(month) FROM monthly
            JOIN (SELECT unnest(?) AS cell_x, unnest(?) AS cell_y) USING (cell_x, cell_y)
            WHERE month(month) = ? AND {U['col']} > 0""",
                [[c[0] for c in allc], [c[1] for c in allc], month]).fetchall():
            years.setdefault((x, y), set()).add(yr)
        for x, y, mo in db.cursor().execute(f"""
            SELECT DISTINCT cell_x, cell_y, month FROM monthly
            JOIN (SELECT unnest(?) AS cell_x, unnest(?) AS cell_y) USING (cell_x, cell_y)
            WHERE month > CAST(? AS DATE) - INTERVAL 12 MONTH AND {U['col']} > 0""",
                [[c[0] for c in allc], [c[1] for c in allc], LAST]).fetchall():
            recent_months.setdefault((x, y), set()).add(mo)
    span = (datetime.date.fromisoformat(state["to"]) - datetime.date.fromisoformat(state["from"])).days + 1
    b0, b1 = U["base"]
    base, mname, out = b1 - b0 + 1, cal.month_name[month], []
    for g in groups:
        burned = set().union(*(years.get(c, set()) for c in g["cells"]))
        g["years_burned"] = sum(b0 <= y <= b1 for y in burned)
        g["recent_years"] = sum(y > int(LAST[:4]) - 3 for y in burned)   # sources that started after the baseline are not new
        g["strong"] = g["frp_max"] >= live_state["strong_mw"]
        g["months_last_year"] = len(set().union(*(recent_months.get(c, set()) for c in g["cells"])))
        g["permanent"] = g["months_last_year"] >= 6   # burns all year: probably a heat source, not a fire
        g["score"] = 1.5 * g["days"] + 1.5 * g["strong"] + 2 * (1 - g["years_burned"] / base) * (g["recent_years"] == 0 and not g["permanent"]) + 0.3 * math.log10(g["detections"])
    for g in sorted(groups, key=lambda g: (g["permanent"], -g["score"]))[:8]:
        why = [f"Burning {g['days']} of {span} days" if g["days"] > 1 else "Seen on one day"]
        if g["strong"]:
            why.append("strong")
        if g["permanent"]:
            why.append(f"burned here in {g['months_last_year']} of the last 12 months on record, possibly a permanent heat source")
        elif g["recent_years"] >= 2:
            why.append(f"burned here in {mname} in {g['recent_years']} of the last 3 years")
        elif g["years_burned"] <= 2 and not g["recent_years"]:
            why.append("new here" if g["years_burned"] == 0 and not g["months_last_year"] else f"rarely burns here in {mname}")
        out.append({"lon": round(g["lon"], 3), "lat": round(g["lat"], 3), "label": label_for(g["lon"], g["lat"]),
                    "detections": g["detections"], "harmonized": round(g["harmonized"], 1), "days": g["days"],
                    "frp_max": round(g["frp_max"], 1), "night": g["night"], "years_burned": g["years_burned"], "recent_years": g["recent_years"], "months_last_year": g["months_last_year"],
                    "baseline_years": base, "why": ", ".join(why)})
    return {"from": state["from"], "to": state["to"], "places": out}


@app.get("/api/live/places")
def live_places_get(country: str | None = None, bbox: str | None = None, time: str = "all", unit: str | None = None):
    """Where to look first: groups of touching cells with fire in the last 7 days, most urgent first."""
    return live_places(country, bbox, None, time, unit)


@app.post("/api/live/places")
def live_places_post(body: dict = Body(...)):
    return live_places(None, None, body.get("polygon"), body.get("time", "all"), body.get("unit"))


@app.get("/api/states")
def states(bbox: str):
    """First-level regions (states, provinces) that touch the box, largest first."""
    if not HAS["states"]:
        raise HTTPException(404, "reference data missing: run reference.py")
    w, s_, e, n = parse_bbox(bbox)
    rows = db.cursor().execute("""SELECT name, country, w, s, e, n, geojson FROM ref_states
                                  WHERE e >= ? AND w <= ? AND n >= ? AND s <= ? ORDER BY area DESC LIMIT 400""", [w, e, s_, n]).fetchall()
    return {"states": [{"name": a, "country": b, "bbox": [round(v, 3) for v in (c, d, e_, f)], "geometry": json.loads(g)}
                       for a, b, c, d, e_, f, g in rows]}


@app.get("/api/places")
def places(bbox: str, limit: int = Query(40, ge=1, le=500)):
    """Most populous places inside the box."""
    if not HAS["places"]:
        raise HTTPException(404, "reference data missing: run reference.py")
    w, s_, e, n = parse_bbox(bbox)
    rows = db.cursor().execute(f"""SELECT name, lon, lat, pop FROM ref_places WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?
                                   ORDER BY pop DESC LIMIT {limit}""", [w, e, s_, n]).fetchall()
    return {"places": [{"name": a, "lon": round(b, 3), "lat": round(c, 3), "pop": d} for a, b, c, d in rows]}


MAX_CELLS = 60000


@app.get("/api/cells")
def fine_cells(bbox: str, month: str, time: str = "all", normal: int = Query(0, ge=0, le=1), unit: str | None = None):
    """0.05 degree cells of the box for one month: [cell_x, cell_y, value in the unit, raw(, normal)]."""
    w, s_, e, n = parse_bbox(bbox)
    if e - w > 70 or n - s_ > 45:
        raise HTTPException(422, "Zoom in to see fine detail")
    day = parse_month(month, "month")
    unit, U = parse_unit(unit)
    if parse_time(time) != "all" and not U["night"]:
        raise HTTPException(409, "Rebuild the data to use this filter")
    v = {"all": U["col"], "night": U["night"], "day": f"{U['col']} - {U['night']}"}[time]
    box = "cell_y BETWEEN ? AND ? AND cell_x BETWEEN ? AND ?"   # integer ranges let Parquet skip row groups
    bp = [math.floor(s_ / H.CELL), math.ceil(n / H.CELL) - 1, math.floor(w / H.CELL), math.ceil(e / H.CELL) - 1]
    raw = "raw_terra + raw_aqua + raw_n20 + raw_snpp"
    if normal:
        a, b = U["base"]
        k = b - a + 1
        at = lambda p: f"CASE WHEN {p} <= {k} - len(l) THEN 0 ELSE l[{p} - ({k} - len(l))] END"
        sql = f"""WITH base AS (SELECT cell_x, cell_y, list(({v}) ORDER BY {v}) AS l FROM monthly
                               WHERE {box} AND month(month) = ? AND year(month) BETWEEN {a} AND {b} GROUP BY 1, 2),
                       cur AS (SELECT cell_x, cell_y, {v} AS v, {raw} AS raw FROM monthly WHERE {box} AND month = ?)
                  SELECT cell_x, cell_y, round(coalesce(v, 0), 1), CAST(coalesce(raw, 0) AS BIGINT),
                         round(({at((k + 1) // 2)} + {at(k // 2 + 1)}) / 2, 1) AS normal
                  FROM cur FULL JOIN base USING (cell_x, cell_y)
                  WHERE coalesce(v, 0) > 0 OR coalesce(raw, 0) > 0 OR ({at((k + 1) // 2)} + {at(k // 2 + 1)}) > 0
                  ORDER BY 3 DESC, 4 DESC LIMIT {MAX_CELLS + 1}"""
        params = bp + [int(day[5:7])] + bp + [day]
    else:
        sql = f"""SELECT cell_x, cell_y, round({v}, 1), CAST({raw} AS BIGINT) FROM monthly
                  WHERE {box} AND month = ? AND ({v} > 0 OR {raw} > 0) ORDER BY 3 DESC, 4 DESC LIMIT {MAX_CELLS + 1}"""
        params = bp + [day]
    rows = db.cursor().execute(sql, params).fetchall()
    return {"res": H.CELL, "month": month, "time": time, "unit": unit, "truncated": len(rows) > MAX_CELLS,
            "cells": [list(r) for r in rows[:MAX_CELLS]]}


@app.get("/api/meta")
def meta():
    return {"countries": COUNTRIES, "boxes": BOXES, "first": FIRST[:7], "last": LAST[:7], "primary": PRIMARY,
            "aqua_start": H.AQUA_START[:7], "model_start": H.MODEL_START[:7], "data": ROOT.name, "live": LIVE_OK, "static_mask": STATIC_FILE.exists(),
            "trust": TRUST_FILE.exists(), "provisional": PROVISIONAL, "points": (ROOT / "hotspots").exists(), "night": NIGHT, "states": HAS["states"], "places": HAS["places"], "units": UNITS,
            "baseline": {"aqua": list(H.BASELINE), **({"viirs": VV["baseline"]} if VV else {})},
            "viirs": {"start": VV["start"][:7], "ref_start": VV["ref_start"][:7], "reference": VV["reference"]} if VV else None}


@app.get("/api/validation")
def validation():
    return VAL


@app.get("/api/globe.bin")
def globe_bin():
    """All 0.5 degree cells and months in one gzip file (see pipeline.pack_globe). The page unpacks it."""
    path = ROOT / "serve/globe.bin.gz"
    if not path.exists():   # data built before this file existed
        import pipeline
        pipeline.pack_globe(ROOT / "serve")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})


@app.get("/api/globe")
def globe(month: str = Query(...)):
    """0.5 degree cells of one month: [west, south, raw hotspots, harmonized(, VIIRS units)]."""
    cur = db.cursor().execute(f"SELECT gx * 0.5, gy * 0.5, raw_modis + raw_viirs, round(harm, 1){', round(vharm, 1)' if VV else ''} FROM globe WHERE month = ?",
                              [parse_month(month, "month")])
    return {"month": month, "cells": cur.fetchall()}


@app.get("/api/globe/years")
def globe_years():
    cur = db.cursor().execute(f"""SELECT year(month), sum(raw_modis), sum(raw_viirs), round(sum(harm)){', round(sum(vharm))' if VV else ''} FROM globe
                                  GROUP BY 1 ORDER BY 1""")
    return [{"year": y, "raw_modis": int(m), "raw_viirs": int(v), "harmonized": h, **({"viirs_units": x[0]} if x else {})}
            for y, m, v, h, *x in cur.fetchall()]


@app.get("/api/hotspots.csv")
def hotspots_csv(bbox: str, start: str, end: str):
    """Original FIRMS records inside a box and date range (at most MAX_EXPORT rows)."""
    w, s, e, n = parse_bbox(bbox)
    for d in (start, end):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            raise HTTPException(422, "start and end must be YYYY-MM-DD")
    files = [p.as_posix() for p in (ROOT / "hotspots").glob("*/*.parquet") if start[:4] <= p.stem <= end[:4]]
    if not files:
        raise HTTPException(404, "no hotspot files for these years")
    cur = db.cursor().execute(f"""
      SELECT round(CAST(latitude AS DOUBLE), 5) AS latitude, round(CAST(longitude AS DOUBLE), 5) AS longitude, acq_date,
             acq_time, satellite, confidence, round(CAST(frp AS DOUBLE), 2) AS frp, daynight, type, country
      FROM read_parquet({files}, union_by_name = true)
      WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND acq_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
      LIMIT {MAX_EXPORT}""", [s, n, w, e, start, end])

    def stream():
        out = io.StringIO()
        w_ = csv.writer(out)
        w_.writerow([d[0] for d in cur.description])
        while chunk := cur.fetchmany(20000):
            w_.writerows(chunk)
            yield out.getvalue()
            out.seek(0)
            out.truncate()
        yield out.getvalue()
    return StreamingResponse(stream(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=hotspots.csv"})


class Static(StaticFiles):
    """Page files revalidate on every load (ETag, so 304 when unchanged); vendor libraries never change."""
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "public, max-age=86400" if path.replace("\\", "/").startswith("vendor/") else "no-cache"
        return r


app.mount("/", Static(directory=HERE / "static", html=True), name="static")
