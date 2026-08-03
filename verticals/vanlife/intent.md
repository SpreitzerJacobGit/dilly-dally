# Dilly-Dally — Intent

## 1. What this application is
Dilly-Dally is the planning layer for a couple living and working from a van. Given an Origin and a final Target (say, Portland to Las Vegas), it proposes a handful of candidate routes each day — from "most direct" down to side-quest-tier detours — all inside a deviation budget of twice the straight-shot duration. It tracks the recurring needs of van life (food, gas, water, laundry, trash, waste-water, electric hookup) as estimated levels that drain with time and miles, and it weaves the stops that satisfy them into the day's routes before anything runs dry or overflows. Both operators are equals: either can check in a chore, pick a route, or reshape the plan. A morning digest summarizes progress and looming deadlines. The application plans; it never navigates turn-by-turn.

## 2. Access

The application is reachable at its base URL with no setup. These accounts exist and work on first run:

- **jacob@vanlife.test / van-demo-2026** — role: operator
- **partner@vanlife.test / van-demo-2026** — role: operator

`[ACC-1]` Signing in with any credential listed above succeeds on the first attempt and lands on the planning screen.
`[ACC-2]` Visiting any application page while signed out shows the sign-in page instead.
`[ACC-3]` After signing in, reloading the page keeps the user signed in.
`[ACC-4]` The "Sign out" control is visible on every page and returns to the sign-in page.

## 3. General behavior

`[SYS-1]` Data written by one request is visible to every subsequent request, including after the application restarts.
`[SYS-2]` Signing in with valid credentials succeeds on the first attempt and the session persists across page reloads until it expires or the user signs out.
`[SYS-3]` A user without the required role can neither see nor successfully invoke an action reserved for that role.
`[SYS-4]` Working accounts exist on first run — the login page is never a wall.
`[SYS-5]` Every screen of the application is reachable from the navigation, and navigation entries reserved for a role are invisible to everyone else.
`[SYS-6]` Invalid input is rejected with a visible message next to the offending field, before anything is sent to the server.
`[SYS-7]` A table with data shows every row it was given; a table with none says so in words rather than showing a blank area.
`[SYS-8]` The basemap renders entirely from locally served assets — no request leaves the host for tiles, glyphs, or sprites.
`[SYS-9]` A missing tile archive is reported honestly through the status endpoint rather than rendering as a silently blank map.
`[SYS-10]` A submission either fully succeeds or fully fails with a visible reason — data is never half-written.
`[SYS-11]` Every POI source reports itself in exactly one honest state — unconfigured, never-checked, healthy, or erroring with the error and time visible — and never claims a fetch it has not performed.
`[SYS-12]` Every record handed to the application carries a stable (source, sourceId) identity, so re-fetching a region, restarting, or overlapping regions never forces a duplicate on the domain.
`[SYS-13]` An item at or below its threshold is flagged, an item above it is not, and the most urgent shortfalls are listed first.
`[SYS-14]` A listing shows exactly the records matching its filters, and searching narrows it to matching records rather than doing nothing.
`[SYS-15]` A headline number on the planning screen equals what the underlying listing shows when opened.
`[SYS-16]` A message published with a dedupe key is delivered at most once, even across restarts; a failed attempt does not burn the key, so retries remain possible.
`[SYS-17]` Every delivery attempt is recorded with its outcome; a failed delivery is visible from the running application with its error — the application never claims a notification was sent that was not.
`[SYS-18]` The application serves its interface and its API from one address, and refuses to accept traffic until its data is fully prepared.
`[SYS-19]` Starting the delivered artifact from nothing yields a working application at the published address, with its data on a volume that survives upgrades.
`[SYS-20]` A running installation can always report whether it is healthy and what has recently gone wrong, from a browser, with no server access.
`[SYS-21]` Recurring background work reports when it last ran, when it last succeeded, and what last went wrong — retrievable from the running application at any time.
`[SYS-22]` Configuration an operator saves through the application survives restarts and upgrades, and a corrupted record surfaces as a visible error rather than silently pretending to be unconfigured.

