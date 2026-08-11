export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(0)} 秒`;
}
