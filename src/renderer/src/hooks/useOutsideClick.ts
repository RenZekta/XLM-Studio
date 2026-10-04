import { useEffect, type RefObject } from 'react'

// Calls onOutside when the user presses the mouse anywhere outside the
// element in `ref`, while `active` is true. Put the toggle button inside the
// ref'd element so clicking it still toggles the menu itself instead of
// closing it here and immediately re-opening it.
export function useOutsideClick(ref: RefObject<HTMLElement>, active: boolean, onOutside: () => void): void {
  useEffect(() => {
    if (!active) return
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active])
}
