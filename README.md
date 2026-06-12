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

```cmd
node streetview-dl.js "<url or panoid>"
```

**Wrap the URL in double quotes** (Street View URLs contain `!`, `&` and
other characters the shell would otherwise interpret).

### Examples

```cmd
node streetview-dl.js "https://www.google.com/maps/@41.3881837,2.1698939,3a,75y,143.45h,92.72t/data=!3m6!1e1!3m4!1sr3vUp9U2ss5fwoq1Roxizw!2e0!7i16384!8i8192"
```

Or pass the raw panorama id:

```cmd
node streetview-dl.js r3vUp9U2ss5fwoq1Roxizw
```

### Options

| Option                  | Description                                  | Default     |
| ----------------------- | -------------------------------------------- | ----------- |
| `-z, --zoom <n>`        | Tile zoom level (0–5). Higher = more detail. | `5`         |
| `-o, --out <dir>`       | Output directory.                            | current dir |
| `-c, --concurrency <n>` | Parallel tile downloads.                     | `8`         |
| `--keep-tiles`          | Keep the raw downloaded tiles (debug).       | off         |
| `-h, --help`            | Show help.                                   |             |

```cmd
node streetview-dl.js r3vUp9U2ss5fwoq1Roxizw --zoom 5 --out .\panos --concurrency 12
```

## How to find a panorama URL

Open [Google Maps](https://maps.google.com), drag the yellow pegman onto a street to
enter Street View, then copy the URL from your browser's address bar.

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
