import { useEffect, useState } from 'react';

// Drop-in useState replacement that persists the value to sessionStorage
// under the given key. Survives navigation between routes within the
// same browser tab, but resets when the tab is closed — exactly what
// the Lists page wants: keep the operator's filters as they click
// around the app, but don't carry them across days/sessions.
//
// To preserve "until reset manually" semantics: the page's "Reset
// filters" handler should call the setters with the defaults. That
// writes the defaults back to sessionStorage, so a subsequent reload
// also lands on the cleared state.
export function useSessionState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded / private mode — swallow; the in-memory state still works.
    }
  }, [key, value]);

  return [value, setValue];
}
