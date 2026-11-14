#!/usr/bin/env python3
"""Fire Pulse data pipeline (Python standard library only).

FIRMS yearly country archives (MODIS C6.1 + VIIRS S-NPP 375 m)
  -> monthly hot spot counts on a 0.5 degree grid, per country
  -> MODIS-to-VIIRS conversion factors fitted on the years both sensors flew
  -> one compact binary the web app loads (docs/data/firepulse.bin.gz)

Usage:
  python3 scripts/build_data.py                 # download, aggregate, harmonize, pack
  python3 scripts/build_data.py --raw /big/disk # keep the ~7 GB of zips somewhere else
  python3 scripts/build_data.py --selftest      # check the harmonization maths on synthetic data

AI use: this file was written with Claude (Anthropic) and reviewed by the team.
"""
import argparse, array, gzip, json, math, os, pickle, statistics, sys, time, urllib.request, zipfile
from collections import Counter, defaultdict
from multiprocessing import Pool

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country/zips/{name}"
Y0, Y1 = 2001, 2025                 # calendar covers Jan Y0 .. Dec Y1
VIIRS_Y0 = 2012
NT = (Y1 - Y0 + 1) * 12             # months in the calendar
V0 = (VIIRS_Y0 - Y0) * 12           # first month index with a VIIRS file
NV = NT - V0                        # months stored for VIIRS
V_FULL = V0 + 1                     # S-NPP fire data starts 20 Jan 2012, so Feb 2012 is the first full month
AQUA_T = (2002 - Y0) * 12 + 6       # Aqua fire data starts Jul 2002; before that MODIS is Terra only
RES = 0.5                           # grid cell size in degrees
NCOL, NROW = int(360 / RES), int(180 / RES)
MODIS_MIN_CONF = 30                 # drop MODIS "low confidence" (<30 %)
SHRINK_GRID = (3, 10, 30, 100, 300) # candidate pseudo-counts, picked by hold-out error


def zip_names():
    names = [f"modis_{y}_all_countries.zip" for y in range(Y0, Y1 + 1)]
    names += [f"viirs-snpp_{y}_all_countries.zip" for y in range(VIIRS_Y0, Y1 + 1)]
    return names


def download(raw):
    os.makedirs(raw, exist_ok=True)
    for name in zip_names():
        dst = os.path.join(raw, name)
        if os.path.exists(dst):
            continue
        print("downloading", name, flush=True)
        urllib.request.urlretrieve(BASE.format(name=name), dst + ".part")
        os.replace(dst + ".part", dst)


