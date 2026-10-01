# Third-party assets

The console uses Pico CSS 2.1.1 (MIT): https://github.com/picocss/pico

Navigation and status icons are from Tabler Icons (MIT): https://github.com/tabler/tabler-icons
Downloaded outline SVGs are retained in public/vendor/tabler and embedded in index.html so the console works without a CDN. The original Tabler MIT license is in public/vendor/tabler/LICENSE.

The console layout is custom vanilla HTML/CSS; no remote fonts, scripts, or image services are required.

## ws

WebSocket runtime dependency: https://github.com/websockets/ws
License: MIT; installed dependency includes its original LICENSE. Version is locked in package-lock.json.

## Separately installed services

SnowLuma and QQ are not bundled. SnowLuma's source-available non-commercial license and EULA remain separate from this bridge's MIT license: https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE and https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md. Users obtain and configure them independently. Codex CLI is also installed independently under its own terms.
