#!/usr/bin/env node
// 一次性：补齐设置导航/搜索目录词条。已存在的键不覆盖。
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'src', 'shared', 'i18n', 'locales');

const ADD = {
  'settings.scope.launcher': ['启动器设置', 'Launcher Settings'],
  'settings.scope.game': ['游戏设置', 'Game Settings'],
  'settings.category.appearance': ['外观', 'Appearance'],
  'settings.category.general': ['行为与登录', 'Behavior & Sign-in'],
  'settings.category.downloads': ['下载', 'Downloads'],
  'settings.category.features': ['功能与插件', 'Features & Plugins'],
  'settings.category.about': ['关于与更新', 'About & Updates'],
  'settings.category.game': ['运行环境', 'Runtime'],
  'settings.category.display': ['游戏窗口', 'Game Window'],
  'settings.category.directories': ['目录与隔离', 'Directories & Isolation'],

  'settings.catalog.theme.name': ['主题与个性化', 'Theme & Personalization'],
  'settings.catalog.theme.keywords': [
    '颜色 黑紫 深色 浅色 透明 自定义 字体 外观工作台',
    'color dark light transparent custom font appearance workbench',
  ],
  'settings.catalog.background.name': ['窗口背景', 'Window Background'],
  'settings.catalog.background.keywords': ['壁纸 图片 玻璃 模糊 透明度', 'wallpaper image glass blur opacity'],
  'settings.catalog.thumbnail.name': ['首页启动卡图片', 'Home Launch Card Images'],
  'settings.catalog.thumbnail.keywords': ['轮播 插画 缩略图 背景 停留时间', 'carousel artwork thumbnail background duration'],
  'settings.catalog.motion.name': ['减少动态效果', 'Reduce Motion'],
  'settings.catalog.motion.keywords': ['动画 动效 系统偏好 晕动 静止', 'animation motion system preference motion sickness static'],
  'settings.catalog.ui-window-fit.name': ['UI 窗口自适应', 'Adaptive UI Window'],
  'settings.catalog.ui-window-fit.keywords': [
    '窗口 自适应 分辨率 缩放 小屏幕 1366 768 DPI 多屏',
    'window adaptive resolution scale small screen 1366 768 DPI multi-monitor',
  ],
  'settings.catalog.isolation.name': ['新版本默认隔离', 'Isolate New Versions by Default'],
  'settings.catalog.isolation.keywords': ['存档 模组 配置 独立 共享目录', 'saves mods config isolated shared directory'],
  'settings.catalog.memory.name': ['内存分配', 'Memory Allocation'],
  'settings.catalog.memory.keywords': ['RAM 自动分配 GB 性能', 'RAM auto allocate GB performance'],
  'settings.catalog.java.name': ['Java 运行时', 'Java Runtime'],
  'settings.catalog.java.keywords': ['JDK JVM 路径 自动下载 检测 扫描 手动添加', 'JDK JVM path auto download detect scan add manually'],
  'settings.catalog.resolution.name': ['游戏窗口分辨率', 'Game Window Resolution'],
  'settings.catalog.resolution.keywords': [
    '宽 高 最大化 全屏 窗口化 退出游戏 自动保存 窗口大小 记住',
    'width height maximize fullscreen windowed quit save window size remember',
  ],
  'settings.catalog.jvm.name': ['JVM 参数', 'JVM Arguments'],
  'settings.catalog.jvm.keywords': ['高级 垃圾回收 GC G1GC 启动参数', 'advanced garbage collection GC G1GC launch arguments'],
  'settings.catalog.launch.name': ['启动器行为与正版登录', 'Launcher Behavior & Official Sign-in'],
  'settings.catalog.launch.keywords': [
    '启动后关闭启动器 微软 系统代理 Microsoft 登录',
    'close launcher after launch Microsoft system proxy sign-in',
  ],
  'settings.catalog.installation.name': ['默认下载位置', 'Default Install Location'],
  'settings.catalog.installation.keywords': [
    '游戏文件夹 路径 游戏版本 安装目录 安装位置 新版本安装目录 新版本安装位置 游戏目录 版本目录 下载位置 默认下载目录 默认目录 绑定目录 D盘 C盘 存储',
    'game folder path version install directory location download location default directory bind storage',
  ],
  'settings.catalog.downloads.name': ['下载并发与速度', 'Download Concurrency & Speed'],
  'settings.catalog.downloads.keywords': [
    '最大线程数 限速 KiB CurseForge API Key 密钥 下载队列',
    'max threads speed limit KiB CurseForge API key download queue',
  ],
  'settings.catalog.mirror.name': ['下载镜像', 'Download Mirror'],
  'settings.catalog.mirror.keywords': ['官方源 BMCLAPI 网络', 'official source BMCLAPI network'],
  'settings.catalog.features.name': ['功能管理', 'Feature Management'],
  'settings.catalog.features.keywords': [
    '侧边栏 模组 资源包 光影 录像 MOD 面板 服务器 联机 皮肤 社区',
    'sidebar mods resource packs shaders recordings mod panel servers multiplayer skins community',
  ],
  'settings.catalog.plugins.name': ['插件', 'Plugins'],
  'settings.catalog.plugins.keywords': ['安装 删除 启用 停用 JS', 'install remove enable disable JS'],
  'settings.catalog.update.name': ['关于与更新', 'About & Updates'],
  'settings.catalog.update.keywords': [
    '版本 自动更新 检查更新 下载源 镜像 回退 还原 本地更新 许可 开源',
    'version auto update check update download source mirror rollback restore local update license open source',
  ],
};

for (const [file, idx] of Object.entries({ 'zh-CN.json': 0, 'en-US.json': 1 })) {
  const p = path.join(DIR, file);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  let added = 0;
  for (const [k, pair] of Object.entries(ADD)) {
    if (k in raw) continue;
    raw[k] = pair[idx];
    added++;
  }
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
  console.log(file, 'added', added, 'total', Object.keys(raw).length);
}