def aggregate(job):
    """One yearly zip -> {country: {cell: [12 monthly counts] + [12 Terra-only counts]}}."""
    path, out = job
    if os.path.exists(out):
        return out
    base = os.path.basename(path)
    sensor, year = base.split("_")[0], base.split("_")[1]
    modis = sensor == "modis"
    prefix = f"{sensor}_{year}_"
    res, stats = {}, Counter()
    with zipfile.ZipFile(path) as zf:
        for member in zf.namelist():
            if not member.endswith(".csv"):
                continue
            country = os.path.basename(member)[len(prefix):-4].replace("_", " ")
            cells = res.setdefault(country, {})
            with zf.open(member) as f:
                head = f.readline().decode().strip().split(",")
                ilat, ilon, idate = head.index("latitude"), head.index("longitude"), head.index("acq_date")
                isat, iconf = head.index("satellite"), head.index("confidence")
                itype = head.index("type") if "type" in head else -1
                n = static = lowconf = 0
                for line in f:
                    p = line.rstrip().split(b",")
                    n += 1
                    # type 0 = presumed vegetation fire; 1 volcano, 2 other static land source (gas flares,
                    # industry), 3 offshore. Near-real-time rows carry no type and are kept.
                    if itype >= 0 and p[itype] not in (b"0", b""):
                        static += 1
                        continue
                    if modis:
                        if int(p[iconf]) < MODIS_MIN_CONF:
                            lowconf += 1
                            continue
                    elif p[iconf] in (b"l", b"low"):
                        lowconf += 1
                        continue
                    row = min(NROW - 1, int((float(p[ilat]) + 90.0) / RES))
                    col = min(NCOL - 1, int((float(p[ilon]) + 180.0) / RES))
                    m = int(p[idate][5:7]) - 1
                    a = cells.get(row * NCOL + col)
                    if a is None:
                        a = cells[row * NCOL + col] = [0] * 24
                    a[m] += 1
                    if modis and p[isat] == b"Terra":
                        a[12 + m] += 1
                stats["rows"] += n
                stats["static"] += static
                stats["lowconf"] += lowconf
                if itype < 0:
                    stats["rows_without_type"] += n
    with open(out + ".part", "wb") as f:
        pickle.dump((sensor, int(year), res, dict(stats)), f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(out + ".part", out)
    return out


# ----------------------------------------------------------------------------------------------
# Harmonization
#
# Every MODIS count is converted to "VIIRS-equivalent" counts with a local factor
#     k = (sum of VIIRS + lam * k_parent) / (sum of MODIS + lam)
# estimated on the months both sensors observed. The pseudo-count lam shrinks cells with little
# data toward their country's factor, and countries with little data toward the global factor.
#
# ponytail: one constant factor per cell. A season- or fire-size-dependent model is the upgrade
# path if the hold-out error below ever matters more than keeping this explainable.
# ----------------------------------------------------------------------------------------------

def fit_factors(sum_v, sum_m, unit_country, lam):
    """sum_v/sum_m: per-unit sums over the fitting months. Returns (k per unit, k per country, k global)."""
    tot_v, tot_m = sum(sum_v), sum(sum_m)
    k_global = tot_v / tot_m if tot_m else 1.0
    cv, cm = defaultdict(float), defaultdict(float)
    for u, c in enumerate(unit_country):
        cv[c] += sum_v[u]
        cm[c] += sum_m[u]
    k_country = {c: (cv[c] + lam * k_global) / (cm[c] + lam) for c in cm}
    k_unit = [(sum_v[u] + lam * k_country[c]) / (sum_m[u] + lam) for u, c in enumerate(unit_country)]
    return k_unit, k_country, k_global


def median_abs_pct_error(pairs, floor=20):
    """pairs of (predicted, observed); only observations >= floor count (tiny counts are all noise)."""
    e = [abs(p - o) / o for p, o in pairs if o >= floor]
    return (statistics.median(e) if e else float("nan")), len(e)


def selftest():
    import random
    rnd = random.Random(7)
    unit_country = [0] * 40 + [1] * 40
    true_k = [3.0] * 40 + [5.0] * 40
    sm = [rnd.randint(200, 2000) for _ in true_k]
    sv = [m * k * rnd.uniform(0.95, 1.05) for m, k in zip(sm, true_k)]
    k, kc, kg = fit_factors(sv, sm, unit_country, lam=30)
    assert all(abs(a - b) / b < 0.08 for a, b in zip(k, true_k)), "per-cell factor not recovered"
    assert abs(kc[0] - 3) < 0.2 and abs(kc[1] - 5) < 0.2, "per-country factor not recovered"
    # a cell with no data falls back to its country's factor
    k2, kc2, _ = fit_factors(sv + [0.0], sm + [0.0], unit_country + [1], lam=30)
    assert abs(k2[-1] - kc2[1]) < 1e-9, "empty cell must inherit its country factor"
    err, n = median_abs_pct_error([(110, 100), (90, 100), (5, 1)])
    assert abs(err - 0.10) < 1e-9 and n == 2
    print("selftest ok")


def harmonize_and_pack(interim, out_dir):
    # ---- load yearly aggregates into dense per-unit arrays ----
    yearly, stats = [], Counter()
    units = set()
    for name in sorted(os.listdir(interim)):
        if not name.endswith(".pkl"):
            continue
        with open(os.path.join(interim, name), "rb") as f:
            sensor, year, res, st = pickle.load(f)
        yearly.append((sensor, year, res))
        for k, v in st.items():
            stats[sensor + "_" + k] += v
        for country, cells in res.items():
            units.update((country, c) for c in cells)
    units = sorted(units)
    index = {u: i for i, u in enumerate(units)}
    countries = sorted({c for c, _ in units})
    cidx = {c: i for i, c in enumerate(countries)}
    U = len(units)
    unit_country = [cidx[c] for c, _ in units]
    print(f"{U} grid units in {len(countries)} countries", flush=True)

    M = [None] * U    # MODIS (Terra + Aqua) monthly counts, NT months
    V = [None] * U    # VIIRS monthly counts, NV months
    TERRA = [None] * U  # Terra-only monthly counts over the VIIRS years (to convert the pre-Aqua months)
    for u in range(U):
        M[u], V[u], TERRA[u] = [0] * NT, [0] * NV, [0] * NV
    for sensor, year, res in yearly:
        t0 = (year - Y0) * 12
        for country, cells in res.items():
            for cell, a in cells.items():
                u = index[(country, cell)]
                if sensor == "modis":
                    M[u][t0:t0 + 12] = a[:12]
                    if year >= VIIRS_Y0:
                        TERRA[u][t0 - V0:t0 - V0 + 12] = a[12:]
                else:
                    V[u][t0 - V0:t0 - V0 + 12] = a[:12]
    del yearly

    overlap = range(V_FULL, NT)                         # months both sensors observed in full
    def sums(months, modis=M):
        sv = [sum(V[u][t - V0] for t in months) for u in range(U)]
        sm = [sum(modis[u][t] if modis is M else modis[u][t - V0] for t in months) for u in range(U)]
        return sv, sm

    # ---- hold-out validation: fit on even years, predict the odd years ----
    fit_m = [t for t in overlap if (Y0 + t // 12) % 2 == 0]
    test_m = [t for t in overlap if (Y0 + t // 12) % 2 == 1]
    sv_fit, sm_fit = sums(fit_m)

    def score(k_of_unit):
        """Median abs % error of MODIS-converted vs VIIRS-observed, at three aggregation levels."""
        cm, cy, cell_y = defaultdict(lambda: [0.0, 0.0]), defaultdict(lambda: [0.0, 0.0]), []
        for u in range(U):
            k, c, mu, vu = k_of_unit(u), unit_country[u], M[u], V[u]
            by_year = defaultdict(lambda: [0.0, 0.0])
            for t in test_m:
                p, o = k * mu[t], vu[t - V0]
                if p or o:
                    a = cm[(c, t)]; a[0] += p; a[1] += o
                    a = cy[(c, t // 12)]; a[0] += p; a[1] += o
                    a = by_year[t // 12]; a[0] += p; a[1] += o
            cell_y.extend(by_year.values())
        return {"country_month": median_abs_pct_error(cm.values()),
                "country_year": median_abs_pct_error(cy.values()),
                "cell_year": median_abs_pct_error(cell_y)}

    results = {}
    k_unit, k_country, k_global = fit_factors(sv_fit, sm_fit, unit_country, lam=30)
    results["none (raw MODIS)"] = score(lambda u: 1.0)
    results["one global factor"] = score(lambda u: k_global)
    results["one factor per country"] = score(lambda u: k_country[unit_country[u]])
    best_lam, best_err = None, float("inf")
    for lam in SHRINK_GRID:
        ku, _, _ = fit_factors(sv_fit, sm_fit, unit_country, lam)
        r = score(lambda u: ku[u])
        results[f"per cell, shrinkage {lam}"] = r
        if r["cell_year"][0] < best_err:
            best_lam, best_err = lam, r["cell_year"][0]
    print("hold-out median abs % error (fit on even years, test on odd years):")
    for name, r in results.items():
        print(f"  {name:28s}" + "".join(f"  {k} {100 * v[0]:5.1f}% (n={v[1]})" for k, v in r.items()))
    print("chosen shrinkage:", best_lam, flush=True)

    # ---- final factors: all overlap months ----
    sv_all, sm_all = sums(overlap)
    k_ta, _, kg_ta = fit_factors(sv_all, sm_all, unit_country, best_lam)
    _, st_all = sums(overlap, TERRA)
    k_t, _, kg_t = fit_factors(sv_all, st_all, unit_country, best_lam)

    # ---- the headline check: does the 2012 step disappear? ----
    def annual(series_of_unit):
        tot = [0.0] * (NT // 12)
        for u in range(U):
            s = series_of_unit(u)
            for t in range(NT):
                tot[t // 12] += s[t]
        return tot

    def harm(u):
        mu, vu, a, b = M[u], V[u], k_t[u], k_ta[u]
        return [a * mu[t] if t < AQUA_T else b * mu[t] if t < V_FULL else vu[t - V0] for t in range(NT)]

    def raw(u):
        mu, vu = M[u], V[u]
        return [mu[t] if t < V_FULL else vu[t - V0] for t in range(NT)]

    ann_raw, ann_harm, ann_modis = annual(raw), annual(harm), annual(lambda u: M[u])
    pre, post = slice(2, VIIRS_Y0 - Y0), slice(VIIRS_Y0 - Y0 + 1, None)   # 2003-2011 vs 2013-2025
    step = lambda a: statistics.mean(a[post]) / statistics.mean(a[pre])
    # MODIS flew the whole time, so its own step is the real trend the harmonized record should keep
    print(f"global step across 2012: raw x{step(ann_raw):.2f}, harmonized x{step(ann_harm):.2f}, "
          f"MODIS alone x{step(ann_modis):.2f}", flush=True)

    # ---- pack ----
    clipped = 0
    def u16(rows):
        nonlocal clipped
        out = array.array("H")
        for r in rows:
            for v in r:
                if v > 65535:
                    clipped += 1
                    v = 65535
                out.append(v)
        return out

    meta = {
        "version": 1, "generated": time.strftime("%Y-%m-%d"),
        "y0": Y0, "months": NT, "viirsStart": V0, "viirsFull": V_FULL, "aquaStart": AQUA_T, "viirsMonths": NV,
        "res": RES, "ncol": NCOL, "units": U, "countries": countries,
        "globalFactor": {"terraAqua": round(kg_ta, 3), "terraOnly": round(kg_t, 3)},
        "shrinkage": best_lam,
        "validation": {name: {k: [round(100 * v[0], 1), v[1]] for k, v in r.items()} for name, r in results.items()},
        "step2012": {"raw": round(step(ann_raw), 2), "harmonized": round(step(ann_harm), 2),
                     "modisOnly": round(step(ann_modis), 2)},
        "annual": {"raw": [round(x) for x in ann_raw], "harmonized": [round(x) for x in ann_harm],
                   "modisOnly": [round(x) for x in ann_modis]},
        "filters": {"modisMinConfidence": MODIS_MIN_CONF, "viirsDropLow": True, "typeKept": 0},
        "rows": dict(stats),
        "sources": ["FIRMS MODIS Collection 6.1 (MCD14ML)", "FIRMS VIIRS S-NPP 375 m (VNP14IMGT)"],
    }
    head = json.dumps(meta, separators=(",", ":")).encode()
    head += b" " * (-len(head) % 4)
    blob = bytearray(len(head).to_bytes(4, "little") + head)
    for arr in (array.array("I", [c for _, c in units]), array.array("f", k_ta), array.array("f", k_t),
                array.array("H", unit_country), u16(M), u16(V)):
        assert arr.itemsize in (2, 4) and len(blob) % arr.itemsize == 0
        blob += arr.tobytes()
        blob += b"\0" * (-len(blob) % 4)
    assert sys.byteorder == "little"
    if clipped:
        print("WARNING: values clipped to 65535:", clipped)
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, "firepulse.bin.gz")
    with gzip.open(dst, "wb", compresslevel=9) as f:
        f.write(blob)
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({k: v for k, v in meta.items() if k != "countries"}, f, indent=1)
    print(f"wrote {dst}: {os.path.getsize(dst) / 1e6:.1f} MB gzipped, {len(blob) / 1e6:.1f} MB raw")


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default=os.path.join(here, "data", "raw"), help="where the FIRMS zips live")
    ap.add_argument("--interim", default=os.path.join(here, "data", "interim"), help="yearly aggregates")
    ap.add_argument("--out", default=os.path.join(here, "docs", "data"))
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.no_download:
        download(a.raw)
    os.makedirs(a.interim, exist_ok=True)
    jobs = [(os.path.join(a.raw, n), os.path.join(a.interim, n[:-4].replace("_all_countries", "") + ".pkl"))
            for n in zip_names() if os.path.exists(os.path.join(a.raw, n))]
    missing = set(zip_names()) - {os.path.basename(p) for p, _ in jobs}
    if missing:
        sys.exit(f"missing zips in {a.raw}: {sorted(missing)}")
    jobs.sort(key=lambda j: -os.path.getsize(j[0]))
    t = time.time()
    with Pool(a.jobs) as pool:
        for done in pool.imap_unordered(aggregate, jobs):
            print(f"aggregated {os.path.basename(done)}  ({time.time() - t:.0f}s)", flush=True)
    harmonize_and_pack(a.interim, a.out)


if __name__ == "__main__":
    main()
