export function Message({
  tone,
  message,
  onDismiss,
}: {
  tone: "error" | "success"
  message: string
  onDismiss: () => void
}) {
  const className =
    tone === "error"
      ? "mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
      : "mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700"
  return (
    <div className={className}>
      {message}
      <button onClick={onDismiss} className="ml-2 underline">
        Dismiss
      </button>
    </div>
  )
}
