"""Make MODIS and VIIRS hotspot counts comparable.

Unit of the result: "MODIS-equivalent hotspots" = the number of hotspot pixels
Aqua MODIS would have reported. Everything here is DuckDB SQL, so the same code
runs on a synthetic test table and on the full global record.
"""

CELL = 0.05                  # degrees; grid used for matching and for serving
MIN_N = 300                  # samples a class needs before a tile uses its own value
FRP_EDGES = (2, 5, 10, 20, 50, 100, 250, 500)   # MW, upper edges of FRP-sum classes 1..8
AQUA_START = "2002-08-01"    # first full Aqua month; Terra-scaled values are used before it
MODEL_START = "2022-01-01"   # Aqua's orbit drifts from here on; converted VIIRS takes over
BASELINE = (2003, 2020)      # real Aqua years used for medians and anomaly classes
RANGE_EDGES = (10, 30, 100, 300, 1000, 3000)
MODEL_TABLES = ("l5", "l20", "lg", "l0", "ratio", "ratio_g", "ratio_0", "cal", "cal_g", "cal_0")   # what fit() writes and apply() reads

# Keep presumed vegetation fires, drop the low-confidence class of each sensor.
CLEAN = """(type IS NULL OR type = 0) AND CASE WHEN satellite IN ('Terra', 'Aqua')
           THEN TRY_CAST(confidence AS INT) >= 30 ELSE lower(confidence[1]) <> 'l' END"""

KEY = "cell_x, cell_y, local_date, daynight"
# FRP of 0 on a high-confidence VIIRS pixel means the sensor saturated: strongest class.
FC = ("CASE WHEN sat_flag THEN 9 WHEN frp_sum <= 0 THEN 0 "
      + " ".join(f"WHEN frp_sum <= {e} THEN {i + 1}" for i, e in enumerate(FRP_EDGES))
      + " ELSE 9 END")
PC = "CASE WHEN n_pixels = 1 THEN 0 WHEN n_pixels <= 3 THEN 1 WHEN n_pixels <= 9 THEN 2 ELSE 3 END"
T5 = "CAST(floor(cell_x / 100.0) AS INT) AS t5x, CAST(floor(cell_y / 100.0) AS INT) AS t5y"
T20 = "CAST(floor(cell_x / 400.0) AS INT) AS t20x, CAST(floor(cell_y / 400.0) AS INT) AS t20y"


def cell_pass_sql(src, satellite):
    """One row per grid cell, local solar date and day/night for one satellite."""
    return f"""
    SELECT {KEY}, CAST(count(*) AS INT) AS n_pixels, CAST(coalesce(sum(frp), 0) AS FLOAT) AS frp_sum,
           bool_or(coalesce(frp, 0) <= 0 AND lower(confidence[1]) = 'h') AS sat_flag,
           CAST(count(DISTINCT minute // 45) AS TINYINT) AS n_pass, mode(country) AS country
    FROM (SELECT CAST(floor(longitude / {CELL}) AS INT) AS cell_x, CAST(floor(latitude / {CELL}) AS INT) AS cell_y,
                 -- local solar time = UTC + 4 minutes per degree of longitude
                 CAST(acq_date + to_minutes(CAST(acq_time // 100 * 60 + acq_time % 100 + round(longitude * 4) AS BIGINT)) AS DATE) AS local_date,
                 daynight, frp, confidence, country, acq_time // 100 * 60 + acq_time % 100 AS minute
          FROM {src} WHERE satellite = '{satellite}' AND {CLEAN})
    GROUP BY {KEY}"""


def _classed(rel, where):
    return f"(SELECT *, {FC} AS fc, {PC} AS pc, {T5}, {T20}, month(local_date) AS m FROM {rel} WHERE {where})"


