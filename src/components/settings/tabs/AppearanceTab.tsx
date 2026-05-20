import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { themes, useThemeStore } from '../../../stores/themeStore'
import { useSettingsStore } from '../settingsStore'

function AppearanceTab() {
  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const quoteStyle = useSettingsStore(s => s.config.quoteStyle)
  const closeToTray = useSettingsStore(s => s.config.closeToTray)
  const setField = useSettingsStore(s => s.setField)

  return (
    <div className="tab-content">
      <div className="theme-mode-toggle">
        <button className={`mode-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => setThemeMode('light')}>
          <Sun size={16} /> 浅色
        </button>
        <button className={`mode-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => setThemeMode('dark')}>
          <Moon size={16} /> 深色
        </button>
        <button className={`mode-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => setThemeMode('system')}>
          <Monitor size={16} /> 跟随系统
        </button>
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <div key={theme.id} className={`theme-card ${currentTheme === theme.id ? 'active' : ''}`} onClick={() => setTheme(theme.id)}>
            <div className="theme-preview" style={{ background: themeMode === 'dark' ? 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)' : `linear-gradient(135deg, ${theme.bgColor} 0%, ${theme.bgColor}dd 100%)` }}>
              <div className="theme-accent" style={{ background: theme.primaryColor }} />
            </div>
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-desc">{theme.description}</span>
            </div>
            {currentTheme === theme.id && <div className="theme-check"><Check size={14} /></div>}
          </div>
        ))}
      </div>

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
      <div className="quote-style-options">
        <label className={`radio-label ${closeToTray ? 'active' : ''}`}>
          <input
            type="radio"
            name="closeAction"
            value="tray"
            checked={closeToTray}
            onChange={() => setField('closeToTray', true)}
          />
          <div className="radio-content">
            <span className="radio-title">最小化到托盘</span>
            <span className="radio-desc">点击关闭按钮后，应用将最小化到系统托盘继续运行</span>
          </div>
        </label>

        <label className={`radio-label ${!closeToTray ? 'active' : ''}`}>
          <input
            type="radio"
            name="closeAction"
            value="quit"
            checked={!closeToTray}
            onChange={() => setField('closeToTray', false)}
          />
          <div className="radio-content">
            <span className="radio-title">直接退出应用</span>
            <span className="radio-desc">点击关闭按钮后，应用将完全退出</span>
          </div>
        </label>
      </div>
    </div>
  )
}

export default AppearanceTab
