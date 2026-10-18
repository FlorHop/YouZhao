/**
 * 展示格式化（只做展示，不改语义）。
 *
 * 时间一律按浏览器本地时区呈现，服务端返回 ISO（UTC）字符串。
 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex] ?? 'MB'}`;
}

/** 「最近使用」这类相对时间；超过 30 天回落为日期。 */
export function formatRelative(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '从未使用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const minute = 60_000;
  if (diffMs < minute) return '刚刚';
  if (diffMs < 60 * minute) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < 24 * 60 * minute) return `${Math.floor(diffMs / (60 * minute))} 小时前`;
  if (diffMs < 30 * 24 * 60 * minute) return `${Math.floor(diffMs / (24 * 60 * minute))} 天前`;
  return formatDate(value);
}

/** Token 等敏感串只展示前缀。 */
export function truncateMiddle(value: string, head = 14, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