def fit(con, name, viirs, aqua, train):
    """Learn from overlap rows how many Aqua pixels one VIIRS cell-pass stands for.

    Writes temp tables {name}_l5/_l20/_lg/_l0 (conversion tables, fine to coarse),
    {name}_ratio/_ratio_g/_ratio_0 (ratio of sums per region and month, fine to coarse) and
    {name}_cal/_cal_g/_cal_0 (the same per region, month and day/night, used to calibrate the tables).
    """
    con.execute(f"""
      CREATE OR REPLACE TEMP TABLE {name}_pairs AS
      SELECT v.daynight, v.fc, v.pc, v.t5x, v.t5y, v.t20x, v.t20y, v.m, v.n_pixels,
             coalesce(a.n_pixels, 0) AS aqua_n
      FROM {_classed(viirs, train)} v
      LEFT JOIN (SELECT {KEY}, n_pixels FROM {aqua} WHERE {train}) a
        ON v.cell_x = a.cell_x AND v.cell_y = a.cell_y AND v.local_date = a.local_date AND v.daynight = a.daynight""")
    for level, cols in (("l5", "t5x, t5y, daynight, fc, pc"), ("l20", "t20x, t20y, daynight, fc, pc"),
                        ("lg", "daynight, fc, pc"), ("l0", "daynight")):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE {name}_{level} AS
                        SELECT {cols}, count(*) AS n, avg(aqua_n) AS mu FROM {name}_pairs GROUP BY {cols}""")
    # Every Aqua pixel of the training rows, with or without a VIIRS partner
    con.execute(f"""CREATE OR REPLACE TEMP TABLE {name}_aq AS
                    SELECT {T20}, month(local_date) AS m, daynight, n_pixels FROM {aqua} WHERE {train}""")
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name}_mu AS SELECT t20x, t20y, m, daynight, n_pixels, mu FROM ({_mu(name, name + '_pairs')})")
    # Ratio of sums per region and calendar month. On raw VIIRS pixels it is the simple method (_ratio).
    # On the table output it is a calibration (_cal, also split by day/night, so the night part matches
    # Aqua's): it adds the Aqua pixels with no VIIRS partner and removes what is left of the seasonal difference.
    for table, level, cols in (("ratio", "", "t20x, t20y, m"), ("ratio", "_g", "m"), ("ratio", "_0", None),
                               ("cal", "", "t20x, t20y, m, daynight"), ("cal", "_g", "m, daynight"), ("cal", "_0", "daynight")):
        group = f"GROUP BY {cols}" if cols else ""
        on = " AND ".join(f"a.{c} = v.{c}" for c in cols.split(", ")) if cols else "TRUE"
        keep = ", ".join(f"v.{c}" for c in cols.split(", ")) + "," if cols else ""
        con.execute(f"""CREATE OR REPLACE TEMP TABLE {name}_{table}{level} AS
          SELECT {keep} v.tot AS v_tot, coalesce(a.tot, 0) / v.tot AS ratio, coalesce(a.tot, 0) / nullif(v.mu, 0) AS cal
          FROM (SELECT {cols + ',' if cols else ''} sum(n_pixels) AS tot, sum(mu) AS mu FROM {name}_mu {group}) v
          LEFT JOIN (SELECT {cols + ',' if cols else ''} sum(n_pixels) AS tot FROM {name}_aq {group}) a ON {on}""")


def _mu(name, rel):
    """SQL: every row of rel with mu, the table value of the finest tile that has enough samples."""
    pick = lambda t: f"CASE WHEN {t}.n >= {MIN_N} THEN {t}.mu END"
    return f"""
    SELECT v.*, coalesce({pick('l5')}, {pick('l20')}, lg.mu, l0.mu, 0) AS mu
    FROM {rel} v
    LEFT JOIN {name}_l5 l5 ON l5.t5x = v.t5x AND l5.t5y = v.t5y AND l5.daynight = v.daynight AND l5.fc = v.fc AND l5.pc = v.pc
    LEFT JOIN {name}_l20 l20 ON l20.t20x = v.t20x AND l20.t20y = v.t20y AND l20.daynight = v.daynight AND l20.fc = v.fc AND l20.pc = v.pc
    LEFT JOIN {name}_lg lg ON lg.daynight = v.daynight AND lg.fc = v.fc AND lg.pc = v.pc
    LEFT JOIN {name}_l0 l0 ON l0.daynight = v.daynight"""


def apply(name, viirs, where):
    """SQL: convert VIIRS cell-passes with three methods (tables, monthly ratio, one global factor)."""
    pick = lambda r, col: f"coalesce(CASE WHEN {r}.v_tot >= {MIN_N} THEN {r}.{col} END, {r}g.{col}, {r}0.{col}, 0)"
    return f"""
    SELECT v.cell_x, v.cell_y, v.local_date, v.daynight, v.n_pixels, v.t5x, v.t5y,
      v.mu * {pick('c', 'cal')} AS est_table, v.n_pixels * {pick('r', 'ratio')} AS est_ratio,
      v.n_pixels * coalesce(r0.ratio, 0) AS est_global
    FROM ({_mu(name, _classed(viirs, where))}) v
    LEFT JOIN {name}_ratio r ON r.t20x = v.t20x AND r.t20y = v.t20y AND r.m = v.m
    LEFT JOIN {name}_ratio_g rg ON rg.m = v.m
    CROSS JOIN {name}_ratio_0 r0
    LEFT JOIN {name}_cal c ON c.t20x = v.t20x AND c.t20y = v.t20y AND c.m = v.m AND c.daynight = v.daynight
    LEFT JOIN {name}_cal_g cg ON cg.m = v.m AND cg.daynight = v.daynight
    LEFT JOIN {name}_cal_0 c0 ON c0.daynight = v.daynight"""


def fit_frp(con, name, viirs, aqua, train):
    """VIIRS-to-Aqua FRP ratio of sums per 20 degree tile and calendar month, fine to coarse.

    Writes {name}_fr/_fr_g/_fr_0, apart from MODEL_TABLES so apply() keeps working on old model files.
    """
    for level, cols in (("fr", "t20x, t20y, m"), ("fr_g", "m"), ("fr_0", None)):
        sel, group = (cols + ",", f"GROUP BY {cols}") if cols else ("", "")
        on = " AND ".join(f"a.{c} = v.{c}" for c in cols.split(", ")) if cols else "TRUE"
        keep = ", ".join(f"v.{c}" for c in cols.split(", ")) + "," if cols else ""
        side = lambda rel: f"""(SELECT {sel} sum(n_pixels) AS n, sum(frp_sum) AS frp
                                FROM (SELECT *, {T20}, month(local_date) AS m FROM {rel} WHERE {train}) {group})"""
        con.execute(f"""CREATE OR REPLACE TEMP TABLE {name}_{level} AS
          SELECT {keep} v.n AS v_tot, coalesce(a.frp, 0) / nullif(v.frp, 0) AS ratio
          FROM {side(viirs)} v LEFT JOIN {side(aqua)} a ON {on}""")


def apply_frp(name, viirs, where):
    """SQL: Aqua-equivalent FRP (MW) of VIIRS cell-passes, one row per key."""
    return f"""
    SELECT v.cell_x, v.cell_y, v.local_date, v.daynight,
      v.frp_sum * coalesce(CASE WHEN r.v_tot >= {MIN_N} THEN r.ratio END, rg.ratio, r0.ratio, 0) AS est_frp
    FROM (SELECT *, {T20}, month(local_date) AS m FROM {viirs} WHERE {where}) v
    LEFT JOIN {name}_fr r ON r.t20x = v.t20x AND r.t20y = v.t20y AND r.m = v.m
    LEFT JOIN {name}_fr_g rg ON rg.m = v.m
    CROSS JOIN {name}_fr_0 r0"""


def fit_terra(con, name, terra, aqua, train):
    """Terra-to-Aqua ratio of sums (pixels and FRP) per 20 degree tile, calendar month and day/night."""
    for level, cols in (("tr", "t20x, t20y, m, daynight"), ("tr_g", "m, daynight"), ("tr_0", "daynight")):
        on = " AND ".join(f"a.{c} = t.{c}" for c in cols.split(", "))
        keep = ", ".join(f"t.{c}" for c in cols.split(", "))
        side = lambda rel: f"""(SELECT {cols}, sum(n_pixels) AS tot, sum(frp_sum) AS frp
                                FROM (SELECT *, {T20}, month(local_date) AS m FROM {rel} WHERE {train}) GROUP BY {cols})"""
        con.execute(f"""CREATE OR REPLACE TEMP TABLE {name}_{level} AS
          SELECT {keep}, t.tot, coalesce(a.tot, 0) / t.tot AS ratio, coalesce(a.frp, 0) / nullif(t.frp, 0) AS frp_ratio
          FROM {side(terra)} t LEFT JOIN {side(aqua)} a ON {on}""")


def apply_terra(name, terra, where):
    """SQL: Terra cell-passes scaled to Aqua-equivalent pixel counts and FRP."""
    pick = lambda col: f"coalesce(CASE WHEN r.tot >= {MIN_N} THEN r.{col} END, rg.{col}, r0.{col}, 0)"
    return f"""
    SELECT t.cell_x, t.cell_y, t.local_date, t.daynight, t.n_pixels, t.t5x, t.t5y,
      t.n_pixels * {pick('ratio')} AS est, t.frp_sum * {pick('frp_ratio')} AS est_frp
    FROM (SELECT *, {T5}, {T20}, month(local_date) AS m FROM {terra} WHERE {where}) t
    LEFT JOIN {name}_tr r ON r.t20x = t.t20x AND r.t20y = t.t20y AND r.m = t.m AND r.daynight = t.daynight
    LEFT JOIN {name}_tr_g rg ON rg.m = t.m AND rg.daynight = t.daynight
    LEFT JOIN {name}_tr_0 r0 ON r0.daynight = t.daynight"""


QUANTILES = "[0.1, 0.33, 0.5, 0.67, 0.9]"


def level_sql(value, q):
    """SQL: 0 (well below) to 4 (well above) for a monthly value against baseline quantiles q (see QUANTILES)."""
    return f"""CASE WHEN {value} < {q}[1] THEN 0 WHEN {value} < {q}[2] THEN 1 WHEN {value} <= {q}[4] THEN 2
               WHEN {value} <= {q}[5] THEN 3 ELSE 4 END"""


def anomaly_sql(value, q):
    """SQL: name of the class; 'insufficient' when the baseline median is under 5 hotspots."""
    return f"""CASE WHEN {q}[3] < 5 THEN 'insufficient'
               ELSE (['well_below', 'below', 'near', 'above', 'well_above'])[{level_sql(value, q)} + 1] END"""


def range_sql(pairs, pred, actual):
    """SQL: spread of actual / predicted by size of the prediction, used to draw ranges."""
    edges = (0,) + RANGE_EDGES
    lo = "CASE " + " ".join(f"WHEN {pred} < {e} THEN {edges[i]}" for i, e in enumerate(RANGE_EDGES)) + f" ELSE {RANGE_EDGES[-1]} END"
    return f"""SELECT {lo} AS lo, count(*) AS n, quantile_cont({actual} / {pred}, 0.1) AS q10,
                      quantile_cont({actual} / {pred}, 0.5) AS q50, quantile_cont({actual} / {pred}, 0.9) AS q90
               FROM {pairs} WHERE {pred} > 0 GROUP BY 1 ORDER BY 1"""
