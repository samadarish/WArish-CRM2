import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys'
import { WarishDatabase } from './database'

export interface PersistentAuthState {
  state: AuthenticationState
  saveCreds(): void
}

export function createPersistentAuthState(database: WarishDatabase): PersistentAuthState {
  const stored = database.getAuth('creds', 'primary')
  const creds = stored
    ? (JSON.parse(stored.toString('utf8'), BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds()

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<Record<string, SignalDataTypeMap[T]>> => {
        const result: Record<string, SignalDataTypeMap[T]> = {}
        const storedValues = database.getAuthMany(type, ids)
        for (const id of ids) {
          const storedValue = storedValues.get(id)
          if (!storedValue) continue
          let value = JSON.parse(storedValue.toString('utf8'), BufferJSON.reviver) as SignalDataTypeMap[T]
          if (type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T]
          }
          result[id] = value
        }
        return result
      },
      set: async (data): Promise<void> => {
        database.transaction(() => {
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const entries = data[category]
            if (!entries) continue
            for (const [id, value] of Object.entries(entries)) {
              database.setAuth(
                category,
                id,
                value === null || value === undefined
                  ? undefined
                  : Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8')
              )
            }
          }
        })
      }
    }
  }

  return {
    state,
    saveCreds: () => {
      database.setAuth('creds', 'primary', Buffer.from(JSON.stringify(state.creds, BufferJSON.replacer), 'utf8'))
    }
  }
}
