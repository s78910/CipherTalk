import { ipcMain } from 'electron'
import { wechatDecryptService } from '../../services/decryptService'
import type { MainProcessContext } from '../context'

export function registerDataHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('db:open', async (_, dbPath: string) => {
    return ctx.getDbService()?.open(dbPath)
  })

  ipcMain.handle('db:query', async (_, sql: string, params?: any[]) => {
    return ctx.getDbService()?.query(sql, params)
  })

  ipcMain.handle('db:close', async () => {
    return ctx.getDbService()?.close()
  })

  ipcMain.handle('decrypt:database', async (_, sourcePath: string, key: string, outputPath: string) => {
    return wechatDecryptService.decryptDatabase(sourcePath, outputPath, key)
  })

  ipcMain.handle('decrypt:image', async () => {
    return null
  })
}
