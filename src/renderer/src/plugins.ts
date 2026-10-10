/**
 * 插件加载器：以 <script src="faionyx-plugin://<id>/main.js"> 方式加载启用的 JS 插件。
 * 走自定义协议而非 eval/inline，页面 CSP 仅需精确放行 faionyx-plugin: 脚本源。
 * 插件通过全局单例 window.faionyxPlugin 使用 API：toast / 视图事件 / 样式注入 /
 * store 引用，并可直接操作 DOM 更改 UI。仅安装可信来源的插件。
 */
import { watch } from 'vue';
import { listPlugins } from './api';
import { store, toast } from './store';
import { bumpLocaleRevision, setLocale, t } from '@renderer/i18n';
import { flattenDeep, mergeLocaleMessages } from '@shared/i18n';

export interface FaionyxPluginApi {
  /** 全局 toast 通知 */
  toast: typeof toast;
  /** 注入自定义 CSS（更改界面样式） */
  addStyles: (css: string) => void;
  /** 视图切换事件，返回取消订阅函数 */
  onViewChange: (cb: (view: string) => void) => () => void;
  /** 当前视图名 */
  getView: () => string;
  /** 启动器响应式状态（谨慎修改） */
  store: typeof store;
  /** 启动器版本号 */
  version: string;
  /** 运行时注入/覆盖一种语言的词条（JSON 字符串） */
  loadLocale: (id: string, json: string, displayName?: string) => boolean;
}

declare global {
  interface Window {
    faionyxPlugin?: FaionyxPluginApi;
  }
}

let apiInstalled = false;
let pluginsLoaded = false;

/** 安装全局插件 API 单例（所有插件共享）。 */
function installGlobalApi(): void {
  if (apiInstalled) return;
  apiInstalled = true;
  const viewCallbacks = new Set<(view: string) => void>();
  window.faionyxPlugin = {
    toast,
    addStyles(css) {
      const el = document.createElement('style');
      el.dataset.faionyxPlugin = 'true';
      el.textContent = String(css);
      document.head.appendChild(el);
    },
    onViewChange(cb) {
      viewCallbacks.add(cb);
      return () => viewCallbacks.delete(cb);
    },
    getView: () => store.currentView,
    store,
    version: __APP_VERSION__,
    loadLocale(id, json, displayName) {
      if (typeof id !== 'string' || !id) return false;
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch (e) {
        console.error(`[Plugin] language parse error: ${e}`);
        return false;
      }
      const flat = flattenDeep(raw);
      if (!flat) return false;
      const ok = mergeLocaleMessages(id, flat, displayName);
      if (ok) bumpLocaleRevision();
      if (store.locale === id) setLocale(id);
      return ok;
    },
  };

  watch(
    () => store.currentView,
    (view) => {
      for (const cb of viewCallbacks) {
        try {
          cb(view);
        } catch {
          /* 插件回调异常不影响启动器 */
        }
      }
    }
  );
}

export async function loadEnabledPlugins(): Promise<void> {
  if (pluginsLoaded) return;
  pluginsLoaded = true;
  let list: Awaited<ReturnType<typeof listPlugins>>;
  try {
    list = await listPlugins();
  } catch {
    return;
  }
  const enabled = list.filter((p) => p.enabled && p.hasCode);
  if (!enabled.length) return;
  installGlobalApi();
  for (const plugin of enabled) {
    await new Promise<void>((resolve) => {
      const el = document.createElement('script');
      el.src = `faionyx-plugin://${encodeURIComponent(plugin.id)}/main.js`;
      el.dataset.faionyxPlugin = plugin.id;
      el.onload = () => {
        console.info(`[FAIONYX] ${t('plugins.log.loaded', { id: plugin.id })}`);
        resolve();
      };
      el.onerror = () => {
        console.warn(`[FAIONYX] ${t('plugins.log.load_failed', { id: plugin.id })}`);
        resolve();
      };
      document.head.appendChild(el);
    });
  }
}
