import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ModelCard from './ModelCard'
import { Plus, Upload, Search } from 'lucide-react'
import type { CardState, Template } from '../../../shared/types'
const TEMPLATE_SEARCH_KEY = 'hexllama_template_search'
export default function CardsView() {
  const { cards, setCards, setShowCreateModal, addCard, templateSearch, setTemplateSearch } = useStore()
  useEffect(() => {
    const saved = localStorage.getItem(TEMPLATE_SEARCH_KEY)
    if (saved) setTemplateSearch(saved)
  }, [setTemplateSearch])
  useEffect(() => {
    localStorage.setItem(TEMPLATE_SEARCH_KEY, templateSearch)
  }, [templateSearch])
  async function handleImport() {
    const template = await window.api.importTemplate()
    if (template) {
      addCard(template as Template)
    }
  }
  const filtered = templateSearch.trim()
    ? cards.filter(c => {
        const q = templateSearch.toLowerCase()
        return c.template.name.toLowerCase().includes(q) ||
               (c.template.description || '').toLowerCase().includes(q) ||
               c.template.tags?.some(t => t.toLowerCase().includes(q))
      })
    : cards
  // Drag-reorder. `dropAt` is an index into `filtered` -- the slot the
  // placeholder occupies and the dragged card would land in on drop.
  // `filtered.length` means "at the very end". Kept separate from `cards`
  // so hovering around during a drag never touches real state until drop.
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const draggedIdRef = useRef<string | null>(null)
  const wrapRefs = useRef(new Map<string, HTMLDivElement>())
  // Every visible card's position, frozen at drag start. Hit-testing during
  // dragover must use these fixed rects rather than re-measuring the live
  // DOM: the placeholder itself occupies a grid cell and reflows whatever's
  // around it, so re-measuring mid-drag makes the hovered slot shift out
  // from under the cursor the moment it's chosen, which flips the choice
  // right back -- an oscillation that both looks broken and can leave the
  // browser without a valid drop target at mouse-up, snapping the card back
  // to where it started.
  const dragRectsRef = useRef<{ id: string; rect: DOMRect }[]>([])
  function handleDragStart(id: string, e: React.DragEvent) {
    draggedIdRef.current = id
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    // Firefox drops a drag with no data attached, even when nothing reads it back.
    e.dataTransfer.setData('text/plain', id)
    dragRectsRef.current = filtered
      .map(c => {
        const el = wrapRefs.current.get(c.template.id)
        return el ? { id: c.template.id, rect: el.getBoundingClientRect() } : null
      })
      .filter((r): r is { id: string; rect: DOMRect } => r !== null)
  }
  function handleContainerDragOver(e: React.DragEvent) {
    if (!draggedIdRef.current || dragRectsRef.current.length === 0) return
    e.preventDefault()
    const { clientX, clientY } = e
    let bestIndex = 0
    let bestDist = Infinity
    dragRectsRef.current.forEach(({ rect }, index) => {
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right)
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom)
      const dist = dx * dx + dy * dy
      if (dist < bestDist) { bestDist = dist; bestIndex = index }
    })
    const { rect } = dragRectsRef.current[bestIndex]
    const before = clientX - rect.left < rect.width / 2
    setDropAt(before ? bestIndex : bestIndex + 1)
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const id = draggedIdRef.current
    if (!id || dropAt === null) { resetDrag(); return }
    const visibleIds = filtered.map(c => c.template.id)
    const oldIndex = visibleIds.indexOf(id)
    if (oldIndex === -1) { resetDrag(); return }
    const withoutDragged = visibleIds.filter(vid => vid !== id)
    const insertAt = oldIndex < dropAt ? dropAt - 1 : dropAt
    const newVisibleOrder = [...withoutDragged.slice(0, insertAt), id, ...withoutDragged.slice(insertAt)]
    // Splice the visible subset's new relative order back into its original
    // absolute slots, leaving templates hidden by the current search filter
    // untouched -- otherwise reordering while filtered would silently move
    // hidden templates around too.
    const visibleIdSet = new Set(visibleIds)
    const byId = new Map(cards.map(c => [c.template.id, c]))
    let cursor = 0
    const newCards: CardState[] = cards.map(c =>
      visibleIdSet.has(c.template.id) ? byId.get(newVisibleOrder[cursor++])! : c
    )
    setCards(newCards)
    window.api.reorderTemplates(newCards.map(c => c.template.id))
    resetDrag()
  }
  const draggedIndex = draggedId ? filtered.findIndex(c => c.template.id === draggedId) : -1
  const draggedHeight = draggedId ? dragRectsRef.current.find(r => r.id === draggedId)?.rect.height : undefined
  const showPlaceholderAt = (index: number) =>
    draggedId !== null && dropAt === index && index !== draggedIndex && index !== draggedIndex + 1
  function resetDrag() {
    draggedIdRef.current = null
    setDraggedId(null)
    setDropAt(null)
    dragRectsRef.current = []
  }
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Templates</h1>
          <p className="page-subtitle">
            {cards.length === 0
              ? 'Create your first template to get started'
              : `${filtered.length} of ${cards.length} template${cards.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={handleImport}>
            <Upload size={15} />
            Import
          </button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} />
            New Template
          </button>
        </div>
      </div>
      {}
      {cards.length > 0 && (
        <div className="template-search-bar">
          <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            type="text"
            className="template-search-input"
            placeholder="Search templates..."
            value={templateSearch}
            onChange={e => setTemplateSearch(e.target.value)}
          />
          {templateSearch && (
            <button
              className="template-search-clear"
              onClick={() => setTemplateSearch('')}
              title="Clear"
            >×</button>
          )}
        </div>
      )}
      {cards.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </div>
          <h3>No templates yet</h3>
          <p>Create a template to configure and launch a llama.cpp model with one click.</p>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} />
            Create Template
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px 24px' }}>
          <h3 style={{ fontSize: 15 }}>No matches</h3>
          <p>No templates found for "{templateSearch}".</p>
          <button className="btn btn-ghost" onClick={() => setTemplateSearch('')}>Clear search</button>
        </div>
      ) : (
        <div className="cards-grid" onDragOver={handleContainerDragOver} onDrop={handleDrop}>
          {filtered.map((card, index) => (
            <React.Fragment key={card.template.id}>
              {showPlaceholderAt(index) && (
                <div className="card-drop-placeholder" style={{ height: draggedHeight }} />
              )}
              <div
                ref={(el) => {
                  if (el) wrapRefs.current.set(card.template.id, el)
                  else wrapRefs.current.delete(card.template.id)
                }}
                draggable
                onDragStart={(e) => handleDragStart(card.template.id, e)}
                onDragEnd={resetDrag}
                className={`card-drag-wrap${draggedId === card.template.id ? ' card-drag-source' : ''}`}
              >
                <ModelCard card={card} />
              </div>
            </React.Fragment>
          ))}
          {showPlaceholderAt(filtered.length) && (
            <div className="card-drop-placeholder" style={{ height: draggedHeight }} />
          )}
          <button className="add-card" onClick={() => setShowCreateModal(true)}>
            <Plus size={28} />
            <span>Add Template</span>
          </button>
        </div>
      )}
    </div>
  )
}
