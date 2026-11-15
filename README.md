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
first use. Run the tests with `.venv/Scripts/python -m pytest -q`.

Add `?perf=1` to the address to see frame times on the map.

## The problem

MODIS (1 km pixels, since 2000) and VIIRS (375 m pixels, since 2012) both detect fires, but VIIRS
sees many small fires that MODIS misses. If you add the two records, fire activity seems to jump
when VIIRS starts: the yearly world count goes from 4.4 million in 2011 to 21.9 million in 2012.
The jump is the new sensor, not more fire.

## The method

The app keeps the record in two units and says for every month whether it is measured or estimated.

- **Fire detections (main view).** What the newer satellites (VIIRS) report. Measured from February
  2012. Earlier months are estimates from the two MODIS satellites, Aqua and Terra. This is the main
  view for two reasons: it keeps the small fires that VIIRS sees, and MODIS ends about 2027.
- **Strict long record.** What Aqua MODIS would have reported. Measured from August 2002 to 2021.
  Earlier months come from Terra, later months from VIIRS. Aqua is the reference because it passes
  at the same local time as VIIRS.

A third choice shows the counts as the satellites reported them. These cannot be compared across years.

1. **Clean.** Keep vegetation fires only (`type = 0`), drop the low-confidence class of each sensor.
2. **Grid.** One row per 0.05 degree cell, local solar date, day or night, and satellite.
3. **VIIRS to Aqua units: conversion tables.** In the years when both sensors flew, look up how many
   Aqua pixels were in the same cell, date and day/night as each VIIRS row. Average this per class
   of fire radiative power, pixel count, and day/night, per 5 degree tile, falling back to the
   20 degree tile and then to the globe.
4. **Calibration, twice.** A ratio of sums per 20 degree tile, calendar month and day/night adds the
   Aqua pixels that had no VIIRS partner and removes the seasonal difference. A second ratio per
   5 degree tile corrects what is left where the tile has enough data. Day and night are calibrated
   separately; calibrating them together overstated night fires by about 30 %.
5. **MODIS to VIIRS units: ratio of sums.** The other direction cannot use the tables, because
   30 % of VIIRS detections lie in cells where Aqua saw nothing that month. The estimate is the
   MODIS count times the ratio VIIRS / MODIS per 5 degree tile, calendar month and day/night, with
   the same fallbacks. Aqua and Terra are estimated separately and averaged with weights 0.7 and
   0.3; one alone is used when the other did not record.
6. **Series in VIIRS units.** Terra alone before August 2002, Aqua and Terra until January 2012,
   Suomi NPP scaled to NOAA-20 until April 2018, then NOAA-20 as measured.
