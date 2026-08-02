export function ErrorState({
  title,
  message,
  onDismiss,
}: {
  title: string;
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
      {onDismiss
        ? (
            <button
              className="error-dismiss"
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
            >
              <span aria-hidden="true">×</span>
            </button>
          )
        : null}
    </div>
  );
}
