# Dilly-Dally Van-Life Planner — Requirements

Behavioral requirements only. No component names, no versions, no architecture.

## Summary

Dilly-Dally is the planning layer for a couple living and working from a van. Given an Origin and a final Target (say, Portland to Las Vegas), it proposes a handful of candidate routes each day — from "most direct" down to side-quest-tier detours — all inside a deviation budget of twice the straight-shot duration. It tracks the recurring needs of van life (food, gas, water, laundry, trash, waste-water, electric hookup) as estimated levels that drain with time and miles, and it weaves the stops that satisfy them into the day's routes before anything runs dry or overflows. Both operators are equals: either can check in a chore, pick a route, or reshape the plan. A morning digest summarizes progress and looming deadlines. The application plans; it never navigates turn-by-turn.

## Trips, Origin & Targets {#trips}

A trip is an **Origin** and an ordered list of **Targets**. The last Target is the final destination; the ones before it are the regions and places the route is required to pass through.

`[TRIP-1]` Creating a trip with an Origin and a final Target computes and shows the direct drive duration, and the deviation budget shown everywhere equals exactly twice that duration.
`[TRIP-2]` Targets can be added to a trip, reordered, and marked visited or skipped; a visited or skipped Target no longer appears as a stop in newly generated candidates.
`[TRIP-3]` Exactly one trip is active at a time; the needs outlook, the morning digest, and place refreshing all follow the active trip, and completing a trip archives it with its history intact.
`[TRIP-4]` The planning screen shows progress toward the final Target and how much of the deviation budget has been spent, and these figures change only as driving is recorded — never by the mere passage of time.
`[TRIP-5]` An operator can set the current position ("we are here"); plans generated afterwards start from that position.
`[TRIP-11]` Anywhere a location is chosen — the Origin, the final Target, a Target, or the current position — it can be given as the device's own location, as a city or address searched by name, or as typed coordinates; choosing the device's location names it as a place, and still records the position when it cannot be named.
`[TRIP-6]` A Target can be given a radius, becoming an area the route must pass through; every generated candidate and its projected continuation enter that area, and the app states which concrete place inside it was chosen, or admits that none was known.
`[TRIP-7]` An area Target can be narrowed by promoting a place inside it into a nested Target; the narrower one replaces its parent in routing, and removing it restores the parent's broader choice.
`[TRIP-8]` Any trip can be selected for viewing without activating it, and the selection survives a reload; while a non-active trip is being viewed the application says plainly that needs, check-ins, and the digest still follow the active trip.
`[TRIP-9]` A trip's name, Origin, and final Target can be changed; changing the Origin or the final Target resets the frozen baseline, so the deviation budget is recomputed from the new direct duration rather than kept from the old one, while renaming leaves it untouched.
`[TRIP-10]` A trip that is not active can be deleted along with its plans, marks, and history; the active trip cannot be deleted until it is completed.

## Recurring needs & levels {#needs}

Every recurring need is tracked one of two ways: as an estimated level with a capacity, a consumption rate, and a threshold; or as a date it falls due. Estimates are honest about being estimates.

