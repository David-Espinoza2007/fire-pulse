"""API tests on the Mexico data with a stubbed 7-day FIRMS file (no network).  pytest test_api.py"""
import importlib
import math
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

HERE = Path(__file__).parent
if not (HERE / "data/mx/serve/monthly.parquet").exists():
    pytest.skip("needs data/mx (python pipeline.py --root data/mx --countries Mexico)", allow_module_level=True)

HEAD = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
# (lat, lon, date, hhmm UTC, confidence, frp, D/N)
ROWS = [(20.01 + i * 0.002, -100.01 - i * 0.002, f"2026-11-{8 + day:02d}", "1900" if i < 3 else "1100", "high", 20.0 + 3 * i + day,
         "D" if i < 3 else "N") for day in range(5) for i in range(4)]       # a tight cluster burning on 5 dates
ROWS += [(22.5, -102.5, "2026-11-10", "0600", "nominal", 300.0, "N"),         # one strong, isolated night detection
         (18.0, -99.0, "2026-11-10", "1900", "low", 50.0, "D")]               # low confidence: dropped
ROWS += [(19.0 + k * 0.3, -101.0 - k * 0.3, "2026-11-11", "1900", "nominal", 5.0 + k, "D") for k in range(6)]
BOX = "-103,17,-98,23"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setenv("FIRE_DATA", str(HERE / "data/mx"))
    import app
    app = importlib.reload(app)
    week = tmp_path_factory.mktemp("live") / "week.csv"   # stands in for the public FIRMS file
    week.write_text(HEAD + "".join(f"{la},{lo},330,0.4,0.4,{d},{t},N20,{c},2.0NRT,290,{f},{n}\n" for la, lo, d, t, c, f, n in ROWS))
    app.LIVE_URL, app.LIVE_FILE, app.STATIC_FILE = week.as_uri(), week.with_name("cache.csv"), week.with_name("static.parquet")   # no mask unless a test makes one
    yield TestClient(app.app), app
    mp.undo()


def pts(c, **kw):
    r = c.get("/api/live/points", params={"bbox": BOX, **kw})
    assert r.status_code == 200, r.text
    return r.json()["points"]


def test_points_and_days_burning(client):
    c, _ = client
    p = pts(c)
    assert len(p) == len(ROWS) - 1 and c.get("/api/live/points", params={"bbox": BOX}).json()["truncated"] is False
    cluster = [x for x in p if -100.1 < x[0] < -100.0]
    assert len(cluster) == 20 and {x[6] for x in cluster} == {5}
    assert [x for x in p if x[1] == 22.5][0][2:4] == ["2026-11-09", "23:10"] and p[0][4] == 300.0   # local solar time, strongest first


def test_time_filter(client):
    c, _ = client
    n_night, n_day = len(pts(c, time="night")), len(pts(c, time="day"))
    assert 0 < n_night < len(pts(c)) and n_night + n_day == len(pts(c))
    assert n_night == sum(r[6] == "N" for r in ROWS if r[4] != "low")
    live = lambda t: c.get("/api/live", params={"bbox": BOX, "time": t}).json()
    assert live("night")["raw"] < live("all")["raw"] == len(ROWS) - 1 and live("night")["night_share"] == 1
    assert 0 < live("all")["night_share"] < 1


def test_strong(client):
    c, app = client
    mw = c.get("/api/live", params={"bbox": BOX}).json()["strong_mw"]
    strong = pts(c, strong=1)
    assert 0 < len(strong) < len(pts(c)) and all(x[4] >= mw for x in strong)
    assert c.get("/api/live", params={"bbox": BOX}).json()["strong"] == len(strong)


def test_places(client):
    c, _ = client
    r = c.get("/api/live/places", params={"bbox": BOX}).json()["places"]
    assert r[0]["days"] == 5 and r[0]["detections"] == 20 and r[0]["baseline_years"] == 18 and r[0]["why"].startswith("Burning 5 of")
    assert len(r) <= 8 and all(p["days"] <= 5 for p in r)
    assert all(0 <= p["recent_years"] <= 3 and ("new here" not in p["why"] or p["recent_years"] == 0) for p in r)
    assert any(p["night"] for p in c.get("/api/live/places", params={"bbox": BOX, "time": "night"}).json()["places"])


