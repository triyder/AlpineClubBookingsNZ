"use client"

export function PolicyFeedback({
  error,
  success,
  onClearError,
  onClearSuccess,
}: {
  error: string
  success: string
  onClearError: () => void
  onClearSuccess: () => void
}) {
  return (
    <>
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
          <button onClick={onClearError} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200">
          {success}
          <button onClick={onClearSuccess} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
