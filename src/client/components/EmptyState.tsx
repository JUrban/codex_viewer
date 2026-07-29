export function EmptyState({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <div className="empty-state">
      <p className="eyebrow">Nothing to show</p>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
