import type { CSSProperties, ReactNode } from 'react'
import './SegmentedControl.scss'

export interface SegmentedControlOption<T extends string | number = string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

interface SegmentedControlProps<T extends string | number = string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
  style?: CSSProperties
}

function SegmentedControl<T extends string | number = string>({
  options,
  value,
  onChange,
  className = '',
  style
}: SegmentedControlProps<T>) {
  const classes = ['theme-mode-toggle', className].filter(Boolean).join(' ')

  return (
    <div className={classes} style={style}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          title={option.title}
          className={`mode-btn ${value === option.value ? 'active' : ''}`}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export default SegmentedControl
