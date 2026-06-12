# streetview-dl (Node.js)

An open-source **Google Street View** equirectangular 360° panorama downloader.

This is a **Node.js rewrite** of the original PHP [streetview-dl by fdd4s](https://github.com/fdd4s/streetview-dl),
re-built to run **cross-platform** with **no external tools** —
no `aria2`, no `ImageMagick`, no `exiftool`. Everything is done in Node with a single
npm dependency (`sharp`).

## What it does

Given a Google Street View URL or panorama id, it:

1. Downloads every panorama tile in parallel directly from Google.
2. Stitches them into one full-resolution equirectangular image.
3. Produces three JPEGs at decreasing sizes.
4. Writes **GPano XMP metadata** into each output so 360° viewers recognise them as panoramas.

Outputs (in the output directory):

| File           | Description                          |
| -------------- | ------------------------------------ |
| `stl-<id>.jpg` | Full resolution panorama             |
| `stm-<id>.jpg` | 8192 px wide resize                  |
| `sts-<id>.jpg` | 1300 px wide resize                  |

At the default zoom (5) a full panorama is up to 16384×8192 px.

## Requirements

- **[Node.js](https://nodejs.org/) 18 or newer** (uses the built-in `fetch`).
- That's it. `sharp` ships prebuilt binaries for all major platforms.

## Install

```cmd
git clone https://github.com/seitanmen/streetview-dl.git
cd streetview-dl
npm install
```

Optionally install it globally so `streetview-dl` is on your PATH:

```cmd
npm install -g .
```

## Usage

You provide the **panorama id** yourself, via the `--panoid` option:

```cmd
node streetview-dl.js --panoid <PANO_ID>
```

If no panorama id is given — or the id is wrong, expired, or its imagery was
removed — Google serves no tiles and the run ends with:

```
Error: No tiles downloaded. The panorama id may be invalid or unavailable.
```

So always pass a current panorama id (see [How to find a panorama id](#how-to-find-a-panorama-id) below).

### Examples

```cmd
node streetview-dl.js --panoid <PANO_ID>
node streetview-dl.js --panoid <PANO_ID> --zoom 5 --out .\panos
```

You can also pass a full Street View URL as a positional argument and the id is
extracted from it. **Wrap the URL in double quotes** (Street View URLs
contain `!`, `&` and other characters the shell would otherwise interpret):

```cmd
node streetview-dl.js "<Street View URL>"
```

### Options

| Option                  | Description                                              | Default     |
| ----------------------- | ------------------------------------------------------- | ----------- |
| `-p, --panoid <id>`     | Panorama id to download (or pass a URL/id positionally). |            |
| `-z, --zoom <n>`        | Tile zoom level (0–5). Higher = more detail.            | `5`         |
| `-o, --out <dir>`       | Output directory.                                       | current dir |
| `-c, --concurrency <n>` | Parallel tile downloads.                                | `8`         |
| `--keep-tiles`          | Keep the raw downloaded tiles (debug).                  | off         |
| `-h, --help`            | Show help.                                              |             |

```cmd
node streetview-dl.js --panoid <PANO_ID> --zoom 5 --out .\panos --concurrency 12
```

## How to find a panorama id

Open [Google Maps](https://maps.google.com), drag the yellow pegman onto a street to
enter Street View, then copy the URL from your browser's address bar. The URL contains
the panorama id in the `!1s<id>!` segment — copy that id and pass it to `--panoid`.
Panorama ids are not permanent: they change when Street View imagery is updated, so an
old id may return no tiles.

## Troubleshooting

- **"No tiles downloaded. The panorama id may be invalid or unavailable."**
  The panorama id could not be served by Google. The id is wrong, has expired, or
  the imagery was removed/updated — fetch a fresh URL from Google Maps.
- **A lower zoom downloads but the highest zoom fails.**
  Not every panorama is published at every zoom level. Retry with a lower `--zoom`
  (e.g. `--zoom 4` or `--zoom 3`).
- **Downloads are slow or some tiles fail intermittently.**
  Lower `--concurrency` to avoid rate-limiting (e.g. `--concurrency 4`).

## Viewers

- **Desktop:** [Panini](https://github.com/lazarus-pkgs/panini)
- **Android:** [Ricoh Theta App](https://play.google.com/store/apps/details?id=com.theta360)
- **Web (Chrome/Firefox):** [three.js panorama example](https://threejs.org/examples/webgl_panorama_equirectangular.html)

## Differences from the original PHP version

- Pure Node.js — no `aria2`, `ImageMagick` or `exiftool` to install.
- Cross-platform.
- Parallel tile downloading with retries built in.
- 360° metadata is written as standard **GPano XMP** instead of via exiftool.
- Tile grid is derived from the zoom level, so the **full** panorama is fetched
  (the original cropped to a fixed 26×13 tile region).

## Credits

- Original PHP version created by **fdd4s** — <https://github.com/fdd4s/streetview-dl>
- Node.js rewrite maintained in this fork.

All files are public domain — <https://unlicense.org/>
