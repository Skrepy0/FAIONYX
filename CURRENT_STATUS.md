# CURRENT STATUS — KAMUCL 1.1.19 Windows

香港更新日志：2026-10-07 16:08。Windows x64，Electron 44.3.0。保留用户图片、收藏、设置、历史计数、旧实例及未提交文件。不操作 wuhui、不强推；资源优化暂停，本批没有 Mac 成品。

## Identity

- Project: KAMUCL
- Version or revision: 1.1.19；最终 master 提交由标签和外部 DELIVERY 精确绑定
- Status timestamp: 2026-10-07 16:52 Asia/Hong_Kong

## Last verified state

- Build command: npm run build；electron-builder --win portable --x64 --config.electronDist=node_modules/electron/dist --publish never；node scripts/pack-windows-zip.cjs
- Build result: 成功；516 项生产输入构建前冻结、验收后重算无差异
- Test/validation commands: npm test；npx --no-install tsc --noEmit；npm run license:check；node scripts/verify-windows-package.cjs；专属配置的真实界面专项
- Validation results: 1356 项中 1355 通过、0 失败、1 Linux 专属跳过；四主题及缩放、PNG 解码和 MRPACK 路由通过；独立评分见本版验证目录
- Finished artifact: Windows EXE、紧凑 ZIP、展开 ZIP
- Artifact SHA256: 下表；源码/交接 ZIP 的最终外部哈希见 DELIVERY 和公开 SHA256SUMS.txt

## Last verified artifacts

| 文件                                   |      字节 | SHA256                                                           |
| -------------------------------------- | --------: | ---------------------------------------------------------------- |
| KAMUCL-1.1.19.exe                      |  97323050 | 7b11d4979f1d3afc72397b501770130e3c5e23e2e246deaa70a06276f6a61a65 |
| KAMUCL-1.1.19-windows-x64.zip          |  97355049 | 9cae56424bdc95b309a7aab937c673bd2c407801a17dce339bd516c2cfc3bcc4 |
| KAMUCL-1.1.19-windows-x64-unpacked.zip | 142990165 | 6bc7a4ef2da326e01915559abf77480754722a291dfab233b37cb9e2e5948dde |

## Completed

- 皮肤吸色忽略完全透明外层像素，保留画笔；非零透明度按原字节采样。显式 0% 及旧偏好不强制重置，主题化提示提供恢复不透明按钮。Three 几何、UV、纹理和人物比例未改变。
- MRPACK 清单允许唯一前导 UTF-8 BOM；资源页优先路由 .mrpack/.MRPACK 至统一整包分类。普通 JAR/ZIP 本页流程保持。清单路径按实际 safeJoin 规范目标及 Windows 大小写去重，避免合法哈希文件随后被另一别名覆盖。
- 版本、根锁与分钟更新日志同步；无新增依赖、优化或用户数据迁移。

## Known issues and risks

最终 EXE 7b11d497…61a65。新专项四主题及 125% 界面缩放分别记录真实 HWND/PID、原生 DIP、CSS 小数视口与显示缩放；不冒称请求 960×620 是严格物理像素。Classic/Slim 导出由生产 IPC 写入，实际 PNG 逐像素对照编辑 Canvas。黑橙偏好 0 保存到专属配置后关闭重开、提示恢复再绘制导出通过。

原 proof 记录 PID/版本，未内嵌 EXE SHA；事后保留副本验证将 proof 的父 PID 与原始 child ledger、独立 EXE 出生时间唯一关联。17 份保留 GUI EXE 及运行目录 ASAR 全部与最终成品匹配。事后关联与当时 process.execPath 观察不同，限制明确保留。原始 JSON、PNG、189 张 compositor 帧及时间戳未改写或插帧；采集帧率不作为完整动效性能通过依据。

MRPACK GUI 验证真实拖入和生产分类，顶部选择器返回合成路径；没有实际操作原生选择文件窗口。损坏清单夹带世界、不降级、路径/哈希、备用 URL、中文/空格/§、client-overrides、服务器专用项、安装落盘以及取消/回滚在合成夹具和本地服务中验证。未完整在线安装第三方真实整合包、下载全部 Minecraft/Forge 资源并进入世界；本批无新游戏启动证据，1.1.18 的游戏证据不代替本轮 MRPACK 验收。

全身每个面与视角、所有缩放/输入设备、人工听感、完整动效性能和其他平台未覆盖。EXE 未发行者签名。所属 root 子进程实际 exit/close 已等待；通用 Windows ownedInventory 不可用，不宣称所有后台进程全清零。

## Remaining

当前修复没有未解决阻断。完整真实第三方 MRPACK 在线安装后进入游戏及上述扩展覆盖仍需新证据，本批不推断通过。

## Changed or important files

皮肤：src/shared/skinColors.ts、src/renderer/src/components/SkinEditor.vue。整包：src/main/core/modpacks.ts、src/main/core/importProbe.ts、src/renderer/src/App.vue。回归：tests/skin-outer119.test.ts、tests/mrpack-import-119.test.ts、两份 qa-119 专项与 verify-ui-refinement 入口。版本、包锁、更新日志和 docs/validation-1.1.19 同步。

## Historical failures

1.1.18 原始透明吸色实际复现；修复前别名目标安装成功却覆盖了第一个合法哈希文件，修复后下载和写入前拒绝。未纳入发布的第一候选 0f997385…4a3fb5 与其输入/测试记录保留。

QA 新增严格请求尺寸断言误报 962×623 不等于 960×620；改用已有 <=3 DIP 舍入及 <1 CSS 像素检查，实际数值保留。两轮补充截图操作因前台 HWND 不同停止，透明轮明确为其他 PID 44080，无法事后确定进程名；不猜测归因。未放宽前台检查，专属冷启动完整重跑通过。旧回归日志“PASS 1.1.8”为模块硬编码文字，实际报告版本为 1.1.19。

## Decisions and constraints

源码逐成员核对 Git blob、路径、大小、SHA 和干净解压；交接由未修改的 package-codex-project-handoff 工具制作，记录实际许可验证。源码和交接的提交/哈希由外部 DELIVERY 绑定。保留 main 独立历史差异，通过 cherry-pick 同步；不纳入个人文件或实时运行目录。

按 START_HERE 核对下载 SHA 并使用自己的账号/目录。新增实机与真实第三方服务覆盖需单独补证，不能把未测项目改为通过。

## Recommended next action

先核对公开 SHA256SUMS.txt，再运行 Windows 成品；维护者使用交接包记录的许可命令验证解压副本。交接文档标题在产品构建后补齐工具要求；516 项生产输入仍保持原冻结字节。
