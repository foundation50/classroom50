// The confirm dialogs' "what will happen" summary: the action line, then one
// muted line per skip bucket. Shared by the add confirm and the remove dialog.
export const PreviewPanel = ({
  primary,
  notes,
}: {
  primary: string
  notes: string[]
}) => (
  <div className="flex flex-col gap-1 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
    <span className="font-medium">{primary}</span>
    {notes.map((note) => (
      <span key={note} className="text-base-content/70">
        {note}
      </span>
    ))}
  </div>
)

export default PreviewPanel