def test_static_mask(client):
    c, app = client
    assert c.get("/api/live", params={"bbox": BOX}).json()["static_removed"] is None and c.get("/api/meta").json()["static_mask"] is False
    cx, cy = math.floor(-102.5 / 0.05), math.floor(22.5 / 0.05)   # the isolated strong night detection
    duckdb.connect().execute(f"COPY (SELECT {cx} AS cell_x, {cy} AS cell_y, 30 AS n_static, 5 AS n_fire) TO '{app.STATIC_FILE.as_posix()}' (FORMAT parquet)")
    try:
        app.live_state["loaded"] = 0   # force a reload with the mask
        assert c.get("/api/meta").json()["static_mask"] is True
        assert not [x for x in pts(c) if x[1] == 22.5] and len(pts(c)) == len(ROWS) - 2
        live = c.get("/api/live", params={"bbox": BOX}).json()
        assert live["static_removed"] == 1 and live["raw"] == len(ROWS) - 2
        assert c.get("/api/live", params={"bbox": "-101,19,-100,21"}).json()["static_removed"] == 0
    finally:
        app.STATIC_FILE.unlink()
        app.live_state["loaded"] = 0
    assert len(pts(c)) == len(ROWS) - 1


def test_multipolygon(client):
    c, _ = client
    ring = lambda w, s, e, n: [[w, s], [e, s], [e, n], [w, n], [w, s]]
    geom = {"type": "MultiPolygon", "coordinates": [[ring(-100.5, 19.5, -99.5, 20.5)], [ring(-103, 22, -102, 23)]]}
    p = c.post("/api/live/points", json={"polygon": geom}).json()["points"]
    assert len(p) == 21   # the cluster and the isolated night detection
    assert c.post("/api/live/places", json={"polygon": geom, "time": "night"}).status_code == 200
    assert c.post("/api/live", json={"polygon": geom}).json()["raw"] == 21
    assert c.post("/api/calendar", json={"polygon": geom}).status_code == 200


