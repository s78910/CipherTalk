import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import SettingsTextField, { type SettingsTextFieldProps } from './SettingsTextField'
import './SecretInput.scss'

type SecretInputProps = Omit<SettingsTextFieldProps, 'type' | 'onChange' | 'onValueChange' | 'endAdornment' | 'value'> & {
  value: string
  onChange: (value: string) => void
  visible?: boolean
  onVisibleChange?: (visible: boolean) => void
}

function SecretInput({ value, onChange, visible, onVisibleChange, className = '', ...textFieldProps }: SecretInputProps) {
  const [internalVisible, setInternalVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const isVisible = visible ?? internalVisible

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleToggle = () => {
    const nextVisible = !isVisible
    if (visible === undefined) {
      setInternalVisible(nextVisible)
    }
    onVisibleChange?.(nextVisible)
  }

  const handleCopy = async () => {
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)

      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, 1400)
    } catch (error) {
      setCopied(false)
      console.error('复制密钥失败:', error)
    }
  }

  return (
    <SettingsTextField
      {...textFieldProps}
      className={['settings-secret-input', className].filter(Boolean).join(' ')}
      type={isVisible ? 'text' : 'password'}
      value={value}
      onValueChange={onChange}
      endAdornment={(
        <div className="settings-text-field__end-actions">
          <button
            type="button"
            className="settings-text-field__icon-button"
            onClick={handleToggle}
            title={isVisible ? '隐藏' : '显示'}
            aria-label={isVisible ? '隐藏密钥' : '显示密钥'}
          >
            {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            type="button"
            className="settings-text-field__icon-button"
            onClick={handleCopy}
            title={copied ? '已复制' : '复制'}
            aria-label={copied ? '密钥已复制' : '复制密钥'}
            disabled={!value}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      )}
    />
  )
}

export default SecretInput
