import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APPLICATION_USER_MODEL_ID, DEVELOPMENT_APPLICATION_USER_MODEL_ID,
  brandToneForTheme, resolveAppTheme, trayAssetForNativeTheme
} from '../src/shared/branding'

describe('WArish Flow branding', () => {
  it('maps every app theme to the intended logo palette', () => {
    expect(brandToneForTheme(resolveAppTheme('system', false))).toBe('light')
    expect(brandToneForTheme(resolveAppTheme('system', true))).toBe('dark')
    expect(brandToneForTheme(resolveAppTheme('light', true))).toBe('light')
    expect(brandToneForTheme(resolveAppTheme('dark', false))).toBe('dark')
    expect(brandToneForTheme(resolveAppTheme('black', false))).toBe('dark')
    expect(brandToneForTheme(resolveAppTheme('salesforce-black', false))).toBe('dark')
  })

  it('uses a dark glyph on a light taskbar and a light glyph on a dark taskbar', () => {
    expect(trayAssetForNativeTheme(false)).toBe('tray-on-light.ico')
    expect(trayAssetForNativeTheme(true)).toBe('tray-on-dark.ico')
  })

  it('uses dedicated Windows identities for packaged and development taskbar groups', () => {
    expect(APPLICATION_USER_MODEL_ID).toBe('com.warish.desktop')
    expect(DEVELOPMENT_APPLICATION_USER_MODEL_ID).toBe('com.warish.desktop.dev.originalflow.v2')
  })

  it('renders the shared BrandMark at every former W location', () => {
    const sources = [
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/NavigationRail.tsx',
      'src/renderer/src/components/Onboarding.tsx'
    ].map((path) => readFileSync(resolve(path), 'utf8'))

    for (const source of sources) {
      expect(source).toContain('<BrandMark')
      expect(source).not.toMatch(/className="brand-mark[^"]*"[^>]*>W</)
    }
  })
})
