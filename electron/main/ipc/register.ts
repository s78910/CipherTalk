import type { MainProcessContext } from '../context'
import { registerAccountHandlers } from './accountHandlers'
import { registerAppHandlers } from './appHandlers'
import { registerConfigHandlers } from './configHandlers'
import { registerDataHandlers } from './dataHandlers'
import { registerHttpApiHandlers } from './httpApiHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerSystemHandlers } from './systemHandlers'
import { registerWindowHandlers } from './windowHandlers'

export function registerModularIpcHandlers(ctx: MainProcessContext): void {
  registerConfigHandlers(ctx)
  registerAccountHandlers(ctx)
  registerSkillHandlers()
  registerMcpHandlers()
  registerHttpApiHandlers(ctx)
  registerDataHandlers(ctx)
  registerSystemHandlers()
  registerAppHandlers(ctx)
  registerWindowHandlers(ctx)
}
