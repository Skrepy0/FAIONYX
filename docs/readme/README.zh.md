# FAIONYX

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Skrepy0/FAIONYX)

FAIONYX - FLY の Minecraft 启动器。一个基于 Electron 与 Vue 3 的高性能、跨平台
Minecraft 启动器，支持多版本管理、丰富的 Mod 加载器（Forge / Fabric / Quilt /
NeoForge）、整合包、皮肤编辑、社区浏览以及多语言。

## 功能特性

- 多版本与实例管理
- Mod 加载器与整合包支持（Forge / Fabric / Quilt / NeoForge）
- 内置下载引擎与 Java 运行时管理
- 3D 皮肤渲染与皮肤编辑器
- 社区浏览与资源管理
- 多语言系统（zh-CN / en-US）
- 插件系统（支持导入 zip 压缩包、通过 JS 插件加载语言文件）
- 联机功能（Bridge Mod、VoxLink P2P、FRP 隧道）

## 技术栈

- Electron 44 + electron-vite
- Vue 3 + TypeScript
- three / skinview-utils（皮肤渲染）

## 开发

```bash
npm install      # 安装依赖
npm run dev      # 启动开发模式
npm run build    # 构建
npm test         # 运行测试
npm run format   # 代码格式化
```

## 打包

```bash
npm run dist:win        # Windows
npm run dist:mac        # macOS
npm run dist:linux      # Linux
npm run dist:harmonyos  # HarmonyOS
npm run dist:all        # 全平台
```

## 目录结构

| 路径            | 说明                                            |
| :-------------- | :---------------------------------------------- |
| `src/main/`     | Electron 主进程：IPC、游戏启动、Java 探测、下载 |
| `src/renderer/` | Vue 3 UI 应用                                   |
| `src/preload/`  | 安全的 context-bridge 脚本                      |
| `src/shared/`   | 共享类型、IPC 常量、本地化                      |
| `scripts/`      | 构建与打包工具                                  |
| `tests/`        | 测试套件                                        |

## 致谢 / Fork 说明

FAIONYX 是基于 [kamubaba-i/KAMUCL](https://github.com/kamubaba-i/KAMUCL) 的二次开发 fork，由 [Skrepy0](https://github.com/Skrepy0) 修改和维护。感谢 KAMUCL 原作者及所有贡献者。

本仓库的根许可证为 MIT，但该许可仅覆盖 KAMUCL 的原创贡献，以及本 fork 中由 Skrepy0 原创并明确以 MIT 许可发布的部分；第三方代码、协议实现、资源和依赖仍分别适用其原有许可证。本仓库并非全部内容均以 MIT 授权。详见 [LICENSE](../../LICENSE) 与 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。

本 fork 基于 KAMUCL 的 [672745d](https://github.com/kamubaba-i/KAMUCL/commit/672745d009b7b9b942deede9c46123dab109a56a)，与原项目无隶属关系，也不代表原项目认可或背书。

若本 fork 修改了 LGPL/GPL/AGPL 等第三方部分，相关修改仍按对应许可证分发，并在 THIRD_PARTY_NOTICES.md 中注明修改文件和对应源码地址。

## 许可证

见 [LICENSE](../../LICENSE) 与 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
