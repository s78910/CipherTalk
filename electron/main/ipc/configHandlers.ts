import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

export function registerConfigHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('config:get', async (_, key: string) => {
    return ctx.getConfigService()?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    return ctx.getConfigService()?.set(key as any, value)
  })

  ipcMain.handle('config:getTldCache', async () => {
    return ctx.getConfigService()?.getTldCache()
  })

  ipcMain.handle('config:setTldCache', async (_, tlds: string[]) => {
    return ctx.getConfigService()?.setTldCache(tlds)
  })
}
