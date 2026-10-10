import { computed, ref } from 'vue';
import { getSystemInfo } from '../api';
import { t } from '@renderer/i18n';
const systemInstaller = ref(false);
let requested = false;
/** Keep native installer handoff distinct from a completed portable replacement. */
export function usePlatformUpdate() {
  if (!requested) {
    requested = true;
    if (window.faionyx.platform === 'linux')
      void getSystemInfo()
        .then((info) => {
          systemInstaller.value = info.installation === 'deb';
        })
        .catch(() => {});
  }
  const installAction = computed(() => t(systemInstaller.value ? 'update.action.open_installer' : 'update.action.apply_next_launch'));
  const installExplanation = computed(() =>
    t(systemInstaller.value ? 'update.explain.system_installer' : 'update.explain.portable_replace')
  );
  const updateReadyMessage = (prefix = t('update.ready_prefix')) =>
    prefix + t(systemInstaller.value ? 'update.ready_suffix.system_installer' : 'update.ready_suffix.portable');
  return { systemInstaller, installAction, installExplanation, updateReadyMessage };
}
