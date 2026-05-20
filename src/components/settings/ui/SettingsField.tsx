import type { ReactNode } from 'react'
import './SettingsField.scss'

interface SettingsFieldProps {
  label?: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}

function SettingsField({ label, hint, className = '', children }: SettingsFieldProps) {
  const classes = ['form-group', className].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      {label && <label className="field-label">{label}</label>}
      {hint && <span className="form-hint">{hint}</span>}
      {children}
    </div>
  )
}

export default SettingsField
