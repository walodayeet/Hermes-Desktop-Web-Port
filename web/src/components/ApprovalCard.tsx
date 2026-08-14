import { useStore } from '../store/store'

const CHOICE_LABEL: Record<string, string> = {
  once: 'Approve',
  session: 'Approve (session)',
  always: 'Approve (always)',
  deny: 'Deny',
}

export default function ApprovalCard() {
  const approval = useStore((s) => s.approval)
  const respondApproval = useStore((s) => s.respondApproval)
  if (!approval) return null
  const choices = approval.choices?.length ? approval.choices : ['once', 'deny']
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-tag">Approval</span>
        <code className="approval-command">{approval.command}</code>
      </div>
      {approval.description && <p className="approval-desc">{approval.description}</p>}
      <div className="approval-actions">
        {choices.map((c) => (
          <button
            key={c}
            className={`btn ${c === 'deny' ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void respondApproval(c)}
          >
            {CHOICE_LABEL[c] ?? c}
          </button>
        ))}
      </div>
    </div>
  )
}
