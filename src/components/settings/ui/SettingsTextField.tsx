import { InputAdornment, TextField, type TextFieldProps } from '@mui/material'
import type { ReactNode } from 'react'
import './SettingsTextField.scss'

export type SettingsTextFieldProps = Omit<TextFieldProps, 'variant' | 'fullWidth' | 'size'> & {
  endAdornment?: ReactNode
  onValueChange?: (value: string) => void
}

function SettingsTextField({
  className = '',
  endAdornment,
  InputProps,
  onChange,
  onValueChange,
  ...props
}: SettingsTextFieldProps) {
  const classes = ['settings-text-field', className].filter(Boolean).join(' ')
  const mergedInputProps = endAdornment
    ? {
      ...InputProps,
      endAdornment: (
        <InputAdornment position="end">
          {endAdornment}
        </InputAdornment>
      )
    }
    : InputProps

  return (
    <TextField
      {...props}
      className={classes}
      variant="outlined"
      fullWidth
      size="small"
      InputProps={mergedInputProps}
      onChange={(event) => {
        onValueChange?.(event.target.value)
        onChange?.(event)
      }}
    />
  )
}

export default SettingsTextField
