/// <reference lib="dom" />
export function isSnapshotMode(search: URLSearchParams): boolean {
  return search.get('snapshot') === '1';
}

export const SNAPSHOT_MODE_CSS = `
[data-snapshot-mode] *:not([data-preserve-motion]):not([data-preserve-motion] *) {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  content-visibility: visible !important;
}
[data-snapshot-mode] { caret-color: transparent !important; }
`.trim();

export function applySnapshotMode(active: boolean): void {
  document.documentElement.toggleAttribute('data-snapshot-mode', active);
  if (!active) return;
  const style = document.createElement('style');
  style.id = 'cinder-snapshot-mode';
  style.textContent = SNAPSHOT_MODE_CSS;
  document.head.append(style);
}
