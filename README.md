# Fire Pulse

A harmonized MODIS + VIIRS burning calendar for anywhere on Earth, 2001 to 2025.

Prototype for the 2026 NASA Space Apps Challenge,
[Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/).

## The problem

Satellites have logged active-fire hot spots since 2000, but the record is split across two sensors:

- **MODIS** (Terra and Aqua, 1 km pixels) is the long series and is close to retirement.
- **VIIRS** (Suomi NPP, 375 m pixels) took over in 2012 and detects many small fires MODIS misses.

Put side by side, the raw global counts jump **3.63×** across 2012 for no physical reason. A fire manager
cannot answer "is this month worse than normal here?" with a record like that.

## What the app does

Pick a country (click the globe or search), type a latitude/longitude box, or draw a box on the globe. You get:

- **A burning calendar**: hot spots per month, every year since 2001, in one comparable unit.
- **A verdict for the selected month**: how it compares with the historical median for that month, and its rank.
- **The seasonal curve**: the selected year against the typical year and the middle half of years.
- **Anomaly view**: the globe and the calendar coloured by how unusual each month is, on a colour-blind-safe ramp.
- **A sensor check**: converted MODIS against observed VIIRS for the years both flew, for the area you picked.
- **Harmonized / Raw switch**: see the false 2012 jump, then remove it.
- **Downloads**: the monthly table as CSV for a chosen range of years, and the calendar as a PNG.
- **A time slider and Play button** to watch 25 years of fire seasons move across the globe.

## Run it

It is a static site. No build step, no dependencies to install.

```bash
python3 -m http.server 8765 -d docs
```

Then open <http://localhost:8765>. The folder is named `docs/` so GitHub Pages can serve it as is
(Settings → Pages → Deploy from branch → `main` / `docs`).

## The method

1. **Same fires only.** Keep detections typed as presumed vegetation fire (drops gas flares, volcanoes and
   offshore sources). Drop MODIS confidence below 30 % and VIIRS "low" confidence.
2. **Same grid.** Count hot spots per month in 0.5° cells (about 55 km), kept separate per country.
3. **Learn the exchange rate.** For the months both sensors observed (Feb 2012 to Dec 2025), compute for every
   cell how many VIIRS hot spots correspond to one MODIS hot spot:

   `k = (ΣVIIRS + λ · k_parent) / (ΣMODIS + λ)`

   The pseudo-count λ shrinks cells with little data toward their country's rate, and countries toward the
   global rate (4.1×). λ = 30 was picked by hold-out error.
4. **Convert the past.** Multiply the MODIS-only years by the local rate. Before July 2002 only Terra was
   flying, so those months use a separate Terra-only rate (12.5× globally).
5. **From Feb 2012 on, use VIIRS as observed.** Every month is now in VIIRS-equivalent hot spots.

## Does it work?

**The false jump is gone and the real trend is kept.** Mean of 2013–2025 over mean of 2003–2011, global:

| Series | Step across 2012 |
|---|---|
| Raw (MODIS, then VIIRS) | 3.63× |
| Harmonized | 0.89× |
| MODIS alone (flew the whole time) | 0.88× |

**Blind test.** Rates fitted on even years only, used to predict VIIRS in the odd years. Median absolute error:

| Conversion | Country, per year | Country, per month | Cell, per year |
|---|---|---|---|
| None (raw MODIS) | 78.0 % | 79.3 % | 76.2 % |
| One global rate | 21.8 % | 29.4 % | 30.6 % |
| One rate per country | 8.8 % | 23.3 % | 27.6 % |
| **One rate per cell (used)** | **8.6 %** | **20.9 %** | **20.5 %** |

These numbers are written to `docs/data/meta.json` on every build and shown in the app under "How it works".

## Data

[NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) yearly country archives:

- MODIS Collection 6.1 (MCD14ML), 2001–2025
- VIIRS S-NPP 375 m (VNP14IMGT), 2012–2025

392,307,568 detections read, 333,658,132 kept after the filters, 58,235 grid units in 234 countries and
territories. The app loads one 9.7 MB file, `docs/data/firepulse.bin.gz`.

## Rebuild the data

Python 3.9+ standard library only.

```bash
python3 scripts/build_data.py --selftest   # checks the harmonization maths on synthetic data
python3 scripts/build_data.py              # downloads ~6.6 GB of zips into data/raw, then builds
```

Use `--raw /some/big/disk` to keep the zips elsewhere. The build takes about two minutes on a laptop once the
files are downloaded.

## Layout

```
docs/                 the web app (static)
  index.html, style.css, app.js
  data/firepulse.bin.gz   harmonized monthly grid, built by the script
  data/meta.json          build statistics and validation results
  vendor/                 d3, topojson-client, world-atlas country shapes
scripts/build_data.py   download → aggregate → harmonize → validate → pack
```

## Limits, and what comes next

- A hot spot is a satellite pixel with a thermal anomaly, not one fire. A large fire is many hot spots.
- One fixed rate per cell cannot follow changes in fire size or season. A season- or size-dependent model is
  the next step. Single cells with few hot spots are rough.
- Fires MODIS never saw cannot be recovered by multiplying, so places with only small burns are under-counted
  before 2012.
- The Terra-only months (2001 to June 2002) carry the most uncertainty.
- Sensor outages show up as dips (for example VIIRS in late July and August 2022). Filling them from the other
  sensor is a natural extension.
- The record ends in December 2025, the last complete yearly archive. Adding the current year needs the FIRMS
  near-real-time API and a free MAP_KEY.
- The CSV download is the monthly table. Single detections for an area are available from the
  [FIRMS archive download](https://firms.modaps.eosdis.nasa.gov/download/).
- Areas are countries or latitude/longitude boxes on the 0.5° grid. States and custom polygons are not in yet.

## Use of AI

The code in this repository (data pipeline and web app) and this README were generated with Claude
(Anthropic) under the direction of the team, then run and tested against the real FIRMS data. No images,
video or audio were generated with AI.

## Credits

Fire data: NASA FIRMS (LANCE / EOSDIS). Country shapes: Natural Earth via world-atlas. Charts and globe: D3.
NASA does not endorse this project. No NASA logos or insignia are used.
