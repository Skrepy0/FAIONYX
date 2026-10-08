# FAIONYX 启动器自动退出与整合包闪退诊断

诊断日期：2026-09-04

诊断基线：`master` / `d395581`（工作区原有未提交改动未纳入本报告提交）

状态：**仅诊断，等待确认；尚未提交本项修复**

## 1. 结论摘要

### 1.1 “启动游戏后自动退出启动器”

- **已被代码证明：** FAIONYX 在 `spawn()` 返回后立即把状态标记为 `running`，并在开启自动退出时固定等待 1500 ms 后关闭窗口；关闭最后一个窗口会调用 `app.quit()`。这里的 `running` 只表示 Java 子进程创建成功，不表示 Minecraft 已完成认证、资源加载或进入主菜单。
- **已被复现证明：** 纯净版 1.21.11 在自动退出开启时，Java 进程均在启动器退出的同一时间窗口内消失；三次观测存活时间约为 1.26–1.57 秒，尚不足以完成 Minecraft 初始化。
- **已被代码排除：** 自动退出调用链没有调用 FAIONYX 的 `killGame()`，也没有找到递归终止进程树、显式关闭 Windows Job Object、清理游戏目录/原生库或销毁认证会话的代码。
- **高可信推断：** Java 作为 Electron 的直接、未脱离子进程启动，并继承了上层进程的 Windows Job/生命周期约束；启动器及其包装进程结束时，系统级任务/监督器连带终止 Java。测试中 Electron 与 Java 均返回 `IsProcessInJob=true`，且开发版和便携版都复现。现有取证只能证明二者“各自在某个 Job 中”，尚未读取 Job 对象标识，因此“处于同一个带 kill-on-close 的 Job”仍属于高可信推断，而不是已完全证明的事实。
- **不支持的解释：** 当前没有证据表明是临时目录、IPC 管道、认证会话或原生库被提前清理后由 Minecraft 自行退出；实测退出紧贴启动器退出，且没有形成 Minecraft 崩溃报告。

### 1.2 附件中的 Forge 整合包闪退

- **已被日志证明：** 第一条有效异常、根异常和完整根因均为：

  ```text
  java.lang.module.ResolutionException:
  Modules _1._20._1 and minecraft export package net.minecraft.server to module terra_entity
  ```

  该异常没有后续 `Caused by`，调用链从 `java.lang.module.Resolver` 进入 Forge `ModuleLayerHandler.buildLayer`，最终回到 `BootstrapLauncher.main`。

- **已被启动命令证明：** 实际原版客户端 JAR 是 `versions/1.20.1/1.20.1.jar`，但 Forge 的 `-DignoreList` 包含的是自定义实例名 `涟漪之篇·如涟漪之所见.jar`，没有包含真实文件名 `1.20.1.jar`。
- **高可信根因：** 原版客户端 JAR 未被 Forge/SecureJarHandler 的忽略列表排除，被当成自动模块 `_1._20._1`；它与 Forge 构造的 `minecraft` 模块同时导出 `net.minecraft.server`，在解析 `terra_entity` 依赖时发生重复导出冲突。这是**启动参数/模块路径生成错误**，触发条件是“自定义实例 ID 与继承的原版 client JAR 名不一致”，不是该整合包缺少 MOD。
- **已排除：** 日志显示 Java 17.0.20.1、Forge 47.4.16、ModLauncher 10.0.9 已正常启动并枚举 MOD；Java 17 与 Minecraft 1.20.1/Forge 47 的组合合理。当前证据不支持 Java 版本不兼容、认证失败、网络失败、游戏目录缺失、原生库缺失或下载不完整。

### 1.3 当前机器新增复现：Fabric 加载器实例

