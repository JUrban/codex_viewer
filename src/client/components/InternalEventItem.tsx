import type {
  InternalEventItem as Internal,
  TokenUsageCounters,
} from "../../shared/domain";

export function InternalEventItem({ item }: { item: Internal }) {
  return (
    <article className="internal-event-body">
      <p className="event-label">Internal · {item.ordinal}</p>
      <p>
        <strong>{item.eventType}</strong>
        {item.tokenUsage === undefined ? <> — {item.summary}</> : null}
      </p>
      {item.tokenUsage === undefined
        ? null
        : (
            <div className="token-usage">
              <TokenUsageGroup label="Total" counters={item.tokenUsage.total} />
              <TokenUsageGroup label="Last" counters={item.tokenUsage.last} />
            </div>
          )}
    </article>
  );
}

const TOKEN_FIELDS: Array<[keyof TokenUsageCounters, string]> = [
  ["totalTokens", "Total tokens"],
  ["inputTokens", "Input"],
  ["cachedInputTokens", "Cached input"],
  ["cacheWriteInputTokens", "Cache write input"],
  ["outputTokens", "Output"],
  ["reasoningOutputTokens", "Reasoning output"],
];

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

interface TokenUsageGroupProps {
  label: "Total" | "Last";
  counters: TokenUsageCounters | null;
}

function TokenUsageGroup({ label, counters }: TokenUsageGroupProps) {
  return (
    <section aria-label={`${label} token usage`}>
      <h4>{label}</h4>
      {counters === null
        ? <p className="token-usage-unavailable">Unavailable</p>
        : (
            <dl>
              {TOKEN_FIELDS.map(([field, fieldLabel]) => {
                const value = counters[field];
                if (value === null) return null;

                return (
                  <div key={field}>
                    <dt>{fieldLabel}</dt>
                    <dd>{NUMBER_FORMAT.format(value)}</dd>
                  </div>
                );
              })}
            </dl>
          )}
    </section>
  );
}
