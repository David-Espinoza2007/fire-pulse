# Demo draft: 7 slides (or a 30-second video)

Numbers come from `data/world/serve/validation.json` (world run, 235 countries, 14 November 2026). Update them after any new pipeline run.

## Slide 1 - Title

**Fire Pulse: one fire record from MODIS to VIIRS**

NASA Space Apps 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots". Team name and members.

*Picture:* the globe view with fire cells.

## Slide 2 - The problem

**The satellites changed. The fires did not.**

- MODIS has watched fires since 2000 with 1 km pixels. VIIRS has 375 m pixels and sees many small fires that MODIS misses.
- If you add the two records, fire activity seems to jump when VIIRS starts. The yearly world count goes from 4.4 million hot spots in 2011 to 21.9 million in 2012.
- The change is happening now: Suomi NPP stopped delivering data to FIRMS on 2 November 2026, and MODIS ends in 2027.

*Picture:* "Hotspots per year" in **Raw** mode, with the jump.

## Slide 3 - Our idea

**Ask of every MODIS detection: what would VIIRS have reported?**

- One common unit: the VIIRS-equivalent detection. VIIRS is the reference because it carries the record on: the present is measured, only the closed MODIS past is an estimate.
- An exchange rate learned from the years when both sensors flew (2012 to 2021). It depends on region, month, and day or night. One global factor is wrong, because the share of small fires differs between regions.
- Aqua MODIS is converted for 2002 to 2011, Terra for 2000 to 2002. Days when Aqua did not record are found from the data and filled.

*Picture:* "Hotspots per year" in **Harmonized** mode, same area as slide 2.

## Slide 4 - The proof

**Tested on years the method never saw.**

Error against real VIIRS (Suomi NPP), per 5 degree tile and month, whole world, each year of 2012 to 2021 hidden in turn:

| Method | Error |
|---|---|
| Raw Aqua counts | 84 % |
| One global factor | 28 % |
| Conversion tables by fire strength | 20 % |
| Our ratio per region, month, day and night | 16 % |

- Learned only from 2017 to 2021 and tested on 2012 to 2016, the way the record reaches back: 16 % again.
- The jump when VIIRS starts: 6.1 times in raw counts, 0.90 after harmonizing, 0.89 for Aqua alone, which flew through both.
- The "compared with normal" class is the same or the next class in 76 % of tested months.
- Two identical VIIRS instruments differ by 7 % per tile and month and by 0.1 % in total, so NOAA-20 continues the record of Suomi NPP.
- The trust map shows where the conversion is reliable and where it is not.

*Picture:* the trust map and the "Can you trust it?" panel.

## Slide 5 - The app

**From the globe to a flat map of your area in one click.**

- Select a country, draw a box or a polygon, or type coordinates.
- Burning activity calendar from 2000 to today, as a grid or as fire rings. Colorblind-safe colors, with every month compared with its historical median.
- One-line status: "3rd most active April since 2001", and the most similar past years.
- Live: the last 7 days from FIRMS, converted with the same tables and compared with a normal week.
- Download the calendar and the original hotspots as CSV.

*Picture:* the calendar for one area, with the status line.

## Slide 6 - What it cannot do

**Honest limits.**

- No correction for cloud cover: a cloudy month looks quiet.
- The years before 2012 are estimates: small fires that MODIS never saw are added as a regional average, not one by one.
- The night part of those years is the least certain (39 % error).
- The months before August 2002 come from Terra and are less certain.

## Slide 7 - Why it matters

**A fire history that survives the end of MODIS.**

- Fire managers, responders and scientists get one consistent 25-year record for any area, instead of two records that cannot be compared.
- The record does not depend on MODIS any more: every new VIIRS month is measured, not converted. Any new satellite can join through an overlap period.
- Next steps: near-real-time months, Sentinel-3 for the morning pass, cloud flags.
- Open code. Data: NASA FIRMS.

---

## 30-second video script (alternative to slides)

1. (0-6 s) Raw mode, hotspots per year. "Satellite fire counts jump when a new sensor arrives. The fires did not change. The satellite did."
2. (6-12 s) Click **Harmonized**. The jump disappears. "Fire Pulse converts every MODIS detection into what VIIRS would have reported."
3. (12-20 s) Spin the globe, select a country, show the calendar and the status line. "One consistent record from 2000 to today, for any area."
4. (20-27 s) Open the trust map and the proof table. "Tested on years it never saw: 16 % error, against 84 % for raw counts."
5. (27-30 s) Title card: "Fire Pulse. Built on NASA FIRMS data."
