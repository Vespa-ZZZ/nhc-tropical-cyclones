# NHC Tropical Cyclones

Retrieve the latest public advisory and current conditions for every active Atlantic, Eastern Pacific, and Central Pacific cyclone in NOAA's National Hurricane Center feed. By default, each storm row includes NHC forecast track points when a track is linked.

Use the Actor to log advisory updates, add weather context to logistics or flight records, or feed a dashboard that links back to NHC. **These outputs are not official warnings.** For warnings and safety decisions, consult the [National Hurricane Center](https://www.nhc.noaa.gov/) and your local authorities.

## Inputs

| Field | Default | Behavior |
| --- | --- | --- |
| `basins` | `["AL", "EP", "CP"]` | Select basins by storm ID prefix (Atlantic, Eastern Pacific, Central Pacific). |
| `includeForecastTrack` | `true` | Fetch NHC's linked forecast ZIP and extract the published forecast points. |
| `minIntensity` | Omitted | Set `"TD"`, `"TS"`, or `"HU"` for a minimum current classification. Subtropical depressions and storms count at the corresponding tropical tier. Major hurricanes count as hurricanes. Potential and post-tropical cyclones are included when the filter is omitted. |
| `onlyNew` | `false` | Emit a storm when the public advisory number, issuance time, or forecast track availability differs from its last saved row. |
| `stateKey` | `"default"` | Use 1–50 letters, digits, underscores, or hyphens to identify a monitoring schedule. |

```json
{
  "basins": ["AL", "CP"],
  "minIntensity": "TS",
  "includeForecastTrack": true,
  "onlyNew": true,
  "stateKey": "operations"
}
```

Keep the same `stateKey` across successive monitoring runs and avoid overlapping runs that use the same key. Overlapping runs can both emit the same advisory before either saves its state. The first run emits all matches. The named key-value store records each advisory after its dataset row is saved, including the last row saved when a pay-per-event limit is reached. Advisories skipped by filters or by the limit remain eligible while they are in the feed.

With forecast tracks enabled, later runs retry a linked ZIP until they can save a row with its track. On the first run after upgrading from a version that tracked only the advisory number and issuance time, previously saved advisories may be emitted once to record track availability.

## Output

One dataset row per matching storm. The example shows the first forecast point from an archived Irma advisory.

```json
{
  "id": "AL112017",
  "binNumber": "AT1",
  "name": "Irma",
  "classification": "HU",
  "basin": "AL",
  "advisoryNumber": "042",
  "issuanceTime": "2017-09-09T15:00:00.000Z",
  "lat": 22.9,
  "lon": -79.9,
  "intensityKt": 125,
  "intensityKmh": 231.5,
  "pressureMb": 941,
  "movementDirDeg": 280,
  "movementSpeedMph": 9,
  "publicAdvisoryUrl": "https://www.nhc.noaa.gov/archive/2017/al11/al112017.public.042.shtml",
  "forecastAdvisoryUrl": "https://www.nhc.noaa.gov/archive/2017/al11/al112017.fstadv.042.shtml",
  "forecastTrackUrl": "https://www.nhc.noaa.gov/gis/forecast/archive/al112017_5day_042.zip",
  "source": "NOAA National Hurricane Center",
  "forecastTrack": [
    {
      "time": "2017-09-10T00:00:00.000Z",
      "lat": 23.4,
      "lon": -80.7,
      "maxWindKt": 115,
      "classification": "MH"
    }
  ]
}
```

The latest forecast track can belong to a different advisory cycle from the public advisory. Track points retain the NHC point classifications and forecast valid times, excluding the initial analysis position. Missing values are `null`. `forecastTrack` is omitted when disabled and is `null` when NHC provides no track. If fetching or parsing a linked ZIP fails, the Actor logs a warning, saves the storm with `forecastTrack: null` and a short `forecastTrackError` message, and continues processing the other storms. The run fails if `CurrentStorms.json` has an unrecognized format.

When NHC reports no active storms, the Actor succeeds with zero rows and `RUN_SUMMARY` set to `{"activeStorms":0,"forecastTrackErrors":0}` in the default key-value store. Otherwise the summary reports the active and matched storm counts, unchanged advisories, saved rows, forecast ZIP failures in `forecastTrackErrors`, and whether the run hit its charge limit.

## Data source and terms

This independent Actor uses U.S. government data produced by NOAA's National Hurricane Center. It selects fields from the current-storms feed and the linked forecast point table, converts wind speed to km/h and times to UTC, and redacts email addresses and phone numbers from text. Requests run sequentially with at least 2.35 seconds between responses and subsequent requests. Transient failures use backoff starting at one minute and honor longer `Retry-After` values. Schedule routine forecast collection around the NHC advisory cycle. [NHC current-storms feed](https://www.nhc.noaa.gov/CurrentStorms.json) · [NHC JSON format reference](https://www.nhc.noaa.gov/productexamples/NHC_Tropical_Cyclone_Status_JSON_File_Reference.pdf)

NHC and NWS describe their government-produced data as public domain unless otherwise noted. This Actor is independently maintained and has no NOAA, NWS, or NHC affiliation or endorsement. [NHC data disclaimer](https://www.nhc.noaa.gov/disclaimer.shtml) · [NWS reuse and appropriate-use guidelines](https://www.weather.gov/disclaimer)

## Local development

Run `npm ci`, `npm test`, and `apify run` from the Actor directory. Tests use local fixtures. The active-storm fixture contains the fields used by this Actor from the Irma and Jose records in the NHC JSON reference. The track fixture contains the unmodified forecast point DBF from the linked Irma archive.

## 日本語概要

米国 NOAA NHC が公表する大西洋・東太平洋・中部太平洋の活動中の熱帯低気圧を、発表番号や発表日時、位置、風速、公式の予報点とともに取得します。`onlyNew` を有効にすると、前回保存した発表番号、発表日時、予報進路の有無に変更があった嵐を出力します。同じ `stateKey` を使う実行は重ならないようにしてください。出力は公式警報ではありません。警報や安全に関する判断には NHC や現地当局の情報を確認してください。
