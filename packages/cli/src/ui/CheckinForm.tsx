import React, { useState } from 'react'
import { Box, Text, useApp } from 'ink'
import TextInput from 'ink-text-input'

const FIELDS = [
  { key: 'shipped', label: 'What shipped this week?' },
  { key: 'blocked', label: "What's blocking me?" },
  { key: 'next', label: "Next week's target?" },
] as const

export type CheckinFields = { shipped: string; blocked: string; next: string }

export function CheckinForm({
  prefillShipped,
  onSubmit,
}: {
  prefillShipped: string
  onSubmit: (fields: CheckinFields) => Promise<void>
}): React.JSX.Element {
  const { exit } = useApp()
  const [step, setStep] = useState(0)
  const [values, setValues] = useState<CheckinFields>({ shipped: prefillShipped, blocked: '', next: '' })
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const field = FIELDS[step]
  if (done) return <Text color="green">✓ checked in</Text>
  if (!field) return <Text dimColor>submitting…</Text>

  return (
    <Box flexDirection="column">
      {error && <Text color="red">{error}</Text>}
      {FIELDS.slice(0, step).map((f) => (
        <Text key={f.key} dimColor>
          {f.label} {values[f.key]}
        </Text>
      ))}
      <Box>
        <Text bold>{field.label} </Text>
        <TextInput
          value={values[field.key]}
          onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
          onSubmit={() => {
            if (step < FIELDS.length - 1) {
              setStep(step + 1)
              return
            }
            setStep(FIELDS.length)
            onSubmit(values)
              .then(() => {
                setDone(true)
                exit()
              })
              .catch((err: Error) => {
                setError(err.message)
                setStep(0)
              })
          }}
        />
      </Box>
    </Box>
  )
}
