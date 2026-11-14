"""Tests: the conversion recovers a known truth, and totals survive every step.  Run: pytest"""
import gzip
import importlib
import json
import math
import random
import struct
from pathlib import Path

import duckdb
import pytest

import harmonize as H
import pipeline

MEANS = {1.0: 0.1, 15.0: 0.5, 300.0: 2.0}   # FRP sum of a VIIRS row -> true mean Aqua pixel count


def poisson(rng, lam):
    k, p, limit = 0, 1.0, math.exp(-lam)
    while (p := p * rng.random()) > limit:
        k += 1
    return k


@pytest.fixture(scope="module")
def synthetic():
    """Two years of cell-pass rows with a known VIIRS -> Aqua relation and a known Aqua-only share."""
    rng, v, a = random.Random(1), [], []
    for year in (2019, 2020):
        for day in range(1, 31):
            date = f"{year}-03-{day:02d}"
            for i in range(300):                     # dense tile: 3000 rows per FRP class and year
                frp = (1.0, 15.0, 300.0)[i % 3]
                v.append((i % 100, i // 100, date, "D", 1, frp, False))
                if k := poisson(rng, MEANS[frp]):
                    a.append((i % 100, i // 100, date, "D", k))
            a += [(i, 50, date, "D", 1) for i in range(60)]   # Aqua pixels with no VIIRS partner
    for i in range(40):                              # sparse neighbor tile with a very different relation
        v.append((100 + i, 0, "2019-03-01", "D", 1, 1.0, False))
        a.append((100 + i, 0, "2019-03-01", "D", 5))
    con = duckdb.connect()
    con.execute("CREATE TABLE v (cell_x INT, cell_y INT, local_date DATE, daynight VARCHAR, n_pixels INT, frp_sum FLOAT, sat_flag BOOL)")
    con.execute("CREATE TABLE a (cell_x INT, cell_y INT, local_date DATE, daynight VARCHAR, n_pixels INT)")
    con.executemany("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?, ?)", v)
    con.executemany("INSERT INTO a VALUES (?, ?, ?, ?, ?)", a)
    H.fit(con, "f", "v", "a", "year(local_date) = 2019")
    return con


def test_table_recovers_known_means(synthetic):
    got = dict(synthetic.execute("SELECT fc, mu FROM f_l5 WHERE t5x = 0 AND n >= 300").fetchall())
    for frp, fc in ((1.0, 1), (15.0, 4), (300.0, 8)):
        assert abs(got[fc] - MEANS[frp]) < 3 * math.sqrt(MEANS[frp] / 3000)


def test_held_out_total(synthetic):
    est = synthetic.execute(f"SELECT sum(est_table) FROM ({H.apply('f', 'v', 'year(local_date) = 2020')})").fetchone()[0]
    actual = synthetic.execute("SELECT sum(n_pixels) FROM a WHERE year(local_date) = 2020").fetchone()[0]
    assert abs(est / actual - 1) < 0.05


def test_sparse_tile_uses_larger_tile(synthetic):
    sparse = "year(local_date) = 2019 AND cell_x >= 100"
    est, cal = synthetic.execute(f"""SELECT avg(est_table), (SELECT cal FROM f_cal)
                                     FROM ({H.apply('f', 'v', sparse)})""").fetchone()
    pooled = synthetic.execute("SELECT mu FROM f_l20 WHERE fc = 1").fetchone()[0]
    assert est / cal == pytest.approx(pooled) and pooled < 1   # not the tile's own mean of 5


def test_day_and_night_calibrated_apart():
    """Aqua-only pixels at night only: the night part must take all of them, the day part none."""
    rng, con = random.Random(4), duckdb.connect()
    con.execute("CREATE TABLE v (cell_x INT, cell_y INT, local_date DATE, daynight VARCHAR, n_pixels INT, frp_sum FLOAT, sat_flag BOOL)")
    con.execute("CREATE TABLE a (cell_x INT, cell_y INT, local_date DATE, daynight VARCHAR, n_pixels INT)")
    v, a = [], []
    for day in range(1, 29):
        for i in range(200):
            dn = "DN"[i % 2]
            v.append((i, 0, f"2019-03-{day:02d}", dn, 1, 15.0, False))
            if k := poisson(rng, 0.5):
                a.append((i, 0, f"2019-03-{day:02d}", dn, k))
        a += [(i, 50, f"2019-03-{day:02d}", "N", 1) for i in range(30)]
    con.executemany("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?, ?)", v)
    con.executemany("INSERT INTO a VALUES (?, ?, ?, ?, ?)", a)
    H.fit(con, "f", "v", "a", "TRUE")
    est = dict(con.execute(f"SELECT daynight, sum(est_table) FROM ({H.apply('f', 'v', 'TRUE')}) GROUP BY 1").fetchall())
    actual = dict(con.execute("SELECT daynight, sum(n_pixels) FROM a GROUP BY 1").fetchall())
    assert est["N"] == pytest.approx(actual["N"]) and est["D"] == pytest.approx(actual["D"])


def test_frp_ratio_recovers_known_factor():
    rng, con = random.Random(3), duckdb.connect()
    con.execute("CREATE TABLE v (cell_x INT, cell_y INT, local_date DATE, daynight VARCHAR, n_pixels INT, frp_sum FLOAT)")
    con.execute("CREATE TABLE a AS SELECT * FROM v")
    rows = [(i, 0, f"2019-03-{d:02d}", "D", 1, rng.random() * 40) for d in range(1, 29) for i in range(50)]
    con.executemany("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?)", rows)
    con.executemany("INSERT INTO a VALUES (?, ?, ?, ?, ?, ?)", [(x, y, d, dn, n, f * 2.5) for x, y, d, dn, n, f in rows])
    H.fit_frp(con, "f", "v", "a", "TRUE")
    assert con.execute("SELECT ratio FROM f_fr").fetchone()[0] == pytest.approx(2.5, rel=1e-5)
    est, actual = con.execute(f"SELECT sum(est_frp), (SELECT sum(frp_sum) FROM a) FROM ({H.apply_frp('f', 'v', 'TRUE')})").fetchone()
    assert est == pytest.approx(actual, rel=1e-4)


def test_cal5_moves_aqua_only_pixels_to_their_tile():
    """Two 5 degree tiles in one 20 degree tile, the same VIIRS-Aqua relation, but Aqua-only pixels in tile 1 alone.
    The 20 degree calibration spreads them over both; cal5 gives each tile its own total. Tile 2 is too small and keeps factor 1."""
    con = duckdb.connect()
    con.execute("""CREATE TABLE v AS SELECT x AS cell_x, 0 AS cell_y, DATE '2019-03-01' + CAST(d + 366 * y AS INT) AS local_date, 'D' AS daynight,
                   1 AS n_pixels, CAST(15 AS FLOAT) AS frp_sum, false AS sat_flag FROM range(200) r(x), range(30) s(d), range(2) t(y)""")
    con.execute("""CREATE TABLE a AS SELECT cell_x, cell_y, local_date, daynight, 1 AS n_pixels FROM v WHERE cell_x % 2 = 0
                   UNION ALL SELECT 100 + x, 50, DATE '2019-03-01' + CAST(d + 366 * y AS INT), 'D', 1 FROM range(50) r(x), range(30) s(d), range(2) t(y)""")
    con.execute("INSERT INTO v SELECT 200 + x, 0, DATE '2019-03-01', 'D', 1, 15, false FROM range(5) r(x)")
    con.execute("INSERT INTO a SELECT 200 + x, 0, DATE '2019-03-01', 'D', 5 FROM range(5) r(x)")
    H.fit(con, "f", "v", "a", "year(local_date) = 2019")
    factor = dict(con.execute("SELECT t5x, a / e FROM f_cal5").fetchall())
    assert factor[0] == pytest.approx(2 / 3, rel=1e-2) and factor[1] == pytest.approx(4 / 3, rel=1e-2)   # cal alone gives 1.5 to both
    got = dict(con.execute(f"SELECT t5x, sum(est_table) FROM ({H.apply('f', 'v', 'year(local_date) = 2020')}) GROUP BY 1").fetchall())
    assert got[0] == pytest.approx(1500, rel=1e-3) and got[1] == pytest.approx(3000, rel=1e-3)   # Aqua pixels of 2020 per tile
    small = "cell_x >= 200"
    assert con.execute(f"SELECT sum(est_table) FROM ({H.apply('f', 'v', small)})").fetchone()[0] == pytest.approx(
        con.execute(f"SELECT sum(est_table) FROM ({H._apply('f', 'v', small)})").fetchone()[0])


def test_fit_up_ratio_and_fallback():
    """MODIS -> VIIRS: a dense tile keeps its own ratio of 3; a sparse tile with its own ratio of 10 takes the 20 degree ratio."""
    con = duckdb.connect()
    con.execute("""CREATE TABLE m AS SELECT x AS cell_x, 0 AS cell_y, DATE '2019-03-01' + CAST(d AS INT) AS local_date, 'D' AS daynight, 1 AS n_pixels
                   FROM range(100) r(x), range(30) s(d) UNION ALL SELECT 100 + x, 0, DATE '2019-03-01', 'D', 1 FROM range(10) r(x)""")
    con.execute("CREATE TABLE v AS SELECT cell_x, cell_y, local_date, daynight, 3 * n_pixels AS n_pixels FROM m WHERE cell_x < 100 "
                "UNION ALL SELECT cell_x, cell_y, local_date, daynight, 10 FROM m WHERE cell_x >= 100")
    H.fit_up(con, "u", "m", "v", "TRUE")
    got = dict(con.execute(f"SELECT t5x, sum(est) / sum(n_pixels) FROM ({H.apply_up('u', 'm', 'TRUE')}) GROUP BY 1").fetchall())
    assert got[0] == pytest.approx(3) and got[1] == pytest.approx((9000 + 100) / 3010)


def hotspots(con, rows):
    con.execute("""CREATE OR REPLACE TABLE h (latitude FLOAT, longitude FLOAT, acq_date DATE, acq_time SMALLINT,
                   satellite VARCHAR, confidence VARCHAR, frp FLOAT, daynight VARCHAR, type TINYINT, country VARCHAR)""")
    con.executemany("INSERT INTO h VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def test_local_date_and_cleaning():
    con = duckdb.connect()
    hotspots(con, [(10, 150, "2020-01-01", 2000, "Aqua", "80", 20, "D", 0, "X"),    # 20:00 UTC + 10 h -> next day
                   (10, -150, "2020-01-01", 300, "Aqua", "80", 20, "N", 0, "X"),    # 03:00 UTC - 10 h -> day before
                   (10, 0, "2020-01-01", 1200, "Aqua", "20", 20, "D", 0, "X"),      # low confidence: dropped
                   (10, 0, "2020-01-01", 1200, "Aqua", "80", 20, "D", 2, "X")])     # static source: dropped
    got = con.execute(f"SELECT cell_x, CAST(local_date AS VARCHAR) FROM ({H.cell_pass_sql('h', 'Aqua')}) ORDER BY 1").fetchall()
    assert got == [(-3000, "2019-12-31"), (3000, "2020-01-02")]
    hotspots(con, [(10, 0, "2020-01-01", 1200, "N20", c, 5, "D", 0, "X") for c in "lnh"])
    assert con.execute(f"SELECT n_pixels FROM ({H.cell_pass_sql('h', 'N20')})").fetchone()[0] == 2


def fake_record(root, record):
    """Write fake hotspot files for (sensor, satellites, years, rows per year) and run the real pipeline on them."""
    rng, con = random.Random(2), duckdb.connect()

    def year_rows(year, sats, n):
        return [(19 + rng.random() * 2, -101 + rng.random() * 2, f"{year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
                 rng.choice((800, 2000)), sat, "n" if sat in ("N20", "SNPP") else "80", rng.random() * 50, rng.choice("DN"), 0, "Testland")
                for sat in sats for _ in range(n)]
    for sensor, sats, years, n in record:
        for year in years:
            hotspots(con, year_rows(year, sats, n))
            out = root / "hotspots" / sensor / f"{year}.parquet"
            out.parent.mkdir(parents=True, exist_ok=True)
            con.execute(f"COPY h TO '{out.as_posix()}' (FORMAT parquet)")
    pipeline.build(root)
    return root


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    """A small fake record run through the real pipeline: Terra-only, Aqua, overlap and model years."""
    return fake_record(tmp_path_factory.mktemp("data"), (
        ("modis", ("Terra",), (2001,), 400), ("modis", ("Terra", "Aqua"), (2005, 2019, 2020, 2021, 2022), 400),
        ("viirs-jpss1", ("N20",), (2018, 2019, 2020, 2021, 2022), 2000)))


@pytest.fixture(scope="module")
def root2(tmp_path_factory):
    """The same with two VIIRS satellites: Suomi NPP from 2015 with half the detections of NOAA-20, NOAA-20 from 2019."""
    return fake_record(tmp_path_factory.mktemp("data2"), (
        ("modis", ("Terra", "Aqua"), (2005, 2015, 2019, 2020, 2021), 400),
        ("viirs-snpp", ("SNPP",), (2015, 2019, 2020, 2021), 1000), ("viirs-jpss1", ("N20",), (2019, 2020, 2021), 2000)))


def test_totals_are_conserved(root):
    con, r = duckdb.connect(), root.as_posix()
    for sat, col in (("Terra", "raw_terra"), ("Aqua", "raw_aqua"), ("N20", "raw_n20")):
        raw = con.execute(f"SELECT count(*) FROM read_parquet('{r}/hotspots/*/*.parquet') WHERE satellite = '{sat}'").fetchone()[0]
        assert con.execute(f"SELECT sum(n_pixels) FROM read_parquet('{r}/cell_pass/{sat}/*.parquet')").fetchone()[0] == raw
        assert con.execute(f"SELECT sum({col}) FROM read_parquet('{r}/serve/monthly.parquet')").fetchone()[0] == raw


def test_stable_aqua_years_are_untouched(root):
    bad = duckdb.connect().execute(f"""SELECT count(*) FROM read_parquet('{root.as_posix()}/serve/monthly.parquet')
        WHERE month >= DATE '{H.AQUA_START}' AND month < DATE '{H.MODEL_START}' AND harm <> raw_aqua""").fetchone()[0]
    assert bad == 0


def test_night_and_frp(root):
    con, r = duckdb.connect(), root.as_posix()
    con.execute(f"CREATE VIEW m AS SELECT * FROM read_parquet('{r}/serve/monthly.parquet')")
    assert con.execute("SELECT count(*) FROM m WHERE harm_night < -1e-9 OR harm_night > harm + 1e-6 OR frp < 0").fetchone()[0] == 0
    stable = f"month >= DATE '{H.AQUA_START}' AND month < DATE '{H.MODEL_START}'"
    aqua = con.execute(f"""SELECT sum(n_pixels) FILTER (daynight = 'N'), sum(frp_sum) FROM read_parquet('{r}/cell_pass/Aqua/*.parquet')
                           WHERE local_date >= DATE '{H.AQUA_START}' AND local_date < DATE '{H.MODEL_START}'""").fetchone()
    got = con.execute(f"SELECT sum(harm_night), sum(frp) FROM m WHERE {stable}").fetchone()
    assert got[0] == aqua[0] and got[1] == pytest.approx(aqua[1], rel=1e-5)   # no gap days in the fake record
    assert con.execute(f"""SELECT count(*) FROM m FULL JOIN (
        SELECT cell_x, cell_y, CAST(date_trunc('month', local_date) AS DATE) AS month, sum(n_pixels) AS n
        FROM read_parquet('{r}/cell_pass/Aqua/*.parquet') WHERE daynight = 'N' GROUP BY ALL) c USING (cell_x, cell_y, month)
        WHERE {stable} AND coalesce(harm_night, 0) <> coalesce(n, 0)""").fetchone()[0] == 0
    assert con.execute(f"SELECT sum(harm_night) > 0 AND sum(harm_night) < sum(harm) FROM m WHERE month < DATE '{H.AQUA_START}'").fetchone()[0]
    for era in (f"month < DATE '{H.AQUA_START}'", f"month >= DATE '{H.MODEL_START}'"):   # fake VIIRS rarely meets Aqua: no night check there
        assert con.execute(f"SELECT sum(frp) > 0 FROM m WHERE {era}").fetchone()[0]
    country = con.execute(f"SELECT sum(harm_night), sum(frp) FROM read_parquet('{r}/serve/monthly_country.parquet')").fetchone()
    assert country == pytest.approx(con.execute("SELECT sum(harm_night), sum(frp) FROM m").fetchone())
    folds = json.loads((root / "serve" / "validation.json").read_text())["satellites"]["N20"]
    assert folds["overall"]["frp"] >= 0 and all("frp" in f for f in folds["folds"])


def globe(serve):
    """The header and the grids of serve/globe.bin.gz, after checking the file length."""
    blob = gzip.decompress((serve / "globe.bin.gz").read_bytes())
    n = struct.unpack("<I", blob[:4])[0]
    head, pad = json.loads(blob[4:4 + n]), lambda k: k + (-k % 4)
    size, off = 2 * head["units"] * head["months"], pad(4 + n) + 4 * head["units"] + pad(2 * head["units"])
    assert len(blob) == off + len(head["grids"]) * pad(size)
    return head, {g: memoryview(blob[off + i * pad(size):off + i * pad(size) + size]).cast("H") for i, g in enumerate(head["grids"])}


def test_globe_has_five_grids(root):
    head, g = globe(root / "serve")
    assert head["grids"] == ["harm", "raw", "night", "vharm", "vnight"]
    assert sum(g["night"]) > 0 and all(b <= a for a, b in zip(g["harm"], g["night"]))
    assert sum(g["vnight"]) > 0 and all(b <= a for a, b in zip(g["vharm"], g["vnight"]))


def viirs_units(serve):
    """Checks of the VIIRS-unit record that hold for every build; returns validation.json["viirs"]."""
    con, v = duckdb.connect(), json.loads((serve / "validation.json").read_text())["viirs"]
    con.execute(f"CREATE VIEW m AS SELECT * FROM read_parquet('{serve.as_posix()}/monthly.parquet')")
    ref = v["reference"].lower()
    assert con.execute(f"SELECT count(*) FROM m WHERE month >= DATE '{v['ref_start']}' AND abs(vharm - raw_{ref}) > 1e-6").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM m WHERE vharm_night < -1e-9 OR vharm_night > vharm + 1e-6 OR vpred < 0").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM m WHERE month > DATE '2021-12-31' AND vpred <> 0").fetchone()[0] == 0
    assert con.execute(f"SELECT sum(vharm) > 0 AND sum(vharm_night) > 0 FROM m WHERE month < DATE '{v['start']}'").fetchone()[0]
    country = con.execute(f"SELECT sum(vharm), sum(vpred) FROM read_parquet('{serve.as_posix()}/monthly_country.parquet')").fetchone()
    assert country == pytest.approx(con.execute("SELECT sum(vharm), sum(vpred) FROM m").fetchone())
    for k in ("both", "aqua", "terra"):
        assert 0 < v[k]["error"] < 1 and v[k]["range"]
    assert 0 < v["both"]["night"] < 1 and v["both"]["folds"] and v["both"]["tiles"] and v["start"] <= v["ref_start"]
    t = json.loads((serve / "trust.json").read_text())["viirs"]
    assert len({len(t[k]) for k in ("ux", "uy", "n", "err", "raw")}) == 1 and min(t["err"]) >= 0
    return v


def test_viirs_units(root):
    v = viirs_units(root / "serve")
    assert v["start"] == v["ref_start"] and "twin" not in v


def test_two_viirs_satellites(root2):
    """Before NOAA-20, VIIRS units are Suomi NPP scaled to NOAA-20 (about twice its count in the fake record)."""
    v = viirs_units(root2 / "serve")
    assert v["start"] < v["ref_start"] and v["reference"] == "N20"
    assert 0 <= v["twin"]["scaled"] < v["twin"]["raw"] and v["twin"]["range"]
    vharm, snpp = duckdb.connect().execute(f"""SELECT sum(vharm), sum(raw_snpp) FROM read_parquet('{(root2 / "serve").as_posix()}/monthly.parquet')
                                               WHERE month >= DATE '{v["start"]}' AND month < DATE '{v["ref_start"]}'""").fetchone()
    assert vharm == pytest.approx(2 * snpp, rel=0.1)


MX = Path(__file__).parent / "data/mx/serve"


@pytest.mark.skipif(not (MX / "monthly.parquet").exists(), reason="needs data/mx")
def test_mexico_viirs_units():
    viirs_units(MX)
    head, g = globe(MX)
    assert head["grids"] == ["harm", "raw", "night", "vharm", "vnight"] and all(b <= a for a, b in zip(g["vharm"], g["vnight"]))


def test_api_calendar(root, monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("FIRE_DATA", str(root))
    import app
    client = TestClient(importlib.reload(app).app)
    total = lambda bbox: sum(m["harmonized"] for m in client.get("/api/calendar", params={"bbox": bbox}).json()["months"])
    main = client.get("/api/calendar", params={"bbox": "-101,19,-99,21"}).json()   # the default unit is VIIRS: the newest month is measured
    assert main["unit"] == "viirs" and main["months"][-1]["source"] == "n20" and main["months"][-1]["measured"] and not main["months"][0]["measured"]
    months = client.get("/api/calendar", params={"bbox": "-101,19,-99,21", "unit": "aqua"}).json()["months"]
    assert [m["month"] for m in months][:2] == ["2000-11", "2000-12"] and len(months) == len({m["month"] for m in months})
    assert months[-1]["month"] == "2022-12" and months[-1]["source"] == "n20_model" and months[-1]["low"] <= months[-1]["harmonized"]
    assert total("-101,19,-99,21") == pytest.approx(total("-101,19,-100,21") + total("-100,19,-99,21"), abs=1)
    assert total("-101,19,-99,21") == pytest.approx(
        sum(m["harmonized"] for m in client.get("/api/calendar", params={"country": "Testland"}).json()["months"]), abs=1)
    week = root / "week.csv"   # stands in for the public FIRMS file with the last 7 days
    week.write_text("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
                    + "".join(f"20.{i},-100.{i},330,0.4,0.4,2026-11-1{i % 3},0{800 + i},N20,{c},2.0NRT,290,5.5,D\n"
                              for i, c in enumerate(("nominal", "high", "low", "nominal"))))
    app.LIVE_URL = week.as_uri()
    live = client.get("/api/live", params={"bbox": "-101,19,-99,21"}).json()
    assert live["raw"] == 3 and live["harmonized"] >= 0 and live["to"] == "2026-11-12"   # the low-confidence row is dropped
    assert sum(c[2] for c in client.get("/api/live/cells").json()["cells"]) == 3
    blob = gzip.decompress(client.get("/api/globe.bin").content)   # the packed grid the globe animates
    head = json.loads(blob[4:4 + struct.unpack("<I", blob[:4])[0]])
    pad = lambda n: n + (-n % 4)
    assert head["months"] == 266 and head["countries"] == ["Testland"]   # Nov 2000 to Dec 2022
    assert len(blob) == pad(4 + struct.unpack("<I", blob[:4])[0]) + 4 * head["units"] + pad(2 * head["units"]) + 5 * pad(2 * head["units"] * 266)
    assert client.get("/api/calendar", params={"bbox": "5,5,1,1"}).status_code == 422
    assert "latitude,longitude" in client.get("/api/hotspots.csv", params={"bbox": "-101,19,-99,21", "start": "2019-01-01", "end": "2019-12-31"}).text


def test_trust_file(root):
    t = json.loads((root / "serve" / "trust.json").read_text())
    keys = list(zip(t["uy"], t["ux"]))
    assert len({len(t[k]) for k in ("ux", "uy", "n", "err", "raw")}) == 1 and keys and keys == sorted(keys)
    assert min(t["n"]) >= t["show_n"] and min(t["err"]) >= 0 and t["satellites"] == ["N20"] and len(t["by_size"]) == len(pipeline.TRUST_SIZES)
    # one unit again from monthly.parquet in plain Python, window and outage months from validation.json
    val = json.loads((root / "serve" / "validation.json").read_text())
    lo, hi = val["satellites"]["N20"]["window"]
    gaps = {f"{d[:7]}" for a, b in val["aqua_gaps"] for d in (a, b)}   # the fake record has no multi-month outage
    rows = duckdb.connect().execute(f"""SELECT cell_x, cell_y, strftime(month, '%Y-%m'), raw_aqua, pred_n20 FROM
        read_parquet('{root.as_posix()}/serve/monthly.parquet') WHERE month >= date_trunc('month', DATE '{lo}') AND month <= DATE '{hi}'""").fetchall()
    i = max(range(len(t["n"])), key=t["n"].__getitem__)
    month_sums = {}
    for x, y, m, a, p in rows:
        if m not in gaps and x // 20 == t["ux"][i] and y // 20 == t["uy"][i]:
            s = month_sums.setdefault(m, [0, 0])
            s[0] += a
            s[1] += p
    assert sum(a for a, _ in month_sums.values()) == t["n"][i]
    assert t["err"][i] == pytest.approx(sum(abs(p - a) for a, p in month_sums.values()) / t["n"][i], abs=5e-4)
