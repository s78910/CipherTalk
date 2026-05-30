import { Tabs, type Key } from '@heroui/react'
import { Moon, Monitor, PanelBottom, PanelLeft, Sun } from 'lucide-react'
import { useThemeStore, type NavLayout } from '../../../stores/themeStore'
import { useSettingsStore } from '../settingsStore'
import Select from '../../Select'

type ThemeMode = 'light' | 'dark' | 'system'

const toThemeMode = (key: Key): ThemeMode => String(key) as ThemeMode
const toNavLayout = (key: Key): NavLayout => String(key) as NavLayout

function AppearanceTab() {
  const { themeMode, navLayout, dockAutoHide, setThemeMode, setNavLayout, setDockAutoHide } = useThemeStore()
  const quoteStyle = useSettingsStore(s => s.config.quoteStyle)
  const closeToTray = useSettingsStore(s => s.config.closeToTray)
  const setField = useSettingsStore(s => s.setField)

  return (
    <div className="tab-content">
      <Tabs selectedKey={themeMode} onSelectionChange={(key) => setThemeMode(toThemeMode(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="外观模式" className="*:gap-2">
            <Tabs.Tab id="light"><Sun size={16} aria-hidden />浅色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dark"><Moon size={16} aria-hidden />深色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="system"><Monitor size={16} aria-hidden />跟随系统<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>导航布局</h3>
      <Tabs selectedKey={navLayout} onSelectionChange={(key) => setNavLayout(toNavLayout(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="导航布局" className="*:gap-2">
            <Tabs.Tab id="sidebar"><PanelLeft size={16} aria-hidden />侧边栏<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dock"><PanelBottom size={16} aria-hidden />底部 Dock<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {navLayout === 'dock' && (
        <>
          <h3 className="section-title" style={{ marginTop: '1.5rem' }}>Dock 自动收起</h3>
          <Select<'on' | 'off'>
            style={{ maxWidth: 460 }}
            value={dockAutoHide ? 'on' : 'off'}
            onChange={(v) => setDockAutoHide(v === 'on')}
            options={[
              {
                value: 'on',
                label: '空闲时自动收起',
                description: '鼠标离开 Dock 2.5 秒后收回；移到屏幕底部重新浮出'
              },
              {
                value: 'off',
                label: '始终显示',
                description: 'Dock 一直停留在底部不收起'
              }
            ]}
          />
        </>
      )}

      <h3 className="section-title" style={{ marginTop: '2rem' }}>引用消息样式</h3>
      <div className="quote-style-options">
        <label className={`radio-label ${quoteStyle === 'default' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="default"
            checked={quoteStyle === 'default'}
            onChange={() => setField('quoteStyle', 'default')}
          />
          <div className="radio-content">
            <div className="style-preview">
              <img src="./logo.png" className="preview-avatar" alt="对方" />
              <div className="preview-bubble default">
                <div className="preview-quote">张三: 那天去爬山的照片...</div>
                <div className="preview-text">拍得真不错！</div>
              </div>
            </div>
          </div>
        </label>

        <label className={`radio-label ${quoteStyle === 'wechat' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="wechat"
            checked={quoteStyle === 'wechat'}
            onChange={() => setField('quoteStyle', 'wechat')}
          />
          <div className="radio-content">
            <div className="style-preview">
              <img src="./logo.png" className="preview-avatar" alt="对方" />
              <div className="preview-group">
                <div className="preview-bubble wechat">拍得真不错！</div>
                <div className="preview-quote-bubble">张三: 那天去爬山的照片...</div>
              </div>
            </div>
          </div>
        </label>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>窗口关闭行为</h3>
      <Select<'tray' | 'quit'>
        style={{ maxWidth: 460 }}
        value={closeToTray ? 'tray' : 'quit'}
        onChange={(v) => setField('closeToTray', v === 'tray')}
        options={[
          {
            value: 'tray',
            label: '最小化到托盘',
            description: '点击关闭按钮后，应用将最小化到系统托盘继续运行'
          },
          {
            value: 'quit',
            label: '直接退出应用',
            description: '点击关闭按钮后，应用将完全退出'
          }
        ]}
      />
    </div>
  )
}

export default AppearanceTab
