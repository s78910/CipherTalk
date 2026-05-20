import { FolderOpen, RotateCcw } from 'lucide-react'
import SettingsTextField, { type SettingsTextFieldProps } from './SettingsTextField'
import './PathInput.scss'

type PathInputProps = Omit<SettingsTextFieldProps, 'onChange' | 'onValueChange' | 'endAdornment' | 'value'> & {
  value: string
  onChange: (value: string) => void
  onBrowse?: () => void
  onReset?: () => void
  browseLabel?: string
  resetLabel?: string
}

function PathInput({
  value,
  onChange,
  onBrowse,
  onReset,
  browseLabel = '浏览选择',
  resetLabel = '恢复默认',
  className = '',
  ...textFieldProps
}: PathInputProps) {
  const hasActions = Boolean(onBrowse || onReset)

  return (
    <SettingsTextField
      {...textFieldProps}
      className={['settings-path-input', className].filter(Boolean).join(' ')}
      value={value}
      onValueChange={onChange}
      endAdornment={hasActions ? (
        <div className="settings-text-field__end-actions">
          {onBrowse && (
            <button
              type="button"
              className="settings-text-field__icon-button"
              onClick={onBrowse}
              title={browseLabel}
              aria-label={browseLabel}
            >
              <FolderOpen size={16} />
            </button>
          )}
          {onReset && (
            <button
              type="button"
              className="settings-text-field__icon-button"
              onClick={onReset}
              title={resetLabel}
              aria-label={resetLabel}
            >
              <RotateCcw size={16} />
            </button>
          )}
        </div>
      ) : undefined}
    />
  )
}

export default PathInput
