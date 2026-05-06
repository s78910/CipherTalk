import { ipcMain } from 'electron'

export function registerSystemHandlers(): void {
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  ipcMain.handle('file:delete', async (_, filePath: string) => {
    try {
      const fs = await import('fs')
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        return { success: true }
      }
      return { success: false, error: '文件不存在' }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:copy', async (_, sourcePath: string, destPath: string) => {
    try {
      const fs = await import('fs')
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: '源文件不存在' }
      }
      fs.copyFileSync(sourcePath, destPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:writeBase64', async (_, filePath: string, base64Data: string) => {
    try {
      const fs = await import('fs')
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    return shell.openExternal(url)
  })

  ipcMain.handle('shell:showItemInFolder', async (_, fullPath: string) => {
    const { shell } = await import('electron')
    return shell.showItemInFolder(fullPath)
  })
}
