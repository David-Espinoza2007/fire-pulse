"""Tests: the conversion recovers a known truth, and totals survive every step.  Run: pytest"""
import gzip
import importlib
import json
import math
import random
import struct

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


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    """A small fake record run through the real pipeline: Terra-only, Aqua, overlap and model years."""
    root, rng, con = tmp_path_factory.mktemp("data"), random.Random(2), duckdb.connect()

    def year_rows(year, sats, n):
        return [(19 + rng.random() * 2, -101 + rng.random() * 2, f"{year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
                 rng.choice((800, 2000)), sat, "n" if sat == "N20" else "80", rng.random() * 50, rng.choice("DN"), 0, "Testland")
                for sat in sats for _ in range(n)]
    for sensor, sats, years, n in (("modis", ("Terra",), (2001,), 400), ("modis", ("Terra", "Aqua"), (2005, 2019, 2020, 2021, 2022), 400),
                                   ("viirs-jpss1", ("N20",), (2018, 2019, 2020, 2021, 2022), 2000)):
        for year in years:
            hotspots(con, year_rows(year, sats, n))
            out = root / "hotspots" / sensor / f"{year}.parquet"
            out.parent.mkdir(parents=True, exist_ok=True)
            con.execute(f"COPY h TO '{out.as_posix()}' (FORMAT parquet)")
    pipeline.build(root)
    return root


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


def test_globe_has_three_grids(root):
    blob = gzip.decompress((root / "serve" / "globe.bin.gz").read_bytes())
    n = struct.unpack("<I", blob[:4])[0]
    head, pad = json.loads(blob[4:4 + n]), lambda k: k + (-k % 4)
    assert head["grids"] == ["harm", "raw", "night"]
    size = 2 * head["units"] * head["months"]
    assert len(blob) == pad(4 + n) + 4 * head["units"] + pad(2 * head["units"]) + 3 * pad(size)
    off = pad(4 + n) + 4 * head["units"] + pad(2 * head["units"])
    harm, night = (memoryview(blob[off + i * pad(size):off + i * pad(size) + size]).cast("H") for i in (0, 2))
    assert sum(night) > 0 and all(b <= a for a, b in zip(harm, night))


def test_api_calendar(root, monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("FIRE_DATA", str(root))
    import app
    client = TestClient(importlib.reload(app).app)
    total = lambda bbox: sum(m["harmonized"] for m in client.get("/api/calendar", params={"bbox": bbox}).json()["months"])
    months = client.get("/api/calendar", params={"bbox": "-101,19,-99,21"}).json()["months"]
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
    assert len(blob) == pad(4 + struct.unpack("<I", blob[:4])[0]) + 4 * head["units"] + pad(2 * head["units"]) + 3 * pad(2 * head["units"] * 266)
    assert client.get("/api/calendar", params={"bbox": "5,5,1,1"}).status_code == 422
    assert "latitude,longitude" in client.get("/api/hotspots.csv", params={"bbox": "-101,19,-99,21", "start": "2019-01-01", "end": "2019-12-31"}).text
