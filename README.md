# Fire Pulse

Where it burns, and whether that is normal. One consistent record of satellite fire detections from
2000 to today, for any country, state or drawn area, built for a fire manager. Made for the NASA
Space Apps 2026 challenge "Harmonization of MODIS and VIIRS Hot Spots".

This branch (`viirs-reference`) builds on `fire-manager-app` (Python API, 0.05 degree grid, day and
night, outage filling, map tiles, tests) and turns the conversion around: **VIIRS is the reference
and the MODIS past is converted up to it**, instead of converting VIIRS down to Aqua MODIS. See
"Why VIIRS is the reference" below.

## Quick start (uses the Mexico data included in the repository)

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn app:app --port 8000
```

Open http://localhost:8000. Without world data the app reads `data/mx` (Mexico only), so the
globe glows only over Mexico. The "last 7 days" layer downloads one public FIRMS file (35 MB) on
first use. Run the tests with `.venv/Scripts/python -m pytest -q` (25 tests).

Add `?perf=1` to the address to see frame times on the map.

## The problem

MODIS (1 km pixels, since 2000) and VIIRS (375 m pixels, since 2012) both detect fires, but VIIRS
sees many small fires that MODIS misses. If you add the two records, fire activity seems to jump
when VIIRS starts: the yearly world count goes from 4.4 million in 2011 to 21.9 million in 2012.
The jump is the new sensor, not more fire.

## The method

The unit is the **adjusted fire detection**: the number of detections a VIIRS instrument (375 m)
would have reported.

1. **Clean.** Keep vegetation fires only (`type = 0`), drop the low-confidence class of each sensor.
2. **Grid.** One row per 0.05 degree cell, local solar date, day or night, and satellite.
3. **Exchange rate.** For the years when Aqua MODIS and Suomi NPP VIIRS both flew with a stable
   orbit (February 2012 to 2021, with the days Aqua did not record left out): VIIRS detections
   divided by Aqua detections, per 20 degree region, calendar month, and day or night. This is where
   the small fires that MODIS misses come in, and they differ by region and season.
4. **No hard cuts.** A region with little data is blended with the world value for that month and
   then with the world value: its own rate gets the weight `n / (n + 100)`, n being its Aqua detections. (`fire-manager-app` switched tables at a
   fixed 300 samples.)
5. **Series.** Converted Terra before August 2002, converted Aqua until January 2012, then VIIRS as
   measured: Suomi NPP from February 2012, NOAA-20 from May 2018. Days when Aqua did not record are
   found from the data and filled from Terra.
6. **Also carried:** the night part of the count, and fire radiative power (less certain).
7. **This week.** The public FIRMS file with the last 7 days of NOAA-20 detections. NOAA-20 is a
   VIIRS instrument, so nothing is converted. Permanent heat sources are left out: cells the archive
   labels as industrial, volcanic or offshore, and cells that burn in at least 10 months of a year on
   at least 30 days with at least 40 % of detections at night (gas flares, smelters).
8. **Proof.** Each overlap year is hidden in turn, the rates are learned from the other years, and
   the converted Aqua is compared with real VIIRS.

### Why VIIRS is the reference

- **The estimated part is closed.** MODIS ends; VIIRS goes on (NOAA-20, NOAA-21). With VIIRS as the
  unit, everything from 2012 on is measured and only 2000 to 2011 is an estimate that never grows.
  With Aqua as the unit, every new month is an estimate, and since 2022 it cannot be checked.
- **"Is this month normal?" compares one month with a median of many years.** An error in the
  baseline years averages out over 18 years. An error in the current month does not. So the current
  month should be the measured one.
- **Small fires stay in the record** for the years VIIRS saw them.

The price: converting up is harder than converting down, because the small fires MODIS never saw
have to be added as an average for a region and month. The error on hidden years is 16 % here,
against 12 % for VIIRS to Aqua in `fire-manager-app`. That error sits in the past, not in the present.

### Results on hidden years

Whole world, Aqua converted to Suomi NPP, 2012 to 2021, error per 5 degree tile and month
(`sum |estimate - measured| / sum measured`):

| Method | Each year hidden in turn | Learn 2017-2021, test 2012-2016 |
|---|---|---|
| Raw Aqua counts | 84 % | 84 % |
| One global factor | 28 % | 29 % |
| Monthly ratio per region | 17 % | 18 % |
| **Monthly ratio per region, day and night apart (used)** | **16 %** | **16 %** |
| Conversion tables by fire strength (the `fire-manager-app` method, turned around) | 20 % | 20 % |

Every build fits and tests all of these; `harmonize.METHOD` picks the one the record uses. The
conversion tables win for VIIRS to Aqua but lose for Aqua to VIIRS. A likely reason: most VIIRS
detections have no Aqua detection in the same cell and day, so the strength of the Aqua fire says
little about them.

- **Total:** the converted world total is off by 0.3 % (ratio 1.003). Day part 14 %, night part 39 %:
  Aqua saw few fires at night, so the night part of the years before 2012 is the least certain.
- **The jump is gone and the real trend is kept.** Mean of 2013-2021 over mean of 2003-2011, world:
  raw counts 6.09, harmonized 0.90, Aqua alone (flew through both) 0.89.
- **Terra to VIIRS** (months before August 2002): 26 %.
- **Passing the record on:** Suomi NPP and NOAA-20, two identical instruments, differ by 7 % per
  tile and month and by 0.1 % in total (May 2018 to 2025), so NOAA-20 continues the same unit.
- **"Compared with normal":** the converted Aqua lands in the same class as real VIIRS in 38 % of
  tested tile-months and in the same or the next class in 76 %.

These numbers are for the world build (`data/world`, not in the repository). The Mexico tables in
the repository give 16 % (each year hidden) and 17 % (2012-2016 from 2017-2021); see
`data/mx/serve/validation.json`.

## Build the data yourself

```bash
.venv/Scripts/python pipeline.py --root data/mx --countries Mexico                       # under a minute
.venv/Scripts/python pipeline.py --root data/world                                        # every country
.venv/Scripts/python reference.py                                                         # states and place names
```

The pipeline downloads the yearly country archives from NASA FIRMS into `data/zips` (about 10 GB
for all three sensors; each file holds all countries, so the Mexico build downloads them too). On a
16 GB laptop the world build takes roughly 15 minutes once the archives are downloaded and
needs about 10 GB of free disk. If it runs out of memory, set `FIRE_MEM=10GB`. When `data/world` exists the app uses it instead of `data/mx`. `FIRE_DATA=<folder>`
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

- `harmonize.py` - the method, as DuckDB SQL: grid, ratios per region with blending, conversion tables.
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
- The years before 2012 are estimates. Small fires that MODIS never saw are added as the average
  for a 20 degree region and calendar month, not one by one. A small area with unusual fires can be
  off, and the range shown with each value is wide for small counts.
- The night part before 2012 is the least certain (39 % error per tile and month).
- The rates are learned on 2012 to 2021 and applied back to 2000. If the share of small fires in a
  region changed before 2012, the method does not see it. The closest test the data allows
  (learn 2017-2021, test 2012-2016) gives 16 %.
- The blending weight (100) was not tuned on the world record. The edges between 20 degree regions
  are not smoothed.
- VIIRS outages are not filled (Suomi NPP before May 2018, NOAA-20 after).
- Values before August 2002 come from Terra, which passes in the morning. They are less certain
  (26 % error), and Terra outages in 2001 and 2002 make some of those months too low.
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
