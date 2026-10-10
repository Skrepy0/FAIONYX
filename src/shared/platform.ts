/** Explicit product platforms. HarmonyOS must never inherit Linux binary rules. */
import { translate as t } from './i18n';

export type ProductPlatform = 'windows' | 'macos' | 'linux' | 'harmonyos' | 'unsupported';
export type ProductArchitecture = 'x64' | 'arm64' | 'unsupported';
export type InstallationKind = 'portable-exe' | 'mac-app' | 'appimage' | 'deb' | 'portable-directory' | 'hap' | 'development';
export interface PlatformInfo {
  platform: ProductPlatform;
  architecture: ProductArchitecture;
  installation: InstallationKind;
  systemMemoryOrganizing: boolean;
  nativeGameRuntime: 'supported' | 'requires-verification' | 'unsupported';
}
export function productPlatform(platform: string): ProductPlatform {
  const platforms: Record<string, ProductPlatform> = {
    win32: 'windows',
    darwin: 'macos',
    linux: 'linux',
    openharmony: 'harmonyos',
    ohos: 'harmonyos',
  };
  return platforms[platform] ?? 'unsupported';
}
export function productArchitecture(arch: string): ProductArchitecture {
  return arch === 'x64' || arch === 'arm64' ? arch : 'unsupported';
}
export function minecraftRuleOs(platform: string): 'windows' | 'osx' | 'linux' | 'unsupported' {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : platform === 'linux' ? 'linux' : 'unsupported';
}
export function requireDesktopGamePlatform(platform: string): void {
  if (minecraftRuleOs(platform) === 'unsupported') throw new Error(t('platform.error.native_runtime_unverified'));
}
export function platformInfo(platform: string, arch: string, installation: InstallationKind): PlatformInfo {
  const os = productPlatform(platform),
    architecture = productArchitecture(arch);
  return {
    platform: os,
    architecture,
    installation,
    systemMemoryOrganizing: os === 'windows',
    nativeGameRuntime:
      os === 'harmonyos' ? 'requires-verification' : os === 'unsupported' || architecture === 'unsupported' ? 'unsupported' : 'supported',
  };
}

export function updateArtifactName(version: string, platform: string, arch: string, installation: InstallationKind): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(t('platform.error.invalid_version'));
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(t('platform.error.unsupported_arch'));
  if (platform === 'win32') return `FAIONYX-${version}.exe`;
  if (platform === 'darwin') return `FAIONYX-${version}-mac-${arch}.zip`;
  if (platform === 'linux') {
    const extension = installation === 'appimage' ? 'AppImage' : installation === 'deb' ? 'deb' : 'tar.gz';
    return `FAIONYX-${version}-linux-${arch}.${extension}`;
  }
  throw new Error(t('platform.error.unsupported_platform'));
}
