# Fire Pulse

Where it burns, and whether that is normal. One consistent record of satellite fire detections from
2000 to today, for any country, state or drawn area, built for a fire manager. Made for the NASA
Space Apps 2026 challenge "Harmonization of MODIS and VIIRS Hot Spots".

This branch replaces the first static prototype (`docs/`, `scripts/` on `main`) with a Python API
and a new page. The look and the globe come from that prototype.

## Quick start (uses the Mexico data included in the repository)

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn app:app --port 8000
```

Open http://localhost:8000. Without world data the app reads `data/mx` (Mexico only), so the
globe glows only over Mexico. The "last 7 days" layer downloads one public FIRMS file (35 MB) on
first use. Run the tests with `.venv/Scripts/python -m pytest -q` (24 tests).

Add `?perf=1` to the address to see frame times on the map.

## The problem

MODIS (1 km pixels, since 2000) and VIIRS (375 m pixels, since 2012) both detect fires, but VIIRS
sees many small fires that MODIS misses. If you add the two records, fire activity seems to jump
when VIIRS starts: the yearly world count goes from 4.4 million in 2011 to 21.9 million in 2012.
The jump is the new sensor, not more fire.

## The method

The unit is the **adjusted fire detection**: the number of detections Aqua MODIS would have
reported. Aqua is the reference because it passes at the same local time as VIIRS.

1. **Clean.** Keep vegetation fires only (`type = 0`), drop the low-confidence class of each sensor.
2. **Grid.** One row per 0.05 degree cell, local solar date, day or night, and satellite.
3. **Conversion tables.** In the years when both sensors flew, look up how many Aqua pixels were in
   the same cell, date and day/night as each VIIRS row. Average this per class of fire radiative
   power, pixel count, and day/night, per 5 degree tile, falling back to the 20 degree tile and
   then to the globe.
4. **Calibration.** A ratio of sums per region, calendar month and day/night adds the Aqua pixels
   that had no VIIRS partner and removes the seasonal difference. Day and night are calibrated
   separately; calibrating them together overstated night fires by about 30 %.
5. **Series.** Terra scaled to Aqua before August 2002, real Aqua until 2021, converted NOAA-20
   from 2022 (Aqua's orbit drifts in these years). Days when Aqua did not record are found from
   the data and filled.
6. **Also carried:** the night part of the count, and fire radiative power (less certain).
7. **This week.** The public FIRMS file with the last 7 days of NOAA-20 detections is converted
   with the same tables. Permanent heat sources are left out: cells the archive labels as
   industrial, volcanic or offshore, and cells that burn in at least 10 months of a year on at
   least 30 days with at least 40 % of detections at night (gas flares, smelters).
8. **Proof.** Each overlap year is hidden in turn, the tables are learned from the other years, and
   the converted VIIRS is compared with real Aqua.

Results on hidden years, whole world, error per 5 degree tile and month:

| Method | NOAA-20, 2018-2021 | Suomi NPP, 2012-2021 |
|---|---|---|
| Raw VIIRS counts | 513 % | 513 % |
| One global factor | 29 % | 28 % |
| Monthly ratio per region | 17 % | 16 % |
| Conversion tables (used) | 12 % | 12 % |

Two identical VIIRS instruments disagree by 6 % after conversion, so 12 % is close to the limit.
Fire radiative power: 17 to 18 %.

## Build the data yourself

```bash
.venv/Scripts/python pipeline.py --root data/mx --countries Mexico                       # under a minute
.venv/Scripts/python pipeline.py --root data/world --sensors modis viirs-jpss1 viirs-snpp  # every country
.venv/Scripts/python reference.py                                                         # states and place names
```

The pipeline downloads the yearly country archives from NASA FIRMS into `data/zips` (about 10 GB
for all three sensors; each file holds all countries, so the Mexico build downloads them too). On a
16 GB laptop the world build takes roughly 40 minutes and needs about 25 GB of free disk for
temporary files. When `data/world` exists the app uses it instead of `data/mx`. `FIRE_DATA=<folder>`
picks a data folder explicitly.

Not in the repository (too large): `data/zips`, `data/world`, and the Mexico hotspot archive
(`data/mx/hotspots`, needed only for "Download detections").

## How the map stays detailed

The map draws squares of about 50, 25, 10 or 5 km, chosen so that a square is always 3 to 8
pixels wide. The three finer sizes come as map tiles of 100 by 100 cells. Each tile holds every
month since November 2000 for its area, so the page can move the timeline or play it without
asking the server again. Tiles load while the map moves; until a tile arrives, the page draws the
coarser data it already has. The page keeps up to 250 MB of tiles in memory.

The server builds a tile on first request (under a second) and keeps it in `serve/tiles`. To build
all of them in advance (about 3 minutes and 230 MB for the world):

```bash
.venv/Scripts/python tiles.py --root data/world --level 1    # then --level 2 and --level 3
```

The grid stops at 5 km on purpose. A MODIS pixel is 1 km below the satellite but about 2 by 5 km at
the edge of the scan, and the method must find the same fire in the same cell for both sensors.
The last 7 days are different: every detection is drawn at its own position.

## Files

- `harmonize.py` - the method, as DuckDB SQL: grid, conversion tables, calibration, ratios.
- `pipeline.py` - download, clean, grid, fit, validate, write the tables the app reads, build the
  mask of permanent heat sources.
- `reference.py` - downloads Natural Earth states and populated places for the map and place labels.
- `app.py` - FastAPI. Main endpoints: `/api/calendar` (monthly record for a country, box or
  polygon, with day/night filter), `/api/tiles/{level}/{tx}/{ty}` (map tiles with all months),
  `/api/live*` (last 7 days: totals, "where to look first", and `/api/live/points.bin` with every
  detection of the week), `/api/states`, `/api/places`, `/api/validation`, `/api/hotspots.csv`,
  `/api/globe.bin` (the 50 km grid for the whole globe).
- `tiles.py` - builds the map tiles (binary layout in its first lines).
- `static/` - the page: `index.html`, `style.css`, `app.js`, `vendor/` (D3, topojson-client,
  country shapes). A canvas globe that turns into a flat map when you zoom in.
- `test_harmonize.py`, `test_api.py` - a synthetic record with a known answer, invariants of the
  build, and the API on the Mexico data.
- `SLIDES.md` - draft of the 7 slides. `screenshots/` - pictures for them (older layout).

## Limits

- The monthly record ends in December 2025, the last month in the FIRMS yearly files. The months
  of 2026 need a FIRMS MAP_KEY and are not included. The last 7 days are shown separately.
- Counts are not corrected for cloud cover. A cloudy month looks like a quiet month.
- After 2021 the conversion cannot be checked against Aqua, because Aqua's orbit drifts.
- Small fires that MODIS never saw before VIIRS cannot be recovered.
- Values before August 2002 come from Terra, which passes in the morning. They are less certain
  (about 30 % error), and Terra outages in 2001 and 2002 make some of those months too low.
- The mask of permanent heat sources is conservative, so some gas flares that burn irregularly
  still appear in the last 7 days. In the long record, a flare that FIRMS has not classified yet
  counts as a vegetation fire; this matters for small areas, not for countries.
- The country files hold detections inside country borders only. A grid cell on a border is
  counted for the country with most of its detections.

## Data and credits

Active fire data: NASA FIRMS (https://firms.modaps.eosdis.nasa.gov), MODIS Collection 6.1 and
VIIRS 375 m, standard processing; last 7 days from the FIRMS near-real-time NOAA-20 file. We
acknowledge the use of data from NASA's Fire Information for Resource Management System (FIRMS),
part of NASA's Earth Science Data and Information System (ESDIS). Country shapes, states and place
names: Natural Earth. Libraries: DuckDB, FastAPI, D3, topojson-client. NASA does not endorse this
project. No NASA logos or insignia are used.

## Use of AI

The code in this repository (data pipeline, API and web page) and this README were generated with
Claude (Anthropic) under the direction of the team, then run and tested against the real FIRMS
data. No images, video or audio were generated with AI.
