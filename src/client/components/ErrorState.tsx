export function ErrorState({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="error-state" role="alert"><strong>Could not load sessions</strong><p>{message}</p>
    <button type="button" onClick={onDismiss}>Dismiss</button></div>;
}
