import type { WarishApi } from '../../shared/contracts'

declare global {
  interface Window {
    warish: WarishApi
  }
}

export {}

