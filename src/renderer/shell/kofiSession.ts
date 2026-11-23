import { useSyncExternalStore } from "react";

// set once the post-update note opened this session, the rail's coffee pill stays away until
// the next launch so the ask isn't on screen twice
let noteShown = false;
const listeners = new Set<() => void>();

export function markKofiNoteShown(): void {
  if (noteShown) return;
  noteShown = true;
  for (const l of listeners) l();
}

export function useKofiNoteShown(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => noteShown,
  );
}
