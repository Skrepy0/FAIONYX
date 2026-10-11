# FAIONYX

[🌐|中文](./docs/readme/README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Skrepy0/FAIONYX)

FAIONYX - FLY's Minecraft launcher. A high-performance, cross-platform Minecraft launcher built on Electron and Vue 3, supporting multi-version management, a rich set of mod loaders (Forge / Fabric / Quilt / NeoForge), modpacks, skin editing, community browsing, and multiple languages.

## Features

- Multi-version and instance management
- Mod loader and modpack support (Forge / Fabric / Quilt / NeoForge)
- Built-in download engine and Java runtime management
- 3D skin rendering and skin editor
- Community browsing and resource management
- Multi-language system (zh-CN / en-US)
- Plugin system (supports importing zip archives, loading language files via JS plugins)
- Multiplayer features (Bridge Mod, VoxLink P2P, FRP tunneling)

## Tech Stack

- Electron 44 + electron-vite
- Vue 3 + TypeScript
- three / skinview-utils (skin rendering)

## Development

```bash
npm install      # Install dependencies
npm run dev      # Start development mode
npm run build    # Build
npm test         # Run tests
npm run format   # Format code
```

## Packaging

```bash
npm run dist:win        # Windows
npm run dist:mac        # macOS
npm run dist:linux      # Linux
npm run dist:harmonyos  # HarmonyOS
npm run dist:all        # All platforms
```

## Directory Structure

| Path            | Description                                                       |
| :-------------- | :---------------------------------------------------------------- |
| `src/main/`     | Electron main process: IPC, game launch, Java detection, download |
| `src/renderer/` | Vue 3 UI application                                              |
| `src/preload/`  | Secure context-bridge scripts                                     |
| `src/shared/`   | Shared types, IPC constants, localization                         |
| `scripts/`      | Build and packaging tools                                         |
| `tests/`        | Test suites                                                       |

## Acknowledgements / Fork Notice

FAIONYX is a derivative fork based on [kamubaba-i/KAMUCL](https://github.com/kamubaba-i/KAMUCL), modified and maintained by [Skrepy0](https://github.com/Skrepy0). Thanks to the original KAMUCL author and all contributors.

The root license of this repository is MIT, but that license only covers KAMUCL's original contributions and the parts of this fork that are originally authored by Skrepy0 and explicitly released under the MIT license; third-party code, protocol implementations, resources, and dependencies remain subject to their respective original licenses. Not all content in this repository is licensed under MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for details.

This fork is based on KAMUCL's [672745d](https://github.com/kamubaba-i/KAMUCL/commit/672745d009b7b9b942deede9c46123dab109a56a). It is not affiliated with the original project, nor does it imply endorsement by the original project.

If this fork modifies LGPL/GPL/AGPL or other third-party parts, those modifications are still distributed under the corresponding licenses, with the modified files and their corresponding source URLs noted in THIRD_PARTY_NOTICES.md.

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
