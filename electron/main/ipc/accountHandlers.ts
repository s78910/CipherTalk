import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

export function registerAccountHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('accounts:list', async () => {
    return ctx.getConfigService()?.listAccounts() || []
  })

  ipcMain.handle('accounts:getActive', async () => {
    return ctx.getConfigService()?.getActiveAccount() || null
  })

  ipcMain.handle('accounts:setActive', async (_, accountId: string) => {
    return ctx.getConfigService()?.setActiveAccount(accountId) || null
  })

  ipcMain.handle('accounts:save', async (_, profile: any) => {
    return ctx.getConfigService()?.saveAccount(profile) || null
  })

  ipcMain.handle('accounts:update', async (_, accountId: string, patch: any) => {
    return ctx.getConfigService()?.updateAccount(accountId, patch) || null
  })

  ipcMain.handle('accounts:delete', async (_, accountId: string, deleteLocalData = false) => {
    const configService = ctx.getConfigService()
    if (!configService) {
      return { success: false, error: '配置服务未初始化' }
    }

    const deleted = configService.listAccounts().find((item) => item.id === accountId) || null
    if (!deleted) {
      return { success: false, error: '账号不存在' }
    }

    if (deleteLocalData) {
      const cacheService = new (await import('../../services/cacheService')).CacheService(configService)
      const clearResult = await cacheService.clearAccountDatabases(deleted)
      if (!clearResult.success) {
        return { success: false, error: clearResult.error || '删除账号本地数据失败' }
      }
    }

    const result = configService.deleteAccount(accountId)
    return { success: true, deleted: result.deleted, nextActiveAccountId: result.nextActiveAccountId }
  })
}