def test_bad_input(client):
    c, _ = client
    for path in ("/api/live", "/api/live/points", "/api/live/places", "/api/live/cells", "/api/calendar"):
        assert c.get(path, params={"bbox": BOX, "time": "noon"}).status_code == 422
    assert c.get("/api/live/points", params={"bbox": BOX, "strong": 2}).status_code == 422
    assert c.get("/api/live/points", params={"bbox": "5,5,1,1"}).status_code == 422
    assert c.get("/api/live/places").status_code == 422
    assert c.post("/api/live/points", json={"polygon": {"type": "Point", "coordinates": [0, 0]}}).status_code == 422
    assert c.post("/api/live/points", json={"polygon": {"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 1]]]]}}).status_code == 422
    big = {"type": "Polygon", "coordinates": [[[i / 1e5, 0] for i in range(20001)] + [[0, 0]]]}
    assert c.post("/api/live/points", json={"polygon": big}).status_code == 422
    assert c.get("/api/calendar", params={"bbox": BOX, "method": "ratio", "time": "night"}).status_code == 422


def test_calendar_time(client):
    c, app = client
    base = {"bbox": BOX}
    m = c.get("/api/calendar", params=base).json()["months"][-1]
    if app.NIGHT:
        day, night = (c.get("/api/calendar", params={**base, "time": t}).json()["months"][-1] for t in ("day", "night"))
        assert day["harmonized"] + night["harmonized"] == pytest.approx(m["harmonized"], abs=0.2) and m["night"] is not None
    else:
        assert c.get("/api/calendar", params={**base, "time": "night"}).json() == {"detail": "Rebuild the data to use this filter"}
        assert m["night"] is None and m["frp"] is None and m["night_median"] is None and m["frp_median"] is None
    assert c.get("/api/meta").json()["night"] is app.NIGHT


def test_reference(client):
    c, app = client
    if not (HERE / "data/reference/states.parquet").exists():
        pytest.skip("run reference.py")
    s = c.get("/api/states", params={"bbox": "-103,14,-90,22"}).json()["states"]
    assert "Chiapas" in {x["name"] for x in s} and s[0]["geometry"]["type"] in ("Polygon", "MultiPolygon") and len(s) <= 400
    p = c.get("/api/places", params={"bbox": "-100,19,-98,20", "limit": 5}).json()["places"]
    assert 0 < len(p) <= 5 and p == sorted(p, key=lambda x: -x["pop"])
    assert c.get("/api/meta").json()["states"] is True
    labels = [x["label"] for x in c.get("/api/live/places", params={"bbox": BOX}).json()["places"]]
    assert any(l and " of " in l or (l or "").startswith("Near") for l in labels)


def test_fine_cells(client):
    c, app = client
    box, month = "-101,19,-99,21", "2019-05"
    r = c.get("/api/cells", params={"bbox": box, "month": month}).json()
    cal = next(m for m in c.get("/api/calendar", params={"bbox": box, "start": month, "end": month}).json()["months"])
    assert r["res"] == 0.05 and not r["truncated"] and r["cells"] and len(r["cells"][0]) == 4
    assert sum(x[2] for x in r["cells"]) == pytest.approx(cal["harmonized"], abs=0.05 * len(r["cells"]) + 0.5)
    n = c.get("/api/cells", params={"bbox": box, "month": month, "normal": 1}).json()["cells"]
    assert n and all(len(x) == 5 for x in n) and len(n) >= len(r["cells"])
    assert c.get("/api/cells", params={"bbox": "-120,10,-40,30", "month": month}).json() == {"detail": "Zoom in to see fine detail"}
    assert c.get("/api/cells", params={"bbox": "-120,-20,-100,30", "month": month}).status_code == 422
    assert c.get("/api/cells", params={"bbox": box, "month": "2019-13"}).status_code == 422


def test_cache_headers(client):
    c, _ = client
    assert c.get("/app.js").headers["cache-control"] == "no-cache" and c.get("/").headers["cache-control"] == "no-cache"
    assert "max-age" in c.get("/vendor/d3.min.js").headers["cache-control"]
    assert c.get("/api/globe.bin").headers["cache-control"] == "no-cache"


def decode_tile(blob):
    import struct
    from array import array
    nh = struct.unpack("<I", blob[:4])[0]
    head, pos = __import__("json").loads(blob[4:4 + nh]), 4 + nh + (-(4 + nh) % 4)
    take = lambda code, n: (lambda a, size: (a, pos + size + (-size % 4)))(array(code, blob[pos:pos + n * array(code).itemsize]), n * array(code).itemsize)
    out = {}
    for name, code, n in (("start", "I", head["months"] + 1), ("idx", "H", head["nnz"]), ("harm", "H", head["nnz"]),
                          ("night", "H", head["nnz"]), ("raw", "H", head["nnz"])):
        out[name], pos = take(code, n)
    assert pos == len(blob)
    return head, out


def test_tiles(client):
    import duckdb
    c, app = client
    box, tot = (-100.0, 20.0, -95.0, 25.0), {}
    for level in (1, 2, 3):
        tx, ty = {1: (3, 4), 2: (8, 11), 3: (16, 22)}[level]   # each covers lon -100..-95 and lat 20..25
        r = c.get(f"/api/tiles/{level}/{tx}/{ty}")
        assert r.status_code == 200 and r.headers["content-encoding"] == "gzip" and r.headers["cache-control"] == "no-cache"
        head, d = decode_tile(r.content)
        assert head["level"] == level and d["start"][-1] == head["nnz"]
        for t in range(head["months"]):
            ix = list(d["idx"][d["start"][t]:d["start"][t + 1]])
            assert ix == sorted(set(ix))
        cell = head["cell"]
        west = lambda i: -180 + (tx * {1: 500, 2: 200, 3: 100}[level] + (i % 100) * round(cell / 0.05)) * 0.05
        south = lambda i: -90 + (ty * {1: 500, 2: 200, 3: 100}[level] + (i // 100) * round(cell / 0.05)) * 0.05
        keep = [k for k, i in enumerate(d["idx"]) if box[0] - 1e-6 <= west(i) < box[2] and box[1] - 1e-6 <= south(i) < box[3]]
        tot[level] = (sum(d["harm"][k] for k in keep) / head["scale"], len(keep) * 0.5 / head["scale"])
        if level == 3:   # one month of the finest tile against the parquet
            t = max(range(head["months"]), key=lambda t: sum(d["harm"][d["start"][t]:d["start"][t + 1]]))
            got = sum(d["harm"][d["start"][t]:d["start"][t + 1]]) / head["scale"]
            y, m = divmod(t + 10, 12)
            want = duckdb.connect().execute(f"""SELECT sum(harm) FROM read_parquet('{(HERE / 'data/mx/serve/monthly.parquet').as_posix()}')
                WHERE month = DATE '{2000 + y}-{m + 1:02d}-01' AND cell_x BETWEEN {tx * 100 - 3600} AND {tx * 100 - 3501}
                AND cell_y BETWEEN {ty * 100 - 1800} AND {ty * 100 - 1701}""").fetchone()[0]
            n = d["start"][t + 1] - d["start"][t]
            assert got == pytest.approx(want, abs=n * 0.5 / head["scale"] + 1e-6)
    assert tot[1][0] == pytest.approx(tot[3][0], abs=tot[1][1] + tot[3][1]) and tot[2][0] == pytest.approx(tot[3][0], abs=tot[2][1] + tot[3][1])
    assert c.get("/api/tiles/3/0/0").status_code == 204 and c.get("/api/tiles/3/0/0").status_code == 204
    assert c.get("/api/tiles/4/0/0").status_code == 422 and c.get("/api/tiles/1/99/0").status_code == 422
    etag = r.headers["etag"]
    assert c.get("/api/tiles/3/16/22", headers={"if-none-match": etag}).status_code == 304


def test_points_bin(client):
    import gzip, json, struct
    from array import array
    c, _ = client
    r = c.get("/api/live/points.bin")
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip"
    blob = r.content
    nh = struct.unpack("<I", blob[:4])[0]
    head, pos = json.loads(blob[4:4 + nh]), 4 + nh + (-(4 + nh) % 4)
    n = head["n"]
    js = c.get("/api/live/points", params={"country": "World"}).json()["points"]
    assert n == len(js) == len(ROWS) - 1 and head["days"] >= 5 and head["buckets"] >= 3
    cols = {}
    for name, code, size in (("lon", "f", 4), ("lat", "f", 4), ("frp", "f", 4), ("min", "H", 2), ("day", "B", 1), ("flag", "B", 1), ("dburn", "B", 1)):
        cols[name] = array(code, blob[pos:pos + n * size])
        pos += n * size + (-(n * size) % 4)
    ids = array("I", blob[pos:pos + 4 * head["buckets"]])
    starts = array("I", blob[pos + 4 * head["buckets"]:pos + 4 * (2 * head["buckets"] + 1)])
    assert list(ids) == sorted(set(ids)) and starts[0] == 0 and starts[-1] == n and list(starts) == sorted(starts)
    for b, i in enumerate(ids):
        for k in range(starts[b], starts[b + 1]):
            assert int((cols["lat"][k] + 90) // 0.5) * 720 + int((cols["lon"][k] + 180) // 0.5) == i
    first = __import__("datetime").date.fromisoformat(head["first_day"])
    for k in range(n):
        p = next(p for p in js if abs(p[0] - cols["lon"][k]) < 1e-3 and abs(p[1] - cols["lat"][k]) < 1e-3 and p[4] == pytest.approx(cols["frp"][k], abs=0.06)
                 and p[2] == (first + __import__("datetime").timedelta(days=cols["day"][k])).isoformat())
        assert p[3] == f"{cols['min'][k] // 60:02d}:{cols['min'][k] % 60:02d}" and p[5] == ("N" if cols["flag"][k] else "D")
        assert p[6] == cols["dburn"][k]
