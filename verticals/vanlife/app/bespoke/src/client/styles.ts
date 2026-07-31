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

.vl-stop-marker { width: 24px; height: 24px; border-radius: 12px; background: #1f2937; color: #fff;
  border: 2px solid #fff; font-size: .75rem; font-weight: 700; cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.vl-stop-marker.vl-stop-visited { background: #9ca3af; }
.vl-position-pin { width: 16px; height: 16px; border-radius: 8px; background: #2563eb;
  border: 3px solid #fff; box-shadow: 0 0 0 4px #2563eb44; animation: vl-pulse 2s infinite; }
@keyframes vl-pulse { 0% { box-shadow: 0 0 0 4px #2563eb44; } 50% { box-shadow: 0 0 0 10px #2563eb11; } 100% { box-shadow: 0 0 0 4px #2563eb44; } }

.vl-toast { position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%); z-index: 30;
  background: #1f2937; color: #fff; border-radius: 8px; padding: 10px 14px; font-size: .9rem;
  display: flex; gap: 12px; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,.3); }
.vl-toast button { background: none; border: none; color: #93c5fd; cursor: pointer; font-weight: 600; }

.vl-offline { background: #fef3c7; border: 1px solid #d97706; border-radius: 8px;
  padding: 6px 10px; font-size: .85rem; margin-bottom: 8px; }

.vl-legend { position: absolute; bottom: 10px; left: 8px; z-index: 5; background: #ffffffdd;
  border-radius: 8px; padding: 6px 10px; font-size: .75rem; border: 1px solid #ddd; }
.vl-legend div { display: flex; align-items: center; gap: 6px; }
.vl-legend .vl-line { width: 16px; height: 3px; border-radius: 2px; }

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

.vl-anchor-detail { border-top: 1px solid #e2e2e2; margin-top: 14px; padding-top: 10px; }
.vl-anchor-detail h4 { margin: 0 0 6px; }
.vl-anchor-detail h5 { margin: 12px 0 4px; font-size: .85rem; }
.vl-anchor-detail label { display: block; font-size: .8rem; margin-bottom: 8px; }
.vl-suggestions { list-style: none; margin: 4px 0 0; padding: 0; }
.vl-suggestions li { display: flex; justify-content: space-between; align-items: center;
  gap: 8px; padding: 4px 0; border-bottom: 1px solid #f1f1f1; font-size: .85rem; }
.vl-suggestions button { font-size: .75rem; padding: 2px 6px; margin-left: 4px; }
`;
