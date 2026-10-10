/** A working cipher with a public fallback password is not protected storage. */
import { translate as t } from '../../shared/i18n';
export interface CredentialStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}
export function protectedCredentialStorage(storage: CredentialStorage, platform: string = process.platform): boolean {
  try {
    if (!storage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend?.() ?? '');
  } catch {
    return false;
  }
}
export function credentialStorageStatus(storage: CredentialStorage, platform: string = process.platform) {
  const persistent = protectedCredentialStorage(storage, platform);
  return {
    persistent,
    sessionOnly: platform === 'linux' && !persistent,
    message: persistent ? '' : platform === 'linux' ? t('credprotect.linux_unavailable') : t('credprotect.unavailable'),
  };
}