## 4. Trips, Origin & Targets
A trip is an **Origin** and an ordered list of **Targets**. The last Target is the final destination; the ones before it are the regions and places the route is required to pass through.

`[TRIP-1]` Creating a trip with an Origin and a final Target computes and shows the direct drive duration, and the deviation budget shown everywhere equals exactly twice that duration.
`[TRIP-2]` Targets can be added to a trip, reordered, and marked visited or skipped; a visited or skipped Target no longer appears as a stop in newly generated candidates.
`[TRIP-3]` Exactly one trip is active at a time; the needs outlook, the morning digest, and place refreshing all follow the active trip, and completing a trip archives it with its history intact.
`[TRIP-4]` The planning screen shows progress toward the final Target and how much of the deviation budget has been spent, and these figures change only as driving is recorded — never by the mere passage of time.
`[TRIP-5]` An operator can set the current position manually ("we are here"); plans generated afterwards start from that position.
`[TRIP-6]` A Target can be given a radius, becoming an area the route must pass through; every generated candidate and its projected continuation enter that area, and the app states which concrete place inside it was chosen, or admits that none was known.
`[TRIP-7]` An area Target can be narrowed by promoting a place inside it into a nested Target; the narrower one replaces its parent in routing, and removing it restores the parent's broader choice.
`[TRIP-8]` Any trip can be selected for viewing without activating it, and the selection survives a reload; while a non-active trip is being viewed the application says plainly that needs, check-ins, and the digest still follow the active trip.
`[TRIP-9]` A trip's name, Origin, and final Target can be changed; changing the Origin or the final Target resets the frozen baseline, so the deviation budget is recomputed from the new direct duration rather than kept from the old one, while renaming leaves it untouched.
`[TRIP-10]` A trip that is not active can be deleted along with its plans, marks, and history; the active trip cannot be deleted until it is completed.

## 5. Recurring needs & levels
Every recurring need is tracked as an estimated level with a capacity, a consumption rate, and a threshold. Estimates are honest about being estimates.

`[NEED-1]` The needs screen lists every tracked need with its unit, capacity, current estimated level, consumption rate, and projected time until it runs dry or overflows.
`[NEED-2]` A need's displayed level is always labeled as an estimate with the time it was computed from, and is derived from the last check-in, the configured rate, and elapsed time and recorded miles — the application never presents it as a measured value.
`[NEED-3]` A need projected to run dry or overflow before its next planned service stop is flagged as urgent everywhere it appears.
`[NEED-4]` Editing a need's capacity, rate, or threshold immediately changes every projection; the application may suggest a refined rate derived from check-in history, and a suggestion never applies itself — an operator must accept it.
`[NEED-5]` Work internet appears as a tracked concern on the needs screen but never generates route stops — it is a checklist item, not a routing driver.
`[NEED-6]` Tapping a tracked need that drives routing lists the places that can service it, each showing how far it is from the current position and how many minutes it would add to today's chosen route, orderable by either measure; the list is drawn from places already stored on the van server, so it works with no internet.
`[NEED-7]` Adding a place from that list pins it for the trip and regenerates the day's candidates so it appears as a stop wherever it is feasible; a place already pinned is shown as pinned and can be released from the same row.

## 6. Check-ins
Levels change only through check-ins. One tap records the common case; a quantity refines it.

`[CHK-1]` A one-tap check-in ("dumped tanks", "filled water", "grocery run done") records the event as a full reset of that need; an optional quantity records a partial fill or dump instead.
`[CHK-2]` No control anywhere edits a level number directly — levels change only through check-ins (including an explicit "set level" correction check-in), and a mistake is corrected by recording another check-in.
`[CHK-3]` Every check-in records who recorded it and when, and appears in that need's history newest first.
`[CHK-4]` Recording a check-in immediately updates the need's level, its projected deadline, and any urgency flags derived from them.

## 7. POI aggregation
Candidate stops come from public sources into a local store, honestly attributed and honestly bookkept.