- **已被 2026-09-04 实机日志证明：** 在关闭自动退出时，本机 `fabric-loader-0.19.5-1.21.10` 进程创建成功后以 code 1 退出。第一条有效异常是 `ExceptionInInitializerError`，根异常为 `IllegalStateException: duplicate ASM classes found on classpath`；冲突文件分别是 ASM 9.10.1 与 ASM 9.6 的 `ClassReader.class`。
- **已被最终命令证明：** 同一 classpath 同时包含 Fabric profile 的 `org.ow2.asm:asm:9.10.1` 和继承原版 1.21.10 的 `org.ow2.asm:asm:9.6`。窗口参数覆盖已按预期生成 `--width 1024 --height 600`，异常发生在 Fabric `LoaderUtil.verifyClasspath`，早于游戏窗口初始化，因此与分辨率功能无因果关系。
- **已被代码证明：** `launch.ts` 的 `resolveChain()` 使用 `chain.flatMap()` 拼接子、父版本全部 libraries；`versions.ts` 的 `collectLibraries()` 只按最终文件路径去重，不按 Maven `group:artifact[:classifier]` 冲突键处理。不同版本号对应不同路径，因此两个 ASM 均进入 classpath。
- **分类：** 这是另一个确定性的**继承链 classpath 合并错误**。它与附件 Forge 包的 module/ignoreList 错误不是同一根因，也不能由修复 Forge 参数顺带宣称解决。

## 2. 证据来源与安全处理

1. 用户提供的 `新建 文本文档.txt`：包含完整 Forge 1.20.1 启动命令与崩溃栈。分析时已将用户名、UUID、access token、用户主目录等视为敏感信息；本报告不复制这些字段。
2. 当前机器的 FAIONYX 源码与构建产物。
3. 当前机器上的纯净版 1.21.11、离线账户与 Java 21 运行时。
4. PowerShell/CIM 的 `Win32_Process` 父 PID、创建时间观测，以及 Win32 `IsProcessInJob` 查询。
5. Electron DevTools Protocol 只读/调用测试辅助脚本 `scripts/cdp-eval.mjs`。脚本不依赖第三方包，也不写入账户数据。

没有把原始完整命令或账户文件加入 Git；报告中的路径统一摘要为 `<USER_DATA>`。

## 3. 基线构建与现有状态

- `npm run build`：成功，约 3.2 秒。
- 构建警告：Vite 提示若干模块同时被静态和动态导入，动态导入不会形成独立 chunk；没有 TypeScript/Vue/Electron 编译错误。
- `package.json` 当前没有 `test` 脚本，也没有已配置的测试框架，因此基线没有可运行的仓库级自动测试命令。这是接管时即存在的测试基础设施缺口。
- 接管时已有未提交文件：`src/main/core/launch.ts`、`src/main/core/versions.ts`、两个安装器日志及 `scripts/harness-cancel.ts`。本报告没有覆盖、回退或暂存这些文件。

## 4. 2×2 复现矩阵

| 客户端                       | 自动退出关闭                                                                                                                                                            | 自动退出开启                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 纯净版 1.21.11               | 1 次：Java 进入资源/OpenAL/纹理加载后的可运行阶段，未生成 crash-report；启动器未主动关闭。该次 Java 约 31.35 秒后消失，现有监听未获得退出码，不能把它记为长期稳定通过。 | 3 次均复现：开发版两次约 1.567 秒、1.257 秒；0.6.5 便携版一次约 1.478 秒。Java 均紧随启动器退出而消失。 |
| 附件中的 Forge 1.20.1 整合包 | 当前机器缺少同一整合包及 MOD 文件，无法做本地连续启动；附件日志足以定位一次确定性模块冲突。                                                                             | 同上；在该参数冲突修复前，即使不触发自动退出也会先在模块层失败，因此不能伪造此格测试结果。              |

矩阵没有全部达到“每格连续多次”：缺少附件所对应的整合包文件/实例目录，且本轮禁止先修改 P0。后续最终验收需要用户提供同一 `.mrpack`/ZIP 或可复制的实例目录；纯净版关闭自动退出也需在修复候选构建上补做至少 3 次进入主菜单并正常退出的人工验证。

## 5. 自动退出的进程与时间线证据

### 5.1 开发构建复现 A

