import { useStore } from '../store/store'

export default function ClarifySheet() {
  const clarify = useStore((s) => s.clarify)
  const respondClarify = useStore((s) => s.respondClarify)
  if (!clarify) return null
  const options = clarify.choices.length ? clarify.choices : ['OK']
  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">Clarification needed</div>
        <p className="sheet-question">{clarify.question}</p>
        <div className="sheet-options">
          {options.map((opt) => (
            <button key={opt} className="btn btn-outline btn-block" onClick={() => void respondClarify(opt)}>
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
