import type { AppSettings } from './contracts'

export type ResolvedAppTheme = Exclude<AppSettings['theme'], 'system'>
export type BrandTone = 'light' | 'dark'
export type TrayAssetName = 'tray-on-light.ico' | 'tray-on-dark.ico'

export const APPLICATION_ICON_ASSET = 'app-icon.ico'
export const APPLICATION_USER_MODEL_ID = 'com.warish.desktop'
export const DEVELOPMENT_APPLICATION_USER_MODEL_ID = 'com.warish.desktop.dev.originalflow.v2'

export function resolveAppTheme(theme: AppSettings['theme'], systemUsesDarkColors: boolean): ResolvedAppTheme {
  return theme === 'system' ? (systemUsesDarkColors ? 'dark' : 'light') : theme
}

export function brandToneForTheme(theme: ResolvedAppTheme): BrandTone {
  return theme === 'light' ? 'light' : 'dark'
}

export function trayAssetForNativeTheme(systemUsesDarkColors: boolean): TrayAssetName {
  return systemUsesDarkColors ? 'tray-on-dark.ico' : 'tray-on-light.ico'
}