`[NEED-1]` The statuses screen lists every tracked need with its unit, capacity, current estimated level, consumption rate, and projected time until it runs dry or overflows.
`[NEED-2]` A need's displayed level is always labeled as an estimate with the time it was computed from, and is derived from the last check-in, the configured rate, and elapsed time and recorded miles — the application never presents it as a measured value.
`[NEED-3]` A need projected to run dry or overflow before its next planned service stop is flagged as urgent everywhere it appears.
`[NEED-4]` Editing a need's capacity, rate, or threshold immediately changes every projection; the application may suggest a refined rate derived from check-in history, and a suggestion never applies itself — an operator must accept it.
`[NEED-5]` Work internet appears as a tracked concern on the statuses screen but never generates route stops — it is a checklist item, not a routing driver.
`[NEED-6]` Tapping a tracked need that drives routing lists the places that can service it, each showing how far it is from the current position and how many minutes it would add to today's chosen route, orderable by either measure; the list is drawn from places already stored on the van server, so it works with no internet.
`[NEED-7]` Adding a place from that list pins it for the trip and regenerates the day's candidates so it appears as a stop wherever it is feasible; a place already pinned is shown as pinned and can be released from the same row.
`[NEED-8]` The statuses screen has a default view for reading levels and recording check-ins, and an edit mode that manages the tracked set itself; creation, renaming, retuning, archiving and deletion live only in edit mode, so none of them can be reached by a mistap on the daily screen.
`[NEED-9]` A need is tracked either by level — a capacity that drains at a rate — or by date, meaning it simply falls due on a day with no capacity and no drain; either mode can be created directly, and an existing need can be switched between them without losing its check-in history.
`[NEED-10]` A date-tracked need becomes warn and then urgent a configurable number of days before it falls due, and never generates route stops on its own; when it names a repeat interval, a check-in rolls its due date forward by that interval, and undoing that check-in rolls it back.
`[NEED-11]` A need is archived rather than deleted by default: archiving hides it from every screen and projection while keeping its history, and it can be restored. Permanent deletion, which also removes every check-in and rate recorded against it, is offered only for an already-archived need and only behind a confirmation that names what is lost.

## Check-ins {#checkins}

Levels change only through check-ins. One tap records the common case; a quantity refines it.

`[CHK-1]` A one-tap check-in ("dumped tanks", "filled water", "grocery run done") records the event as a full reset of that need; an optional quantity records a partial fill or dump instead.
`[CHK-2]` No control anywhere edits a level number directly — levels change only through check-ins (including an explicit "set level" correction check-in), and a mistake is corrected by recording another check-in.
`[CHK-3]` Every check-in records who recorded it and when, and appears in that need's history newest first.
`[CHK-4]` Recording a check-in immediately updates the need's level, its projected deadline, and any urgency flags derived from them.

## POI aggregation {#poi}

Candidate stops come from public sources into a local store, honestly attributed and honestly bookkept.

`[POI-1]` A sources screen lists every place source in exactly one honest state — "Not configured", "Never checked", "Healthy", or "Erroring" with the error visible — and shows last-checked and last-succeeded times as "never" until a fetch has actually happened.
`[POI-2]` A place fetched twice — by re-checking, restarting, or overlapping regions — appears in the application once, never duplicated.
`[POI-3]` Every place shows which source it came from, and where the source has its own page for the place, a link out to it; the application never rehosts another service's content.
`[POI-4]` An operator can pin or reject any suggested place for the trip being viewed: a rejected place never reappears in suggestions for that trip, and a pinned place is included in generated plans whenever it is feasible within the budget.
`[POI-5]` Source API keys are entered through the application and take effect without a restart; a source whose key is missing reports "Not configured" while every other source keeps working.

## Route candidates {#routes}

Each day the application proposes candidate routes across a spectrum of ambition, every one honest about the budget and the needs it does or does not cover.

`[ROUTE-1]` Each day the planning screen offers three to five candidate routes spanning a spectrum from most-direct to side-quest tier, and every candidate keeps the total remaining trip duration within the deviation budget.
`[ROUTE-2]` Every candidate weaves in service stops so that no tracked need is projected to run dry or overflow along it; each stop is annotated with the needs it services, and when no reachable place can satisfy a need in time, the candidate says so with an urgent flag rather than hiding the gap.
`[ROUTE-3]` Selecting a candidate records it as the day's plan; the day's other candidates remain viewable as history and are never silently deleted.
`[ROUTE-4]` A chosen leg can be handed off to Google Maps as a link that opens the leg's stops in order; the application itself never navigates turn-by-turn.
`[ROUTE-5]` Regenerating the day's candidates without any new check-in, selection, or position change returns the same candidates — plans do not reshuffle on their own.
`[ROUTE-6]` Marking a stop of the selected route as visited records progress; candidates generated afterwards start from the recorded position.
`[ROUTE-7]` When route computation is unavailable, the planning screen still shows the last generated plan clearly marked as stale, with a visible message — never a blank screen or a silent failure.
`[ROUTE-8]` Candidates prefer stops that share a trip: a place worth stopping for that sits beside a planned service stop is chosen over an equally good one far from it, and where two places servicing the same need cost nearly the same detour, the one nearest the day's best sights wins — never at the cost of dropping a service stop a need requires, exceeding the deviation budget, or changing the plan when nothing else changed.

