import type { ReactNode } from 'react'
import './SettingsSection.scss'

interface SettingsSectionProps {
  title: ReactNode
  description?: ReactNode
  className?: string
  children: ReactNode
}

function SettingsSection({ title, description, className = '', children }: SettingsSectionProps) {
  const classes = ['settings-section', className].filter(Boolean).join(' ')

  return (
    <section className={classes}>
      <h3 className="section-title">{title}</h3>
      {description && <p className="section-desc">{description}</p>}
      {children}
    </section>
  )
}

export default SettingsSection
