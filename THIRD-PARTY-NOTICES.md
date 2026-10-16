# Third-party assets

The console uses Pico CSS 2.1.1 (MIT): https://github.com/picocss/pico

Navigation and status icons are from Tabler Icons (MIT): https://github.com/tabler/tabler-icons
Downloaded outline SVGs are retained in public/vendor/tabler and embedded in index.html so the console works without a CDN. The original Tabler MIT license is in public/vendor/tabler/LICENSE.

The console layout is custom vanilla HTML/CSS; no remote fonts, scripts, or image services are required.

## Uiverse Galaxy

Console controls adapt MIT-licensed elements from https://github.com/uiverse-io/galaxy:

- Gradient save/preset buttons: adamgiebl, `Buttons/adamgiebl_fluffy-liger-17.html`.
- Sliding switches: AbanoubMagdy1, `Toggle-switches/AbanoubMagdy1_pink-panda-32.html`.
- Dark card surface and icon treatment: 0senno, `Cards/0senno_warm-cheetah-38.html`.

Colors, dimensions and interaction states are adapted to EchoMate. Continuous decorative animation is removed; native checkboxes remain accessible and reduced-motion preferences are respected. No remote assets, scripts, Tailwind dependency or social links from the demos are loaded. The original Galaxy MIT license is retained at `public/vendor/galaxy/LICENSE`; author credit is retained in this document.

## ws

WebSocket runtime dependency: https://github.com/websockets/ws
License: MIT; installed dependency includes its original LICENSE. Version is locked in package-lock.json.

## Separately installed services

SnowLuma and QQ are not bundled. SnowLuma's source-available non-commercial license and EULA remain separate from this bridge's MIT license: https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE and https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md. Users obtain and configure them independently. Codex CLI is also installed independently under its own terms.

## EchoMate brand mark

The mint robot mark in public/brand-mark.svg and its inline copy in the console are original project artwork, distributed under the project MIT license.
