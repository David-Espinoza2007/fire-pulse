# Visual assets and licences

Every third-party file, font and data set the page shows, checked on 14 November 2026. Licences
were read from the npm registry (libraries), the google/fonts repository (`ofl/*/METADATA.pb`) and
naturalearthdata.com/about/terms-of-use (map data).

| Asset | Where it is | Source | Licence | Commercial use | Attribution | Status |
|---|---|---|---|---|---|---|
| D3 7.9.0 | `static/vendor/d3.min.js` | github.com/d3/d3 | ISC | Yes | Keep the copyright line at the top of the file | OK |
| topojson-client 3.1.0 | `static/vendor/topojson-client.min.js` | github.com/topojson/topojson-client | ISC | Yes | Keep the copyright line | OK |
| Country shapes (110m, 50m) | `static/vendor/countries-*.json` | world-atlas 2.0.2, built from Natural Earth | ISC (package); data public domain | Yes | Credit Natural Earth (courtesy, not required) | OK |
| States, provinces, place names | `data/reference/*.parquet` | Natural Earth | Public domain | Yes | Courtesy credit | OK |
| Earth texture (Realistic globe) | `static/textures/earth-ne2-4096.jpg` | Natural Earth II with shaded relief and water, 1:50m (`NE2_50M_SR_W`), resized to 4096 x 2048 | Public domain | Yes | Courtesy credit | OK |
| Source Serif 4, Source Sans 3 (the page) | Google Fonts CDN | google/fonts | SIL OFL 1.1 | Yes | None in the page | OK as a licence. Loading from Google's servers sends visitors' IP addresses to Google; self-host the files before launch |
| IBM Plex Sans, IBM Plex Mono, Public Sans (design review page only) | Google Fonts CDN | google/fonts | SIL OFL 1.1 | Yes | None in the page | OK; same self-hosting note |
| Viridis colours (confidence map) | `static/app.js` | matplotlib colormaps | CC0 | Yes | None | OK |
| Brand mark and favicon | `static/index.html` | Drawn for this project (inline SVG): globe lines and one hot point | Ours | Yes | – | OK. Replaced the emoji favicon, whose drawing came from each visitor's system emoji font |
| Fire data | API and `data/` | NASA FIRMS: MODIS C6.1, VIIRS 375 m | NASA open data; no copyright in the US | Yes | FIRMS asks for an acknowledgement sentence (already in the README) | OK as data credit |

## Rules we follow

- No NASA logos, insignia, seals or mission patches anywhere, and no wording that suggests NASA
  owns, sponsors or endorses Fire Pulse. NASA, FIRMS, MODIS and VIIRS appear only as data sources.
- No third-party icon sets: the few icons the page needs (brand mark, play, pause, menu chevrons) are drawn by us as inline SVG or CSS.
- New assets go in this table before they go in the page. If a licence cannot be confirmed, the
  asset is not used.

## Not yet done

- Self-host Source Serif 4 and Source Sans 3 (OFL allows it) instead of loading them from Google.