| 事件                      | 值                                                    |
| ------------------------- | ----------------------------------------------------- |
| Electron PID              | 82680                                                 |
| Minecraft Java PID / PPID | 66712 / 82680                                         |
| Java 创建时间             | 17:52:37.705 +08:00                                   |
| Electron 消失             | 17:52:39.270 +08:00                                   |
| Java 消失                 | 17:52:39.272 +08:00                                   |
| Java 可见存活时间         | 约 1.567 秒                                           |
| Java 退出码               | 未取得；父进程先退出，当前实现无法再回传 `close` 事件 |

### 5.2 开发构建复现 B（含 Job 查询）

| 事件                                         | 值                     |
| -------------------------------------------- | ---------------------- |
| Electron PID / `IsProcessInJob`              | 78092 / `true`         |
| Minecraft Java PID / PPID / `IsProcessInJob` | 69912 / 78092 / `true` |
| Java 创建时间                                | 17:55:10.492 +08:00    |
| Electron 消失                                | 17:55:11.691 +08:00    |
| Java 消失                                    | 17:55:11.749 +08:00    |
| Java 可见存活时间                            | 约 1.257 秒            |
| Java 退出码                                  | 未取得                 |

### 5.3 0.6.5 便携构建复现

```text
FAIONYX-0.6.5.exe (PID 83492)
└─ FAIONYX.exe (PID 68908)
   └─ java.exe (PID 77608)
```

- 包装进程、Electron 与 Java 均处于某个 Windows Job 中。
- Java 于 17:57:55.351 创建，于 17:57:56.828 消失，可见存活约 1.478 秒。
- 启动器退出后没有留下 Java 僵尸进程，但这是因为游戏被过早结束，不是正确的生命周期收尾。

### 5.4 代码调用链

```text
renderer launchGame(versionId)
  -> IPC game:launch
  -> launch.launch(...)
  -> child_process.spawn(javaPath, args, { cwd: effectiveGameDir })
  -> 立即 onState({ status: 'running' })
  -> closeAfterLaunch=true 时 setTimeout(...window.close(), 1500)
  -> 最后窗口关闭
  -> app.on('window-all-closed')
  -> app.quit()
  -> Java 在相同时间窗口内消失
```

相关位置（以诊断时工作树行号为准）：

- `src/main/core/launch.ts:404`：以默认非 detached 模式创建 Java 子进程。
- `src/main/core/launch.ts:408`：`spawn()` 后立即发布 `running`。
- `src/main/core/launch.ts:61`：存在手动 `killGame()`，但自动退出链未调用它。
- `src/main/ipc.ts:390-403`：接收 `running` 后固定 1500 ms 关闭窗口。
- `src/main/index.ts:53-55`：所有窗口关闭后调用 `app.quit()`。

源码搜索没有发现 `before-quit`/`will-quit` 中的游戏清理、递归 `taskkill /T`、显式 Job Object 创建/关闭或退出时删除实例临时文件的逻辑。

## 6. 整合包崩溃证据与因果链

### 6.1 脱敏后的关键启动参数

```text
Java: <USER_DATA>/runtimes/jre-17/bin/java.exe
Java version: Eclipse Adoptium 17.0.20.1 amd64
Minecraft: 1.20.1
Forge: 47.4.16
ModLauncher: 10.0.9
client JAR on classpath: <USER_DATA>/versions/1.20.1/1.20.1.jar
custom instance/gameDir: <USER_DATA>/versions/涟漪之篇·如涟漪之所见
-DignoreList: ...,forge-,涟漪之篇·如涟漪之所见.jar
main class: cpw.mods.bootstraplauncher.BootstrapLauncher
```

### 6.2 第一条有效异常、根异常与完整链

