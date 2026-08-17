import React from 'react'

// Format bytes into a human-readable string with MB/GB/TB units.
export function formatBytes(b: number): string {
  if (!b || b <= 0) return '—'
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  const TB = GB * 1024
  if (b >= TB) return `${(b / TB).toFixed(2)} TB`
  if (b >= GB) return `${(b / GB).toFixed(2)} GB`
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`
  if (b >= KB) return `${(b / KB).toFixed(1)} KB`
  return `${b} B`
}

export function formatSpeed(bps?: number): string {
  if (!bps) return ''
  const mbps = bps / (1024 * 1024)
  return `${mbps.toFixed(1)} MB/s`
}

// A reusable star icon used for the "main folder" selector.
// `active` = yellow filled (this folder is the main one); handled via the
// parent button's `.is-main` class. The prop is accepted for API symmetry.
export function StarIcon({ size = 16 }: { active?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="star-shape"
      aria-hidden="true"
    >
      <path
        className="star-shape"
        d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"
      />
    </svg>
  )
}
