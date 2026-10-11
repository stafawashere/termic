// The quiet state the Git tab's three views share. Kept apart from GitPanel
// so HistoryPanel can use it without pulling the stores into its tests.

/** A whole view with nothing to list: a sunk medallion, a title, the reason,
 *  and whatever action still makes sense underneath. Compare and History use
 *  it too, so the three views go quiet the same way. */
export function EmptyState({ icon, tone, title, body, children }: {
  icon: React.ReactNode;
  /** Colour of the medallion's glyph and halo. Neutral when left out. */
  tone?: string;
  title: string;
  body?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const toneStyle = tone ? ({ "--rp-medallion-tone": tone } as React.CSSProperties) : undefined;

  return (
    <div className="rp-git-empty">
      <div className="rp-git-medallion" style={toneStyle}>{icon}</div>
      <div className="rp-git-empty-title">{title}</div>
      {body && <div className="rp-git-empty-body">{body}</div>}
      {children}
    </div>
  );
}