`[POI-1]` A sources screen lists every place source in exactly one honest state — "Not configured", "Never checked", "Healthy", or "Erroring" with the error visible — and shows last-checked and last-succeeded times as "never" until a fetch has actually happened.
`[POI-2]` A place fetched twice — by re-checking, restarting, or overlapping regions — appears in the application once, never duplicated.
`[POI-3]` Every place shows which source it came from, and where the source has its own page for the place, a link out to it; the application never rehosts another service's content.
`[POI-4]` An operator can pin or reject any suggested place for the trip being viewed: a rejected place never reappears in suggestions for that trip, and a pinned place is included in generated plans whenever it is feasible within the budget.
`[POI-5]` Source API keys are entered through the application and take effect without a restart; a source whose key is missing reports "Not configured" while every other source keeps working.

## 8. Route candidates
Each day the application proposes candidate routes across a spectrum of ambition, every one honest about the budget and the needs it does or does not cover.

`[ROUTE-1]` Each day the planning screen offers three to five candidate routes spanning a spectrum from most-direct to side-quest tier, and every candidate keeps the total remaining trip duration within the deviation budget.
`[ROUTE-2]` Every candidate weaves in service stops so that no tracked need is projected to run dry or overflow along it; each stop is annotated with the needs it services, and when no reachable place can satisfy a need in time, the candidate says so with an urgent flag rather than hiding the gap.
`[ROUTE-3]` Selecting a candidate records it as the day's plan; the day's other candidates remain viewable as history and are never silently deleted.
`[ROUTE-4]` A chosen leg can be handed off to Google Maps as a link that opens the leg's stops in order; the application itself never navigates turn-by-turn.
`[ROUTE-5]` Regenerating the day's candidates without any new check-in, selection, or position change returns the same candidates — plans do not reshuffle on their own.
`[ROUTE-6]` Marking a stop of the selected route as visited records progress; candidates generated afterwards start from the recorded position.
`[ROUTE-7]` When route computation is unavailable, the planning screen still shows the last generated plan clearly marked as stale, with a visible message — never a blank screen or a silent failure.
`[ROUTE-8]` Candidates prefer stops that share a trip: a place worth stopping for that sits beside a planned service stop is chosen over an equally good one far from it, and where two places servicing the same need cost nearly the same detour, the one nearest the day's best sights wins — never at the cost of dropping a service stop a need requires, exceeding the deviation budget, or changing the plan when nothing else changed.

## 9. The planning screen
One screen: the map as the primary surface, with the Origin and Targets list, today's candidates, and the trip's numbers beside it.

`[MAP-1]` Today's candidates render on the map in role-coded colors with a legend, each with its projected continuation to the final Target drawn in gray behind it, so zooming out shows the alternative futures spread and reconverge on the destination.
`[MAP-2]` Below or beside the map, a detail list describes each candidate — role, drive time, deviation, stops, and highlights — and selecting a candidate in either the list or the map highlights it in both.
`[MAP-3]` The map's base imagery is served by the application's own server, so the map renders when the only reachable host is the van server.
`[MAP-4]` Tapping a stop or place on the map or in a list shows its details, including its source attribution and any link out.
`[MAP-5]` The Origin and every Target are visible on the map — areas as shaded regions, exact points as numbered pins with the final one marked — and selecting one in the list or on the map selects it in both and brings it into view.
`[MAP-6]` Targets are created, moved, resized, reordered, narrowed, and deleted from the planning screen itself; no separate screen is needed to shape the route.

## 10. Legal camping overlay
Where dispersed camping is permitted, shown as two separate land layers — BLM ownership and USFS road corridors — because they are different legal regimes and a single merged "legal" answer could not be audited. The overlay is optional data, prepared out of band; an installation without it behaves normally and says so.

`[LEGAL-1]` The map can shade BLM open land and USFS forest-road camping corridors as two distinct layers, each switched on and off independently from the legend, with the choice remembered across reloads.
`[LEGAL-2]` A corridor whose width is an assumed distance rather than a published one is drawn differently from one whose distance was actually looked up, and the legend says which is which — the application never presents an assumption as a published rule.
`[LEGAL-3]` The legend states that unshaded land means "unverified", never "no camping here", and that the overlay is advisory rather than a guarantee.
`[LEGAL-4]` The overlay is served by the application's own server from local data, so it renders with no internet connection, exactly like the base imagery.
`[LEGAL-5]` An installation that has not built the overlay says so plainly on the status screen and offers no legend switches for it, rather than showing an empty layer that reads as "nowhere is legal".
`[LEGAL-6]` The status screen reports when the overlay was built, how many forests have a published camping distance, and the assumed distance used everywhere else.
`[LEGAL-7]` A failure to load the overlay is reported as an overlay problem and never as a basemap problem, so a broken optional layer cannot be mistaken for a broken map.