7. **Series in Aqua units.** Terra scaled to Aqua before August 2002, real Aqua until 2021,
   converted NOAA-20 from 2022 (Aqua's orbit drifts in these years). Days when Aqua did not record
   are found from the data and filled.
8. **Also carried:** the night part of the count, and fire radiative power (less certain).
9. **This week.** The public FIRMS file with the last 7 days of NOAA-20 detections is shown as
   measured, or converted with the same tables for the strict record. Permanent heat sources are
   left out: cells the archive labels as industrial, volcanic or offshore, and cells that burn in
   at least 10 months of a year on at least 30 days with at least 40 % of detections at night (gas
   flares, smelters). Detections over the sea are left out too, because the long record holds
   land only.
10. **Proof.** Each overlap year is hidden in turn, the method is learned from the other years, and
    the estimate is compared with the measured count of the hidden year.

Results on hidden years, whole world, error per 5 degree tile and month.

Strict long record (VIIRS converted to Aqua units, compared with real Aqua):

| Method | NOAA-20, 2018-2021 | Suomi NPP, 2012-2021 |
|---|---|---|
| Raw VIIRS counts | 513 % | 513 % |
| One global factor | 29 % | 28 % |
| Monthly ratio per region | 17 % | 16 % |
| Conversion tables with both calibrations (used) | 11 % | 9 % |

Main view (MODIS converted to VIIRS units, compared with measured VIIRS, 2012-2021):

| Estimate from | Error |
|---|---|
| Aqua and Terra together (used) | 12 % |
| Aqua alone | 13 % |
| Terra alone (used before August 2002) | 16 % |

The raw counts of the two identical VIIRS instruments differ by 7 % at this size, so no method can
do much better. The totals are right within 1 % in both directions. Night counts are harder: the
night estimate in VIIRS units is off by 29 % per tile and month. Fire radiative power: 17 to 18 %.

The error depends on the size of the area, because errors of single places cancel out in a large
area. Hidden years, monthly count of one area:

| Size of the area | 2,200 km | 1,100 km | 550 km | 220 km | 110 km | 55 km |
|---|---|---|---|---|---|---|
| Strict record (both VIIRS satellites pooled) | 5 % | 7 % | 9 % | 14 % | 18 % | 25 % |
| Main view (estimate from Aqua and Terra) | 7 % | 9 % | 12 % | 18 % | 24 % | 31 % |

The map view "Confidence in the numbers" shows this error for every square of 1 degree (about
100 km), on land, for the unit in use. We chose 1 degree because it is the smallest area a fire
manager asks about, and because NOAA-20 and Suomi NPP, tested separately, give nearly the same map
at this size. Squares with fewer than 200 detections in the test are grey:
too few fires to test. Months in which a satellite did not record on some days are left out of
this test.

## Build the data yourself

```bash
.venv/Scripts/python pipeline.py --root data/mx --countries Mexico                       # under a minute
.venv/Scripts/python pipeline.py --root data/world --sensors modis viirs-jpss1 viirs-snpp  # every country
.venv/Scripts/python reference.py                                                         # states and place names
.venv/Scripts/python pipeline.py --root data/world --trust-only                           # only the confidence map, seconds
```

The pipeline downloads the yearly country archives from NASA FIRMS into `data/zips` (about 10 GB
for all three sensors; each file holds all countries, so the Mexico build downloads them too). On a
16 GB laptop the world build takes roughly 75 minutes and needs about 25 GB of free disk for
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

At the closest zoom (a 5 km square is 12 pixels or more) the page also draws every detection of the
selected month, from all satellites, as a white square of the pixel size: 375 m for VIIRS, 1 km for
MODIS. The squares below keep the comparable count; the points show where exactly the fires
were. This needs the hotspot archive (`<data>/hotspots`).

## Files

- `harmonize.py` - the method, as DuckDB SQL: grid, conversion tables, calibration, ratios in both directions.
- `pipeline.py` - download, clean, grid, fit, validate, write the tables the app reads, build the
  mask of permanent heat sources and the confidence map (`serve/trust.json`).
- `reference.py` - downloads Natural Earth states and populated places for the map and place labels.
- `app.py` - FastAPI. Main endpoints: `/api/calendar` (monthly record for a country, box or
  polygon, with day/night filter; `unit=viirs` or `unit=aqua` picks the record, and each month
  says whether it is measured), `/api/tiles/{level}/{tx}/{ty}` (map tiles with all months),
  `/api/live*` (last 7 days: totals, "where to look first", and `/api/live/points.bin` with every
  detection of the week), `/api/points.bin` (every detection of one month in a box), `/api/states`, `/api/places`, `/api/validation`, `/api/trust` (test
  error per square of 1 degree, for the confidence map), `/api/hotspots.csv`,
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
- Main view: months before February 2012 are estimates from MODIS. The total is reliable, but the
  estimate cannot say where the small fires were that MODIS never saw. Night counts of these years
  are weak for small areas (29 % error per 5 degree tile and month).
- Strict record: after 2021 the conversion cannot be checked against Aqua, because Aqua's orbit drifts.
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