```text
java.lang.module.ResolutionException
  Modules _1._20._1 and minecraft export package
  net.minecraft.server to module terra_entity
    at java.lang.module.Resolver.resolveFail
    at java.lang.module.Resolver.failTwoSuppliers
    at java.lang.module.Resolver.checkExportSuppliers
    at java.lang.module.Resolver.finish
    at java.lang.module.Configuration.resolveAndBind
    at cpw.mods.modlauncher.ModuleLayerHandler.buildLayer
    at cpw.mods.modlauncher.TransformationServicesHandler.buildTransformingClassLoader
    at cpw.mods.modlauncher.Launcher.run
    at cpw.mods.modlauncher.Launcher.main
    at cpw.mods.bootstraplauncher.BootstrapLauncher.main
```

此前出现的 JarJar 警告没有终止启动；真正终止流程的是上述 `ResolutionException`。没有 `Caused by`，因此不能再向下杜撰另一层 MOD 异常。

### 6.3 分类判断

| 候选分类            | 判断         | 证据                                                                                     |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| Java 版本不兼容     | 否           | Java 17 已正常进入 Forge 1.20.1 的 ModLauncher。                                         |
| Loader/MOD 依赖缺失 | 不是当前根因 | 日志已完成 MOD/JarJar 发现，根异常为 Java 模块重复导出。                                 |
| 启动参数错误        | **是**       | `-DignoreList` 使用自定义实例 JAR 名，而 classpath 上真实 client JAR 名为 `1.20.1.jar`。 |
| 类路径/模块路径错误 | **是**       | 同一原版代码同时成为 `_1._20._1` 与 `minecraft` 模块的导出来源。                         |
| 原生库错误          | 否           | 没有 native load/link 错误。                                                             |
| 游戏目录错误        | 不是目录本身 | 自定义目录命名间接触发错误的 `${version_name}.jar` 展开。                                |
| 文件下载不完整      | 无证据       | 没有哈希、ZIP、class-not-found 或损坏 JAR 错误。                                         |
| 认证/网络问题       | 否           | 异常发生在本地模块层构建。                                                               |

相关生成路径位于 `src/main/core/launch.ts`：版本 JSON JVM 参数经 `expandEntries(merged.arguments?.jvm)` 展开后直接加入最终参数。Forge 元数据中的 `${version_name}` 被实例显示/目录 ID 替换，但实际 client JAR 来自继承的 1.20.1 版本目录，两者不一致。

### 6.4 Fabric 继承链的独立因果链（新增实机证据）

```text
java.lang.ExceptionInInitializerError
  at net.fabricmc.loader.impl.launch.knot.KnotClient.main
Caused by: java.lang.IllegalStateException:
  duplicate ASM classes found on classpath:
  .../org/ow2/asm/asm/9.10.1/asm-9.10.1.jar!/org/objectweb/asm/ClassReader.class
  .../org/ow2/asm/asm/9.6/asm-9.6.jar!/org/objectweb/asm/ClassReader.class
  at net.fabricmc.loader.impl.util.LoaderUtil.verifyClasspath
  at net.fabricmc.loader.impl.launch.knot.Knot.<clinit>
```

这里的 `ExceptionInInitializerError` 是外层包装，`duplicate ASM classes` 才是根异常。该实例不是用户附件中的整合包，所以它不能补齐附件整合包的 2×2 矩阵；它只证明当前版本继承合并还存在一条可独立复现的 Loader 闪退路径。

## 7. 与纯净版的关键差异

| 项目         | 纯净 1.21.11                     | 附件 Forge 整合包                              |
| ------------ | -------------------------------- | ---------------------------------------------- |
| Java         | Java 21                          | Java 17.0.20.1                                 |
| 入口         | `net.minecraft.client.main.Main` | `cpw.mods.bootstraplauncher.BootstrapLauncher` |
| Loader       | 无                               | Forge 47.4.16 / ModLauncher 10.0.9             |
| JVM 模块参数 | 无 Forge module path/ignoreList  | 有 `-p`、`--add-modules`、`-DignoreList` 等    |
| client JAR   | 实例 ID 与 JAR 名一致            | 自定义实例 ID 与继承 client JAR 名不一致       |
| gameDir      | 当前活动根目录                   | 独立实例目录                                   |
| 失败阶段     | 自动退出时尚在早期初始化         | Forge 构建 module layer 时确定性失败           |