## 11. Interest profile
Side-quest suggestions are biased by configurable interest weights blended with popularity.

`[PROF-1]` Category interest weights are editable and arrive seeded with defaults; changing a weight re-ranks side-quest suggestions the next time candidates are generated.
`[PROF-2]` A category whose weight is set to zero produces no side-quest suggestions, no matter how popular its places are; among the rest, a heavily weighted category outranks a lightly weighted one of similar popularity.

## 12. Daily digest
One digest each morning: progress, today's options, and what needs attention — with an important-only cut that is honest when nothing is important.

`[DIG-1]` Each morning at the configured hour the application publishes exactly one digest for the day — never more than one, even across restarts — summarizing trip progress, today's candidates, and need deadlines within the next two days.
`[DIG-2]` The digest has a full summary and an important-only cut; when nothing is urgent, the important-only cut says so plainly instead of inventing urgency.
`[DIG-3]` The morning digest is always readable on the planning screen as a dismissible banner, and dismissing it on one device does not dismiss it for the other operator.
`[DIG-4]` Push delivery reports itself honestly: an unconfigured push channel shows "Not configured" while the in-app digest keeps working, and a failed delivery is visible with its error — the application never claims a digest was pushed that was not.

## 13. Offline & remote
The van server is the source of truth; the internet is optional.

`[OFF-1]` With no internet connection, the planning screen still shows the current plan, need levels, and map, and plans can still be regenerated — only place refreshing and push delivery degrade, each reporting its state honestly.
`[OFF-2]` The map never fetches base imagery from a third-party service at runtime — an installation with no internet renders the same map as one with it.
`[OFF-3]` When route computation is unavailable, the places that can service a need are still listed and ranked by distance, and the added-time figures say plainly that they are estimates rather than routed drive times.

## Seed data on first run

`[SEED-1]` One active trip exists: "Portland → Las Vegas", with Origin Portland, OR and final Target Las Vegas, NV, plus one pending 110-mile area Target, "Eastern Sierra / US-395 corridor", that every generated route must pass through; it resolves automatically to the best-scoring place inside it and can be narrowed to a specific one.
`[SEED-2]` The needs screen lists exactly 8 needs.
`[SEED-3]` Food & groceries: capacity 7 days, consumes about 1 days/day, currently not flagged.
`[SEED-4]` Fuel: capacity 30 gal, consumes about 0.067 gal/mile, currently not flagged.
`[SEED-5]` Fresh water: capacity 40 gal, consumes about 6 gal/day, currently not flagged.
`[SEED-6]` Battery: capacity 100 %, consumes about 25 %/day, currently not flagged.
`[SEED-7]` Laundry: capacity 3 loads, consumes about 0.25 loads/day, currently flagged "warn".
`[SEED-8]` Trash: capacity 4 bags, consumes about 0.5 bags/day, currently not flagged.
`[SEED-9]` Waste water: capacity 30 gal, consumes about 5 gal/day, currently flagged "warn".
`[SEED-10]` Work internet: capacity 1 days, consumes about 0 days/day, currently not flagged — tracked as a checklist item, never generating route stops.
`[SEED-11]` Exactly 29 seeded places exist along the corridor, all attributed to the "manual" source.
`[SEED-12]` Among them: 5 scenic places (including Crater Lake Rim Village) and 2 bouldering areas (including Buttermilks Boulders).
`[SEED-13]` Interest weights arrive seeded for hike, boulder, campground, bike, scenic, family — hike highest at 1.5.
`[SEED-14]` No digest exists until the first morning generation or an explicit send — the digest banner honestly shows nothing rather than a made-up summary.
