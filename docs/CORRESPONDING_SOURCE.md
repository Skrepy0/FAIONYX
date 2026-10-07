# 对应源码及重新构建

仓库：https://github.com/Skrepy0/FAIONYX
新发行版应附带 FAIONYX-版本-source.zip，对应同名版本标签。
源码包含应用及 LGPL 部分、桥接 MOD、原生辅助程序、视觉资产、脚本、锁文件与许可。

1. 安装 Node.js 22、npm、JDK 17 或更新版本；JAVA_HOME 指向 JDK。
2. 在源码根目录运行 npm ci。
3. node scripts/build-bridge.cjs 从 Fabric Maven 和 Maven Central 获取固定版本
   编译依赖并校验 SHA256。离线可用 FAIONYX_BUILD_LIBS 指向同坐标 Maven 目录。
4. 修改 src/main/core/voxlink 或其他源码，运行 npm run build。
   Windows 原生程序由系统 .NET Framework csc.exe 编译；Mac 不需要它。
5. npm start 启动修改版。Windows 用 npm run dist:win；本批 Windows 使用 Electron 44.3.0。
   Mac 构建使用 package.json 固定的 Electron 版本及 npm run dist:mac，
   与 Windows 共用界面与业务代码。本批仅交付 Windows，不宣称新的 Mac 原生验收。
6. .github/workflows/mac-build.yml 描述原生构建、签名、APP ZIP 与 DMG 验证。
   npm test、npx tsc --noEmit 与 npm run license:check 提供本地检查。
7. scripts/build-offline-skin-agent.cjs 使用 javac --release 8 构建原创
   GPL-3.0-or-later 离线皮肤提供器；npm run build 自动构建并复制该 JAR。
   authlib-injector 由游戏首次使用时从官方来源校验下载，不包含在成品中。

LGPL 部分提供完整源码，可修改并重新编译组合应用，无需 FAIONYX 私有签名密钥。
不禁止为调试修改进行逆向工程。Mac 修改版可自行 ad-hoc codesign。
npm 依赖由锁文件固定，npm ci 需要网络。源码包不包含账户、游戏和下载缓存。
本说明不追溯确认历史版本授权。对应源码交付仍需实际完成并验证。
