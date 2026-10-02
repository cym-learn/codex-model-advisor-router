// Response usage is cumulative for one response; reasoning tokens are part of output.
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
export function responseUsage(usage) {
  const inputTokens = count(usage?.input_tokens), outputTokens = count(usage?.output_tokens);
  const cached = count(usage?.input_tokens_details?.cached_tokens);
  const reasoning = count(usage?.output_tokens_details?.reasoning_tokens);
  return { inputTokens, cachedInputTokens: cached !== null && inputTokens !== null && cached > inputTokens ? null : cached,
    outputTokens, reasoningTokens: reasoning !== null && outputTokens !== null && reasoning > outputTokens ? null : reasoning,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null };
}
export function sumUsage(requests) {
  return Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningTokens','totalTokens'].map((field) =>
    [field, requests.length && requests.every((r) => r.usage?.[field] != null) ? requests.reduce((sum,r) => sum + r.usage[field], 0) : null]));
}
