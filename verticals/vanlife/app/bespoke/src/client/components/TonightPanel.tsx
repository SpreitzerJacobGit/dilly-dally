import { useEffect, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import { categoryColor, categoryLabel, stayWeightLabel } from "../map/palette.js";

/**
 * Where tonight is spent — the winner, the runners-up, and the reason every
 * other place was ruled out.
 *
 * Two deliberate choices show up here. First, the ruled-out places stay on the
 * list with their reason rather than vanishing, because "we found nine sites
 * and four need high clearance" is a different message from a short list.
 * Second, moving a slider does not replan: the routed costs were computed when
 * the plan was built, so re-ranking is instant, and only when the top choice
 * actually changes does the panel offer to re-route the day.
 */

export interface StayOptionView {
  poiId: number;
  name: string;
  source: string;
  url: string | null;
  stayKind: string;
  marginalMinutes: number;
  toStayMinutes: number;
  toStayMiles: number;
  arrivalIso: string | null;
  sunsetIso: string | null;
  nightlyCostUsd: number | null;
  hookupElectric: boolean;
  dumpStation: boolean;
  laundryOnSite: boolean;
  showers: boolean;
  access: string;
  confidence: string;
  reservable: string;
  availability: {
    state: string;
    source: string;
    detail: string | null;
    fetchedAt: string;
    lastError: string | null;
  } | null;
  factors: Record<string, number>;
  excludedReason: string | null;
  booked: boolean;
  score: number;
}

function clockOf(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ageOf(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(hours)) return "unknown age";
  if (hours < 1) return "checked just now";
  if (hours < 48) return `checked ${String(Math.round(hours))}h ago`;
  return `checked ${String(Math.round(hours / 24))}d ago`;
}

function costOf(usd: number | null): string {
  if (usd === null) return "price unknown";
  return usd === 0 ? "free" : `$${String(Math.round(usd))}/night`;
}

/**
 * Availability is the only live thing on this screen, so it always arrives with
 * its age attached and never as a bare claim about tonight.
 */
function AvailabilityLine(props: { option: StayOptionView }): JSX.Element | null {
  const a = props.option.availability;
  if (!a) {
    if (props.option.reservable === "required") {
      return <div className="vl-summary">Reservation required — nobody has checked whether there is room.</div>;
    }
    return null;
  }
  const words =
    a.state === "available"
      ? "had room"
      : a.state === "full"
        ? "was full"
        : a.state === "closed"
          ? "was closed"
          : "was unclear";
  return (
    <div className="vl-summary">
      {a.source} said it {words}
      {a.detail ? ` (${a.detail})` : ""} — {ageOf(a.fetchedAt)}
      {a.lastError ? ` · last check failed: ${a.lastError}` : ""}
    </div>
  );
}

function Amenities(props: { option: StayOptionView }): JSX.Element | null {
  const o = props.option;
  const bits = [
    o.hookupElectric ? "power" : null,
    o.showers ? "showers" : null,
    o.laundryOnSite ? "laundry" : null,
    o.dumpStation ? "dump" : null,
  ].filter((b): b is string => b !== null);
  if (bits.length === 0) return null;
  return <span style={{ color: "#888" }}> · {bits.join(", ")}</span>;
}

function StayRow(props: { option: StayOptionView; onBook: (poiId: number) => void; canBook: boolean }): JSX.Element {
  const o = props.option;
  const excluded = o.excludedReason !== null;
  return (
    <li className="vl-stay-row" style={{ opacity: excluded ? 0.6 : 1 }}>
      <span className="vl-tierdot" style={{ background: categoryColor(o.stayKind) }} />
      <span style={{ fontWeight: excluded ? 400 : 600 }}>{o.name}</span>
      {o.booked ? <span className="vl-stay-badge">booked</span> : null}
      <span style={{ color: "#888" }}>
        {" "}
        · {categoryLabel(o.stayKind)} · {costOf(o.nightlyCostUsd)}
      </span>
      <Amenities option={o} />
      <div className="vl-summary">
        {o.marginalMinutes <= 0
          ? "on the way"
          : `+${String(Math.round(o.marginalMinutes))} min off route`}
        {" · arrive "}
        {clockOf(o.arrivalIso)}
        {o.sunsetIso ? ` (sunset ${clockOf(o.sunsetIso)})` : ""}
        {o.access === "unknown" ? " · road not verified" : ""}
        {o.confidence === "unverified" ? " · unverified" : ""}
      </div>
      <AvailabilityLine option={o} />
      {excluded ? <div className="vl-warning">Ruled out — {o.excludedReason}</div> : null}
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        {props.canBook && !o.booked ? (
          <button className="vl-checkin-btn" style={{ padding: "1px 8px" }} onClick={() => { props.onBook(o.poiId); }}>
            we booked this
          </button>
        ) : null}
        {o.url ? (
          <a className="vl-checkin-btn" style={{ padding: "1px 8px" }} href={o.url} target="_blank" rel="noreferrer">
            {o.source} ↗
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function TonightPanel(props: {
  tripId: number;
  planDate: string;
  /** The candidate whose night is being looked at. */
  candidateId: number | null;
  options: StayOptionView[];
  plannedStayPoiId: number | null;
  stayWinnerChanged: boolean;
  onReplan: () => void;
  onChanged: () => void;
}): JSX.Element {
  const weightsQ = trpc.stays.weights.useQuery({ tripId: props.tripId });
  const setWeights = trpc.stays.setWeights.useMutation();
  const book = trpc.stays.book.useMutation();
  const clearBooking = trpc.stays.clearBooking.useMutation();
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (weightsQ.data && draft === null) {
      setDraft(Object.fromEntries(weightsQ.data.weights.map((w) => [w.factor, w.weight])));
    }
  }, [weightsQ.data, draft]);

  const chosen = props.options.find((o) => o.excludedReason === null || o.booked) ?? null;
  const ruledOut = props.options.filter((o) => o.excludedReason !== null);
  const usable = props.options.filter((o) => o.excludedReason === null);

  const commit = (factor: string, weight: number): void => {
    setDraft((d) => ({ ...(d ?? {}), [factor]: weight }));
    setWeights.mutate(
      { tripId: props.tripId, weights: [{ factor, weight }] },
      { onSuccess: () => { props.onChanged(); } },
    );
  };

  return (
    <section className="vl-tonight">
      <h3 style={{ margin: "0 0 4px" }}>Tonight</h3>
      {props.candidateId === null ? (
        <div className="vl-summary">Pick or highlight a route to see where its night would be spent.</div>
      ) : props.options.length === 0 ? (
        <div className="vl-warning">
          No known place to stay within reach of this day&apos;s end. The leg still has to finish somewhere, but that
          point is a coordinate, not a place.
        </div>
      ) : (
        <>
          {chosen ? (
            <div style={{ marginBottom: 6 }}>
              <span className="vl-tierdot" style={{ background: categoryColor(chosen.stayKind) }} />
              <strong>{chosen.name}</strong>
              <span style={{ color: "#888" }}>
                {" "}
                · {categoryLabel(chosen.stayKind)} · {costOf(chosen.nightlyCostUsd)} · arrive {clockOf(chosen.arrivalIso)}
              </span>
            </div>
          ) : (
            <div className="vl-warning">
              Every place near this day&apos;s end was ruled out — see the reasons below.
            </div>
          )}

          {props.stayWinnerChanged ? (
            <div className="vl-warning">
              These weights now favour a different place than this route drives to.{" "}
              <button className="vl-checkin-btn" style={{ padding: "1px 8px" }} onClick={props.onReplan}>
                re-route the day
              </button>
            </div>
          ) : null}

          {props.plannedStayPoiId !== null && chosen?.booked ? (
            <button
              className="vl-checkin-btn"
              style={{ padding: "1px 8px", marginBottom: 6 }}
              onClick={() => {
                clearBooking.mutate(
                  { tripId: props.tripId, planDate: props.planDate },
                  { onSuccess: () => { props.onChanged(); } },
                );
              }}
            >
              clear the booking
            </button>
          ) : null}

          <ul className="vl-stay-list">
            {usable.map((o) => (
              <StayRow
                key={o.poiId}
                option={o}
                canBook
                onBook={(poiId) => {
                  book.mutate(
                    { tripId: props.tripId, planDate: props.planDate, poiId, state: "booked" },
                    { onSuccess: () => { props.onChanged(); } },
                  );
                }}
              />
            ))}
          </ul>

          {ruledOut.length > 0 ? (
            <details>
              <summary className="vl-summary">
                {String(ruledOut.length)} ruled out — why
              </summary>
              <ul className="vl-stay-list">
                {ruledOut.map((o) => (
                  <StayRow key={o.poiId} option={o} canBook={false} onBook={() => undefined} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      <details open={open} onToggle={(e) => { setOpen((e.target as HTMLDetailsElement).open); }}>
        <summary className="vl-summary">What matters tonight</summary>
        {draft === null ? (
          <div className="vl-summary">Loading…</div>
        ) : (
          <div className="vl-stay-weights">
            {(weightsQ.data?.weights ?? []).map((w) => (
              <label key={w.factor} className="vl-stay-weight">
                <span>{stayWeightLabel(w.factor)}</span>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={draft[w.factor] ?? w.weight}
                  onChange={(e) => { setDraft({ ...draft, [w.factor]: Number(e.target.value) }); }}
                  onMouseUp={(e) => { commit(w.factor, Number((e.target as HTMLInputElement).value)); }}
                  onTouchEnd={(e) => { commit(w.factor, Number((e.target as HTMLInputElement).value)); }}
                />
                <span style={{ color: "#888", minWidth: 28, textAlign: "right" }}>
                  {(draft[w.factor] ?? w.weight).toFixed(1)}
                </span>
              </label>
            ))}
            <div className="vl-summary">
              Zero rules a kind out entirely. These re-rank the places already found — they never send us further off
              route than the {String(weightsQ.data?.maxDetourMinutes ?? 30)}-minute cap.
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
