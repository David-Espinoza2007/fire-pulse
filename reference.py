"""Download Natural Earth states and populated places (public domain) and save small parquet files.

    python reference.py
"""
import urllib.request
from pathlib import Path

import duckdb

OUT = Path(__file__).parent / "data/reference"
BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
FILES = ("ne_10m_admin_1_states_provinces", "ne_10m_populated_places_simple")


def main():
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    for f in FILES:
        if not (OUT / f"raw/{f}.geojson").exists():
            urllib.request.urlretrieve(f"{BASE}{f}.geojson", OUT / f"raw/{f}.geojson")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    raw = lambda f: (OUT / f"raw/{f}.geojson").as_posix()
    con.execute(f"""COPY (
      SELECT name, admin AS country, ST_XMin(geom) AS w, ST_YMin(geom) AS s, ST_XMax(geom) AS e, ST_YMax(geom) AS n,
             ST_Area(geom) AS area, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.02)) AS geojson
      FROM ST_Read('{raw(FILES[0])}') WHERE name IS NOT NULL AND name <> '' ORDER BY area DESC
    ) TO '{(OUT / 'states.parquet').as_posix()}' (FORMAT parquet)""")
    con.execute(f"""COPY (
      SELECT name, ST_X(geom) AS lon, ST_Y(geom) AS lat, pop_max AS pop
      FROM ST_Read('{raw(FILES[1])}') WHERE name IS NOT NULL ORDER BY pop DESC
    ) TO '{(OUT / 'places.parquet').as_posix()}' (FORMAT parquet)""")


if __name__ == "__main__":
    main()
