# FAIONYX 对应源码及重新构建说明

仓库：https://github.com/Skrepy0/FAIONYX

每个 FAIONYX 二进制发行版都必须附带或提供与发布版本标签一致的
FAIONYX-<版本>-source.zip。对应源码包含应用源码、LGPL 部分完整源码、
GPL-3.0-or-later 离线皮肤提供器源码、桥接 MOD、原生辅助程序、构建脚本、
锁文件与许可证。第三方代码仍适用其各自许可证，详见 THIRD_PARTY_NOTICES.md。

## 构建步骤

1. 安装 Node.js 22、npm、JDK 17 或更新版本；JAVA_HOME 指向 JDK。
2. 在源码根目录运行 `npm ci`。`npm ci` 需要网络；npm 依赖由锁文件固定。
3. 运行 `node scripts/build-bridge.cjs`。该脚本从 Fabric Maven 和 Maven Central
   获取固定版本编译依赖并校验 SHA256。离线构建可将 `FAIONYX_BUILD_LIBS`
   指向包含相同坐标的本地 Maven 目录。
4. 修改 `src/main/core/voxlink` 或其他源码后，运行 `npm run build`。
   Windows 原生程序由系统 `.NET Framework csc.exe` 编译；Mac 构建不需要它。
5. `npm start` 启动修改版。Windows 构建使用 `npm run dist:win`；当前 Windows
   发行使用 Electron 44.3.0（以 `package.json` 为准）。Mac 构建使用
   `npm run dist:mac`，并与 Windows 共用界面和业务代码。当前版本仅验证/交付
   Windows 构建，不宣称新的 Mac 原生验收结果。
6. `.github/workflows/mac-build.yml` 描述 Mac 原生构建、签名、APP ZIP 与 DMG
   验证。`npm test`、`npx tsc --noEmit` 和 `npm run license:check` 可用于本地检查。
7. `scripts/build-offline-skin-agent.cjs` 使用 `javac --release 8` 构建原创
   GPL-3.0-or-later 离线皮肤提供器；`npm run build` 会自动构建并复制该 JAR。
   authlib-injector 在游戏首次使用时从官方来源校验下载，不包含在成品中。

## 许可证与重新组合

对于 LGPL-3.0-only 部分，FAIONYX 提供完整对应源码，用户可以修改、重新编译
并重新组合到应用中；重新编译和组合不需要 FAIONYX 私有签名密钥。若发行版对
LGPL 部分设置签名或完整性校验，必须提供替换修改后版本的可行方式。FAIONYX
不禁止为调试此类修改而进行逆向工程。Mac 修改版可自行进行 ad-hoc codesign。

源码包不包含账户、游戏和下载缓存。本说明不追溯确认历史版本授权。发布二进制
前，必须实际完成并验证对应源码交付；若对应源码不可构建或未附带，不应发布该二进制。