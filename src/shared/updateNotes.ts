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
    date: '2026-10-09 19:11',
    changes: ['首个版本'],
  },
];

export const latestUpdateNote = (): UpdateNote => updateNotes[0];
