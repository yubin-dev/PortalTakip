export function createRateLimiter(now = Date.now) {
  const buckets = new Map();
  return {
    allow(scope, key, limit, windowMs = 60_000) {
      const id = `${scope}:${key}`;
      const current = now();
      let bucket = buckets.get(id);
      if (!bucket || current >= bucket.until) {
        if (buckets.size >= 10_000) {
          for (const [oldId, old] of buckets) {
            if (current >= old.until) buckets.delete(oldId);
          }
          if (buckets.size >= 10_000 && !buckets.has(id)) return false;
        }
        bucket = {until: current + windowMs, count: 0};
        buckets.set(id, bucket);
      }
      bucket.count++;
      return bucket.count <= limit;
    },
  };
}
