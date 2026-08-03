import { useEffect, useRef, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import {
  coordLabel,
  readDeviceFix,
  splitPlaceName,
  type GeocodeHit,
  type GeolocationFailure,
} from "../lib/geocode.js";

/**
 * Pick a place three ways: where we are, or a name — a city, a region, or a
 * street address — or, when nothing else can answer, typed coordinates.
 *
 * All three are offered at once rather than behind a mode switch, because which
 * one works is not the operator's decision to make in advance: the device fix
 * needs a secure context and a permission, the search needs the uplink or a
 * remembered answer, and coordinates always work. The last of those is why the
 * fallback stays visible after a failure instead of the field going quietly
 * empty and looking like the place does not exist.
 */

export interface GeocodeFieldProps {
  label: string;
  placeholder?: string;
  /** Called with a chosen place, however it was arrived at. */
  onPick: (hit: GeocodeHit) => void;
  /** The current selection, shown so the field says what it holds. */
  value?: string | null;
  autoFocus?: boolean;
  /** Bias ranking toward the van's own position; never filters results. */
  near?: { lat: number; lng: number } | null;
}

export function GeocodeField(props: GeocodeFieldProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  const [locating, setLocating] = useState(false);
  const [geoFailure, setGeoFailure] = useState<GeolocationFailure | null>(null);

  const utils = trpc.useUtils();
  // A ref, not state: a slow reverse lookup that resolves after the operator
  // has moved on must not overwrite a newer pick.
  const pickSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const ready = debounced.length >= 3;
  const searchQ = trpc.places.search.useQuery(
    { query: debounced, limit: 5, ...(props.near ? { near: props.near } : {}) },
    { enabled: ready, staleTime: 60_000, retry: false },
  );

  const hits = ready ? (searchQ.data?.hits ?? []) : [];
  const lookupError = ready ? (searchQ.data?.error ?? (searchQ.isError ? "place search unreachable" : null)) : null;
  const staleHits = Boolean(searchQ.data?.stale);
  const searching = ready && searchQ.isFetching;

  const clearSearch = (): void => {
    setSearch("");
    setDebounced("");
  };

  const submitManual = (): void => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    if (la < -90 || la > 90 || ln < -180 || ln > 180) return;
    props.onPick({
      name: search.trim() || coordLabel(la, ln),
      lat: la,
      lng: ln,
      suggestedRadiusMiles: 25,
    });
    clearSearch();
  };

  /**
   * Read the device fix, then try to name it. A naming failure is cosmetic —
   * the fix is accepted either way, labelled with its coordinates. Losing a
   * good position because the uplink could not pretty-print it would be
   * exactly backwards.
   */
  const useMyLocation = async (): Promise<void> => {
    setLocating(true);
    setGeoFailure(null);
    const seq = ++pickSeq.current;

    const { fix, failure } = await readDeviceFix();
    if (!fix) {
      if (seq === pickSeq.current) {
        setGeoFailure(failure);
        setManual(true); // the coordinate path is the way out of every geolocation failure
        setLocating(false);
      }
      return;
    }

    let name = coordLabel(fix.lat, fix.lng);
    try {
      const named = await utils.client.places.reverse.query({ lat: fix.lat, lng: fix.lng });
      if (named.name) name = named.name;
    } catch {
      // Keep the coordinate label — see above.
    }

    if (seq !== pickSeq.current) return;
    props.onPick({ name, lat: fix.lat, lng: fix.lng, suggestedRadiusMiles: 25 });
    setLat(fix.lat.toFixed(6));
    setLng(fix.lng.toFixed(6));
    clearSearch();
    setLocating(false);
  };

  return (
    <div className="vl-place-field">
      {props.value ? (
        <div className="vl-place-current" aria-live="polite">
          <span className="vl-place-pin" aria-hidden="true">
            📍
          </span>
          <strong>{props.value}</strong>
        </div>
      ) : null}

      <label>
        {props.label}
        <input
          type="search"
          placeholder={props.placeholder ?? "City, address, or place — e.g. Bishop, CA"}
          value={search}
          autoFocus={props.autoFocus}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>

      <div className="vl-place-ways">
        <button type="button" className="vl-checkin-btn" onClick={() => void useMyLocation()} disabled={locating}>
          {locating ? "Locating…" : "📍 Use my location"}
        </button>
        {!manual ? (
          <button type="button" className="vl-checkin-btn" onClick={() => setManual(true)}>
            Enter coordinates
          </button>
        ) : null}
      </div>

      {searching ? <small>searching…</small> : null}

      {geoFailure ? (
        <div className="vl-offline" style={{ margin: "6px 0" }}>
          {geoFailure.message}
        </div>
      ) : null}

      {lookupError ? (
        <div className="vl-offline" style={{ margin: "6px 0" }}>
          Place search unavailable ({lookupError}) — use your location, or enter coordinates.
        </div>
      ) : null}

      {staleHits ? (
        <div className="vl-offline" style={{ margin: "6px 0" }}>
          Offline — showing places this van has looked up before.
        </div>
      ) : null}

      {hits.length > 0 ? (
        <ul className="vl-hits">
          {hits.map((h) => {
            const { head, rest } = splitPlaceName(h.name);
            return (
              <li key={`${String(h.lat)},${String(h.lng)}`}>
                <button
                  type="button"
                  onClick={() => {
                    pickSeq.current++;
                    props.onPick(h);
                    clearSearch();
                  }}
                >
                  <strong>{head}</strong>
                  {rest ? <span className="vl-meta"> {rest}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!searching && !lookupError && ready && hits.length === 0 ? (
        <small>No match — check the spelling, use your location, or enter coordinates.</small>
      ) : null}

      {manual ? (
        <div className="vl-place-coords">
          <label style={{ flex: 1 }}>
            Latitude
            <input
              type="number"
              min={-90}
              max={90}
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ flex: 1 }}>
            Longitude
            <input
              type="number"
              min={-180}
              max={180}
              step="any"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <button type="button" className="vl-checkin-btn" onClick={submitManual}>
            Use
          </button>
        </div>
      ) : null}
    </div>
  );
}
