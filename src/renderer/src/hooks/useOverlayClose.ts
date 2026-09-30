import { useRef } from 'react'

// A plain onClick on the backdrop also fires when a user starts a text
// selection drag inside the modal content and releases the mouse over the
// backdrop: the click event's target is the nearest common ancestor of the
// mousedown and mouseup targets, which is the overlay div itself. Requiring
// the mousedown to have also landed directly on the backdrop rules that out
// while still closing on a genuine click outside the content.
export function useOverlayClose(onClose: () => void) {
  const pressedOnBackdrop = useRef(false)
  return {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      pressedOnBackdrop.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (pressedOnBackdrop.current && e.target === e.currentTarget) onClose()
    }
  }
}
