import { ipcMain } from 'electron'
import { httpApiService } from '../../services/httpApiService'
import type { MainProcessContext } from '../context'

export function registerHttpApiHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('httpApi:getStatus', async () => {
    return { success: true, status: httpApiService.getUiStatus() }
  })

  ipcMain.handle('httpApi:applySettings', async (_, payload: { enabled: boolean; port: number; token: string; listenMode: 'localhost' | 'lan' }) => {
    try {
      const enabled = Boolean(payload?.enabled)
      const portRaw = Number(payload?.port)
      const port = Number.isFinite(portRaw) ? Math.max(1, Math.min(65535, Math.floor(portRaw))) : 5031
      const token = (payload?.token || '').trim()
      const listenMode = payload?.listenMode === 'lan' ? 'lan' : 'localhost'

      if (listenMode === 'lan' && !token) {
        return { success: false, error: '局域网模式必须先配置访问密钥' }
      }

      const configService = ctx.getConfigService()
      configService?.set('httpApiEnabled', enabled)
      configService?.set('httpApiPort', port)
      configService?.set('httpApiToken', token)
      configService?.set('httpApiListenMode', listenMode)

      httpApiService.applySettings({ enabled, port, token, listenMode })
      const restartResult = await httpApiService.restart()
      if (!restartResult.success) {
        return { success: false, error: restartResult.error || 'HTTP API 重启失败' }
      }

      return { success: true, status: httpApiService.getUiStatus() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('httpApi:restart', async () => {
    const result = await httpApiService.restart()
    if (!result.success) {
      return { success: false, error: result.error || 'HTTP API 重启失败' }
    }
    return { success: true, status: httpApiService.getUiStatus() }
  })
}
