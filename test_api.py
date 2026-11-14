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