这说明两个现象是两个独立根因：自动退出影响纯净版和整合包的进程生命周期；整合包即使关闭自动退出，也会因 Forge 参数错误而失败。

## 8. 推荐修复方案（尚未实施）

### 8.1 自动退出

1. 把“Java 已创建”与“Minecraft 已可独立运行”拆成两个状态；不能以 `spawn()` 成功作为退出条件。
2. Windows 启动时让游戏进程真正脱离会随启动器关闭的生命周期约束。实现候选应验证 `detached`/独立进程组、stdio 与日志文件句柄的所有权，以及在受 Job 约束环境下是否需要 breakaway/helper 进程；不能用延长固定等待时间代替。
3. 在确认游戏已完成启动握手后再允许自动退出。优先使用日志里稳定的客户端启动里程碑或专用握手；超时只应阻止自动退出并提示，不应杀游戏。
4. 日志输出改为由游戏进程可持续写入的文件句柄/独立日志代理承担，避免 Electron 退出后 stdout/stderr 管道成为隐式依赖。
5. 手动“结束游戏”继续走明确的 `killGame()`；应用退出不应默认杀游戏。正常游戏退出后应回收句柄且不留僵尸进程。

影响范围：`launch.ts` 的 spawn/日志/状态机、`ipc.ts` 的自动退出条件、应用退出生命周期与启动失败日志上下文。主要风险是 macOS/Linux detached 语义差异、日志丢失、手动停止失效及遗留进程。

### 8.2 Forge 自定义实例

在生成最终 Forge JVM 参数时，按实际解析出的 `clientJar` 基名补全/修正 `-DignoreList`，而不是假定 `${version_name}.jar` 就是原版 client JAR。应保留 Forge 元数据原有条目，并去重加入真实文件名；测试覆盖中文/空格实例名、继承版本、多级继承及原名实例。

影响范围主要是 Forge/NeoForge JVM 参数生成。风险是误改非 Forge 参数或重复注入，因此应仅处理已有 `-DignoreList=` 的参数并以精确逗号项匹配。

### 8.3 Fabric/Quilt 继承库冲突

按 Maven 冲突键 `group:artifact[:classifier]` 合并版本链 libraries，并保持“子 profile 覆盖父版本”的顺序；natives 仍需按平台 classifier 独立保留。不能简单按文件名或删除所有旧版本 JAR，因为同 group 下不同 artifact 可以合法共存。修复前后应对实际 Fabric/Quilt profile 快照 classpath，断言 ASM 等覆盖库只保留 Loader 指定版本，并实际启动到客户端初始化阶段。

## 9. 修复后的验收方法

1. 对纯净版和同一整合包分别在自动退出开/关下至少连续启动 3 次。
2. “进入主菜单”必须由人工画面或可审计日志里程碑确认，不能只看 Java PID 存在。
3. 记录每次 Electron/Java PID、PPID、Job 状态、创建/退出时间、Java 退出码和日志末尾。
4. 自动退出后继续观察至少 60 秒：Java 存活、`latest.log` 持续写入、认证和资源加载正常。
5. 正常关闭游戏后确认 Java 退出、日志完整、没有残留 Java/helper/锁文件。
6. Forge 回归需确认启动命令的 `-DignoreList` 含真实 `1.20.1.jar`，并且不再出现 `_1._20._1` 与 `minecraft` 重复导出；随后继续检查是否出现被该错误遮蔽的下一条独立 MOD 问题。

## 10. 仍需的复现材料与确认

- 需要附件对应的整合包包体（`.mrpack`/ZIP）或脱敏后的完整实例目录，才能完成整合包两格的多次实机验证。
- 若用户环境仍能复现自动退出，建议额外提供由 Process Explorer/ETW 记录的 Job 名称与退出事件，以把“同一 kill-on-close Job”从高可信推断升级为事实。
- **在用户明确确认前，不提交自动退出或整合包启动参数修复。** 当前仅提交本诊断文档和无依赖的 CDP 诊断辅助脚本。
