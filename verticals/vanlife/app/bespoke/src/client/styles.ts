/** Scoped styles for the map-first dashboard, injected once. */
export const VL_STYLES = `
/* Full-bleed escape from the shell's fixed content column. The ideal
   end-state is an AppShell fullBleed option; this hack is contained here. */
.vl-dash { width: 100vw; margin-left: calc(50% - 50vw); margin-top: -24px; }

.vl-layout { display: flex; flex-direction: column; }
.vl-map-pane { height: 55dvh; position: relative; }
.vl-panel { padding: 12px 16px 96px; }
@media (min-width: 900px) {
  .vl-layout { flex-direction: row-reverse; height: calc(100dvh - 60px); }
  .vl-map-pane { flex: 1; height: auto; }
  .vl-panel { width: 400px; overflow-y: auto; padding-bottom: 16px; }
}

.vl-banner { position: absolute; top: 8px; left: 8px; right: 48px; z-index: 5;
  background: #ffffffee; border: 1px solid #ddd; border-radius: 8px; padding: 8px 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.vl-banner-urgent { border-color: #b3261e; }
.vl-banner h4 { margin: 0 0 4px; font-size: .95rem; }
.vl-banner ul { margin: 4px 0 0 18px; padding: 0; font-size: .85rem; }

.vl-needs-strip { display: flex; gap: 8px; overflow-x: auto; padding: 8px 0; }
.vl-gauge { min-width: 108px; border: 1px solid #e2e2e2; border-radius: 8px; padding: 6px 8px;
  background: #fff; cursor: pointer; flex: 0 0 auto; }
.vl-gauge-bar { height: 6px; border-radius: 3px; background: #eee; margin: 4px 0; overflow: hidden; }
.vl-gauge-fill { height: 100%; border-radius: 3px; }
.vl-ok { background: #16a34a; } .vl-warn { background: #d97706; } .vl-urgent { background: #b3261e; }
.vl-gauge small { color: #666; }

.vl-candidate { border: 1px solid #e2e2e2; border-left-width: 6px; border-radius: 8px;
  padding: 10px 12px; margin-bottom: 10px; background: #fff; cursor: pointer; }
.vl-candidate.vl-highlighted { box-shadow: 0 0 0 2px #2563eb33; }
.vl-candidate h4 { margin: 0 0 2px; font-size: 1rem; }
.vl-candidate .vl-summary { color: #555; font-size: .85rem; }
.vl-tierdot { display: inline-block; width: 10px; height: 10px; border-radius: 5px; margin-right: 6px; }
.vl-warning { color: #b3261e; font-size: .85rem; margin-top: 4px; }
.vl-stops { margin: 6px 0 0; padding-left: 18px; font-size: .85rem; }
.vl-stops li { margin: 2px 0; }
.vl-stops .vl-visited { text-decoration: line-through; color: #888; }

.vl-tonight { border: 1px solid #e2e2e2; border-radius: 8px; padding: 10px 12px;
  margin-bottom: 10px; background: #fff; }
.vl-tonight .vl-summary { color: #555; font-size: .85rem; }
.vl-stay-list { list-style: none; margin: 6px 0 0; padding: 0; font-size: .85rem; }
.vl-stay-row { border-top: 1px solid #f0f0f0; padding: 6px 0; }
.vl-stay-row:first-child { border-top: none; }
.vl-stay-badge { margin-left: 6px; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em;
  background: #16a34a; color: #fff; border-radius: 10px; padding: 1px 7px; }
.vl-stay-weights { margin-top: 6px; display: grid; gap: 4px; }
.vl-stay-weight { display: grid; grid-template-columns: 1fr 120px 34px; align-items: center;
  gap: 8px; font-size: .85rem; }
@media (max-width: 480px) { .vl-stay-weight { grid-template-columns: 1fr 90px 30px; } }

.vl-checkin-bar { position: sticky; bottom: 0; background: #fffffff2; border-top: 1px solid #ddd;
  display: flex; gap: 8px; padding: 10px 12px; z-index: 6; align-items: center; flex-wrap: wrap; }
@media (min-width: 900px) { .vl-checkin-bar { position: static; border: 1px solid #e2e2e2; border-radius: 8px; margin-top: 12px; } }
.vl-checkin-btn { border: 1px solid #ccc; border-radius: 18px; background: #fff; padding: 6px 12px;
  font-size: .85rem; cursor: pointer; white-space: nowrap; }
.vl-checkin-btn:hover { background: #f5f5f5; }
.vl-checkin-btn.vl-urgent-btn { border-color: #b3261e; color: #b3261e; }

.vl-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 20;
  display: flex; align-items: flex-end; justify-content: center; }
@media (min-width: 900px) { .vl-modal-backdrop { align-items: center; } }
.vl-modal { background: #fff; border-radius: 12px 12px 0 0; padding: 16px; width: 100%; max-width: 480px;
  max-height: 80dvh; overflow-y: auto; }
@media (min-width: 900px) { .vl-modal { border-radius: 12px; } }

.vl-sheet-sorts { display: flex; gap: 6px; margin: 8px 0; }
.vl-sheet-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border-top: 1px solid #eee; padding: 8px 0; }
.vl-sheet-row .vl-meta { color: #666; font-size: .8rem; }
.vl-sheet-row.vl-pinned { background: #f0f9ff; }
.vl-sheet-actions { display: flex; gap: 6px; flex-shrink: 0; }
.vl-badge { font-size: .7rem; border-radius: 10px; padding: 1px 6px; border: 1px solid #ccc;
  color: #555; white-space: nowrap; }

.vl-stop-marker { width: 24px; height: 24px; border-radius: 12px; background: #1f2937; color: #fff;
  border: 2px solid #fff; font-size: .75rem; font-weight: 700; cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.vl-stop-marker.vl-stop-visited { background: #9ca3af; }
.vl-position-pin { width: 16px; height: 16px; border-radius: 8px; background: #2563eb;
  border: 3px solid #fff; box-shadow: 0 0 0 4px #2563eb44; animation: vl-pulse 2s infinite; }
@keyframes vl-pulse { 0% { box-shadow: 0 0 0 4px #2563eb44; } 50% { box-shadow: 0 0 0 10px #2563eb11; } 100% { box-shadow: 0 0 0 4px #2563eb44; } }

/* Where the trip started, as distinct from the pulsing "we are here" pin. */
.vl-origin-pin { width: 14px; height: 14px; border-radius: 3px; background: #fff;
  border: 3px solid #1f2937; box-shadow: 0 1px 4px rgba(0,0,0,.4); }

/* An exact-point Target draws no ring, so the pin is all there is of it. */
.vl-target-pin { width: 24px; height: 24px; border-radius: 12px; background: #0f766e; color: #fff;
  border: 2px solid #fff; font-size: .75rem; font-weight: 700; cursor: pointer; padding: 0;
  box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.vl-target-pin-final { background: #b45309; border-radius: 12px 12px 12px 2px; font-size: .8rem; }
.vl-target-pin-selected { outline: 3px solid #0ea5e9; outline-offset: 1px; }
.vl-target-pin-dim { opacity: .45; }

/* Panel tabs: authoring, driving, bookkeeping — one map underneath all three. */
.vl-tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e7eb; margin: 8px 0 10px; }
.vl-tab { flex: 1; background: none; border: none; border-bottom: 2px solid transparent;
  padding: 8px 4px; font-size: .9rem; font-weight: 600; color: #6b7280; cursor: pointer; }
.vl-tab-active { color: #0f766e; border-bottom-color: #0f766e; }

.vl-target-ordinal { color: #6b7280; font-variant-numeric: tabular-nums; min-width: 14px; }
/* The trip's destination: same row shape as a Target, visibly the end of it. */
.vl-target-final { border-color: #b45309; background: #fffbeb; }
.vl-target-final .vl-chip-final { background: #b45309; color: #fff; }
.vl-origin-row { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px;
  border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; }
.vl-origin-row strong { flex: 1; }
.vl-trip-picker { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.vl-trip-picker select { flex: 1; padding: 6px; }

/* A failed basemap must say so rather than render as a silent grey rectangle. */
/* Sits below the digest banner rather than over it. */
.vl-basemap-error { position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 5; max-width: 420px; display: flex; flex-direction: column; gap: 2px;
  background: #fef3c7; border: 1px solid #d97706; border-radius: 8px; padding: 8px 12px;
  font-size: .85rem; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
.vl-basemap-error span { word-break: break-word; }
.vl-basemap-error-hint { color: #6b5200; }
/* Quieter than the basemap error: the map is fine, one optional overlay is not. */
.vl-legal-error { position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 5; max-width: 380px; display: flex; flex-direction: column; gap: 2px;
  background: #f1f5f9; border: 1px solid #94a3b8; border-radius: 8px; padding: 6px 10px;
  font-size: .8rem; box-shadow: 0 2px 8px rgba(0,0,0,.15); }

.vl-toast { position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%); z-index: 30;
  background: #1f2937; color: #fff; border-radius: 8px; padding: 10px 14px; font-size: .9rem;
  display: flex; gap: 12px; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,.3); }
.vl-toast button { background: none; border: none; color: #93c5fd; cursor: pointer; font-weight: 600; }

.vl-offline { background: #fef3c7; border: 1px solid #d97706; border-radius: 8px;
  padding: 6px 10px; font-size: .85rem; margin-bottom: 8px; }

/* Legend and place filter. Rows are addressed by class, never as ".vl-legend div":
   the panel nests now, and a bare descendant selector would flex the wrappers too. */
.vl-legend { position: absolute; bottom: 10px; left: 8px; z-index: 5; background: #ffffffee;
  border-radius: 8px; padding: 6px 10px; font-size: .75rem; border: 1px solid #ddd;
  max-width: 15rem; max-height: calc(100% - 20px); display: flex; flex-direction: column; }
.vl-legend-row { display: flex; align-items: center; gap: 6px; min-height: 22px; }
.vl-legend .vl-line { width: 16px; height: 3px; border-radius: 2px; }
.vl-legend-head { display: flex; align-items: center; gap: 6px; width: 100%; background: none;
  border: none; padding: 0; font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
.vl-legend-head .vl-chip { font-size: .68rem; }
.vl-legend-caret { margin-left: auto; color: #555; }
.vl-legend-body { display: flex; flex-direction: column; min-height: 0; margin-top: 4px; }
.vl-legend-section { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-top: 6px; padding-top: 4px; border-top: 1px solid #e6e6e6; color: #555;
  text-transform: uppercase; letter-spacing: .04em; font-size: .65rem; }
.vl-legend-section:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.vl-legend-all { display: flex; gap: 6px; }
.vl-legend-all button { background: none; border: none; padding: 0; font: inherit;
  color: #2563eb; cursor: pointer; text-transform: none; letter-spacing: 0; }
/* Fourteen categories over a 55dvh map pane needs a floor of its own. */
.vl-legend-list { overflow-y: auto; min-height: 0; margin: 2px 0; }
.vl-legend-list label { cursor: pointer; }
.vl-legend-list input { margin: 0; cursor: pointer; }
.vl-legend-source { color: #555; margin-top: 4px; }
/* The signal swatch is a filled block, not the 3px line the routes use — the
   overlay is an area on the map and the key should read as the same thing. */
.vl-legend-swatch { width: 16px; height: 12px; border-radius: 2px; border: 1px solid #00000022; }
.vl-legend-carrier { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.vl-legend-carrier select { font: inherit; font-size: .72rem; padding: 1px 3px; flex: 1; min-width: 0;
  border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; }
.vl-legend-carrier select:disabled { color: #999; cursor: not-allowed; }
.vl-legend-note { color: #777; font-style: italic; margin: 2px 0; }

/* A land wash reads as an area, so its swatch is a square rather than the
   line-tier bar or the place dot — the shape says which kind of thing it is
   before the colour does. */
.vl-landswatch { display: inline-block; width: 12px; height: 10px; border-radius: 2px;
  margin-right: 4px; opacity: .55; border: 1px solid rgba(0,0,0,.35); }
/* Distinct from the grey .vl-legend-note above: that one says a layer cannot be
   drawn, this one qualifies a layer that is drawn. Both sit in the legend at
   once, so they cannot share a class — the amber is the "read this" tone. */
.vl-legend-advisory { color: #6b5200; font-size: .72rem; line-height: 1.3; margin: 4px 0 2px; }

.vl-popover { position: absolute; z-index: 10; top: 12px; right: 12px; width: 260px;
  background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,.2); }
.vl-popover h4 { margin: 0 0 4px; }
.vl-popover .vl-meta { color: #666; font-size: .8rem; }
.vl-popover .vl-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

/* Anchors: an indented tree, so nesting depth reads as specificity. */
.vl-anchor-row { border: 1px solid #e2e2e2; border-left-width: 4px; border-left-color: #0f766e;
  border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; background: #fff; cursor: pointer; }
.vl-anchor-row.vl-anchor-selected { box-shadow: 0 0 0 2px #0f766e33; }
.vl-anchor-row.vl-anchor-dim { opacity: .55; }
.vl-anchor-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vl-anchor-sub { color: #555; font-size: .8rem; margin-top: 2px; }
.vl-anchor-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.vl-anchor-actions button { font-size: .75rem; padding: 2px 6px; }
.vl-chip { background: #f1f5f9; border-radius: 10px; padding: 1px 7px; font-size: .72rem; color: #334155; }
.vl-chip-warn { background: #fef3c7; color: #92400e; }

.vl-anchor-editor { border: 1px dashed #0f766e; border-radius: 8px; padding: 10px;
  margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.vl-anchor-editor label { display: block; font-size: .8rem; }
.vl-hits { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
.vl-hits button { display: block; width: 100%; text-align: left; font-size: .8rem;
  background: none; border: none; border-bottom: 1px solid #eee; padding: 6px 4px; cursor: pointer; }
.vl-hits .vl-meta { color: #666; }

/* The place picker: three ways in, all visible at once, because which one can
   answer depends on the uplink and the permission rather than on the operator. */
.vl-place-field { display: flex; flex-direction: column; gap: 4px; }
.vl-place-current { display: flex; align-items: baseline; gap: 6px; font-size: .9rem; }
.vl-place-pin { flex-shrink: 0; }
.vl-place-ways { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.vl-place-coords { display: flex; gap: 6px; align-items: flex-end; margin-top: 6px; }

.vl-anchor-detail { border-top: 1px solid #e2e2e2; margin-top: 14px; padding-top: 10px; }
.vl-anchor-detail h4 { margin: 0 0 6px; }
.vl-anchor-detail h5 { margin: 12px 0 4px; font-size: .85rem; }
.vl-anchor-detail label { display: block; font-size: .8rem; margin-bottom: 8px; }
.vl-suggestions { list-style: none; margin: 4px 0 0; padding: 0; }
.vl-suggestions li { display: flex; justify-content: space-between; align-items: center;
  gap: 8px; padding: 4px 0; border-bottom: 1px solid #f1f1f1; font-size: .85rem; }
.vl-suggestions button { font-size: .75rem; padding: 2px 6px; margin-left: 4px; }

/* Drag and drop: the drop indicator has to say which of the two things is
   about to happen — reorder between, or nest into. */
.vl-anchor-tree { min-height: 40px; }
.vl-anchor-row { position: relative; }
.vl-anchor-row[draggable="true"] { cursor: grab; }
.vl-anchor-row.vl-anchor-dragging { opacity: .4; cursor: grabbing; }
.vl-drag-grip { color: #9ca3af; cursor: grab; font-size: .9rem; line-height: 1; user-select: none; }
.vl-anchor-row.vl-drop-into { outline: 2px solid #0f766e; outline-offset: 1px; background: #f0fdfa; }
.vl-anchor-row.vl-drop-before::before,
.vl-anchor-row.vl-drop-after::after {
  content: ""; position: absolute; left: 0; right: 0; height: 3px;
  background: #0f766e; border-radius: 2px; }
.vl-anchor-row.vl-drop-before::before { top: -3px; }
.vl-anchor-row.vl-drop-after::after { bottom: -3px; }
.vl-anchor-tree.vl-drop-root { outline: 2px dashed #0f766e; outline-offset: 4px; border-radius: 8px; }
.vl-drop-hint { color: #94a3b8; font-size: .75rem; margin-top: 6px; }

/* Map handles for the selected anchor. */
.vl-anchor-handle { border-radius: 50%; border: 2px solid #fff; cursor: grab;
  box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.vl-anchor-handle:active { cursor: grabbing; }
.vl-anchor-handle-center { width: 16px; height: 16px; background: #0f766e; }
.vl-anchor-handle-edge { width: 13px; height: 13px; background: #fff; border-color: #0f766e;
  box-shadow: 0 0 0 3px #0f766e33; }
`;