## The planning screen {#map}

One screen: the map as the primary surface, with the Origin and Targets list, today's candidates, and the trip's numbers beside it.

`[MAP-1]` Today's candidates render on the map in role-coded colors with a legend, each with its projected continuation to the final Target drawn in gray behind it, so zooming out shows the alternative futures spread and reconverge on the destination.
`[MAP-2]` Below or beside the map, a detail list describes each candidate — role, drive time, deviation, stops, and highlights — and selecting a candidate in either the list or the map highlights it in both.
`[MAP-3]` The map's base imagery is served by the application's own server, so the map renders when the only reachable host is the van server.
`[MAP-4]` Tapping a stop or place on the map or in a list shows its details, including its source attribution and any link out.
`[MAP-5]` The Origin and every Target are visible on the map — areas as shaded regions, exact points as numbered pins with the final one marked — and selecting one in the list or on the map selects it in both and brings it into view.
`[MAP-6]` Targets are created, moved, resized, reordered, narrowed, and deleted from the planning screen itself; no separate screen is needed to shape the route.

## Interest profile {#interests}

Side-quest suggestions are biased by configurable interest weights blended with popularity.

`[PROF-1]` Category interest weights are editable and arrive seeded with defaults; changing a weight re-ranks side-quest suggestions the next time candidates are generated.
`[PROF-2]` A category whose weight is set to zero produces no side-quest suggestions, no matter how popular its places are; among the rest, a heavily weighted category outranks a lightly weighted one of similar popularity.

## Daily digest {#digest}

One digest each morning: progress, today's options, and what needs attention — with an important-only cut that is honest when nothing is important.

`[DIG-1]` Each morning at the configured hour the application publishes exactly one digest for the day — never more than one, even across restarts — summarizing trip progress, today's candidates, and need deadlines within the next two days.
`[DIG-2]` The digest has a full summary and an important-only cut; when nothing is urgent, the important-only cut says so plainly instead of inventing urgency.
`[DIG-3]` The morning digest is always readable on the planning screen as a dismissible banner, and dismissing it on one device does not dismiss it for the other operator.
`[DIG-4]` Push delivery reports itself honestly: an unconfigured push channel shows "Not configured" while the in-app digest keeps working, and a failed delivery is visible with its error — the application never claims a digest was pushed that was not.

## Offline & remote {#offline}

The van server is the source of truth; the internet is optional.

`[OFF-1]` With no internet connection, the planning screen still shows the current plan, need levels, and map, and plans can still be regenerated — only place refreshing and push delivery degrade, each reporting its state honestly.
`[OFF-2]` The map never fetches base imagery from a third-party service at runtime — an installation with no internet renders the same map as one with it.
`[OFF-3]` When route computation is unavailable, the places that can service a need are still listed and ranked by distance, and the added-time figures say plainly that they are estimates rather than routed drive times.
`[OFF-4]` A place searched for by name once is findable again with no internet connection, and the app says the answer came from memory; when a place has never been looked up and there is no connection, the search says it is unavailable rather than answering that no such place exists, and the device-location and coordinate paths remain open.

## First-run experience

The application arrives with a realistic seeded trip — Portland, OR to Las Vegas, NV, routed through California via an Eastern Sierra area Target — two operator accounts, all seven needs configured with plausible capacities, rates, and part-consumed levels, a short check-in history, and a set of seeded places along the corridor. A first-time visitor can sign in and immediately see candidates on the map, a meaningful needs outlook, and a digest preview. Exact seeded contents are specified alongside the seed data itself.
