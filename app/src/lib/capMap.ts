// Insert into a Map with a size cap. When full and the key is new, evict the oldest
// entry first — Map preserves insertion order, so `keys().next()` is the oldest. Used by
// session-lifetime caches (symbol colours, C++ struct/field kinds) so they stay bounded
// across a very long session that opens many files, instead of growing without limit.
// Eviction only costs a re-computation later (a fresh hover probe / re-classify); never
// a correctness problem.
export function capMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}
