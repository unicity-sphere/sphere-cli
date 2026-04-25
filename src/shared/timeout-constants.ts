/**
 * Shared timeout constants used across CLI namespaces.
 *
 * MIN_TIMEOUT_MS is the smallest --timeout value sphere-cli accepts before
 * forwarding to the tenant. Anything finer-grained guarantees a timeout
 * before the tenant has even finished parsing the request, which a malicious
 * controller could weaponise to drain the registry's concurrency slots.
 *
 * Aligned with agentic-hosting's `command-registry.ts` MIN_TIMEOUT_MS = 100.
 * If those layers diverge, this value MUST track the tenant-side floor —
 * sending a value below the tenant's floor produces a confusing two-hop
 * `invalid_params` error far from the source.
 */
export const MIN_TIMEOUT_MS = 100;
