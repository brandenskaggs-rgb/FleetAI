# Fleet AI Link Website

## Identity and Scope

The approved Link silhouette is the primary Fleet AI mark. Black is used on light
surfaces; a white version is used on dark surfaces. The 3D sequence uses graphite
and silver. Archivo, Source Sans 3, and IBM Plex Mono are served locally.

The public site uses shared `css/public-site.css` and `js/public-site.js`.
Account entry and password pages also use `css/public-access.css`. The home page
adds `css/link-home.css` and `js/link-motion.js`. The employee and customer
applications received logo/favicon changes only, not application rewrites.

There is one canonical home page: `index.html`. Existing URL aliases, form IDs,
authentication scripts, and API contracts are retained. Google verification
metadata is preserved. The public preview is visual-only; it does not log users
in or submit real leads.

## Motion Assets

- Existing highway film: `assets/video/fleetai-highway-hero.mp4`.
- Highway sequence: 60 WebP frames, 960 x 540, under `assets/motion/highway/`.
- Blender sequence: 48 transparent WebP frames, 640 x 640, under `assets/motion/link/`.
- Combined sequences are approximately 2.7 MB, fetched progressively.
- The browser retains bounded decoded caches, not the entire sequence.
- Reduced motion, data-saving mode, short viewports, and disabled JavaScript use
  a readable static story. The video has an explicit play/pause control.
- Native scrolling remains in control. There is no wheel-event interception.

Source tools:

```powershell
python tools/build-link-brand.py
```

The brand exporter requires `fonttools` and Brotli for the existing WOFF2 source.
It generates outlined SVG wordmarks, so exported logos do not require fonts.

```powershell
$env:FLEET_BRAND_RENDER_DIR = 'C:/path/to/brand-render-output'
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --python tools/render-brand-motion.py
```

Run the Blender generator in a fresh background process, not an unrelated open
scene. It constructs its own scene, saves a `.blend` source, and renders PNGs.
Keep source PNGs and the editable scene outside the production asset directory.
Convert source frames to WebP with FFmpeg before publication; preserve the
`frame-001.webp` numbering used by the client. The retained highway film is the
source for the 4 fps road sequence.

Refresh `assets/brand/fleet-ai-brand-assets.zip` after regenerating the four
black/white SVG files. The public brand resources page links to both individual
files and that archive.

## Validation

```powershell
npm.cmd run test:public:browser
npm.cmd run test:tenant-sessions
npm.cmd run launch:check
node --check js/public-site.js
node --check js/link-motion.js
```

Public browser coverage includes 19 pages at 1440, 1024, 390, and 320 pixels;
local link/asset checks; menu behavior; mocked lead submission failures and
successes; invitation activation; actual scroll-stage and canvas-pixel checks;
non-overlapping chapter visibility; reduced-motion and no-script fallbacks.
These tests are not a claim of production form delivery or real-account login.

For a local review:

```powershell
npm.cmd run preview:public
```

The local preview binds to `127.0.0.1:4175`. API requests return a clear preview
unavailable response rather than accessing production services.

## Product Claims

The workspace illustration uses clearly labeled example records. Predictions
are recommendations, not confirmed diagnoses. Synthetic priors are separated
from real operating history. Compliance workflows do not imply ELD certification.
Pricing is $50 per active vehicle per month; existing pilot terms remain explicit
on the pilot and pricing pages. The legal policy text was not substantively
rewritten as part of this visual work.

No database migrations, provider credentials, or Railway configuration changes
are required. Deployment is separate from local implementation and validation.
