/** 内置更新日志：下拉面板数据源（无网络依赖） */
export interface UpdateNote {
  version: string;
  /** 发布时间：YYYY-MM-DD HH:mm（24 小时制） */
  date: string;
  changes: string[];
}

/** 按版本倒序；latest 为当前版本 */
export const updateNotes: UpdateNote[] = [
  {
    version: '1.0.0',
    date: '2026-10-09 22:20',
    changes: [
      'FAIONYX首个版本,下面是相较于KAMUCL的变化',
      '优化启动动画',
      '新增多语言系统',
      '优化ui显示，修复了之前的一些ui显示bug',
      '修改了插件系统，支持导入zip压缩包；添加加载语言文件的api，现支持通过js插件的方式添加语言',
      '添加启动游戏时设置游戏窗口和启动器窗口大小一致的功能',
      '修改默认图片',
    ],
  },
];

export const latestUpdateNote = (): UpdateNote => updateNotes[0];
