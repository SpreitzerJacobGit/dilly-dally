import { useEffect, useState, type JSX } from "react";
import { geocode, type GeocodeHit } from "../lib/geocode.js";

/**
 * Search for a place by name, and fall back to typing coordinates.
 *
 * The fallback is not a nicety. This is the only lookup that leaves the van,
 * and it is the first thing to stop working when the uplink does — so the
 * failure is stated and the manual path is put right there, rather than the
 * field going quietly empty and looking like the place does not exist.
 */

export interface GeocodeFieldProps {
  label: string;
  placeholder?: string;
  /** Called with a chosen place, whether searched for or typed in. */
  onPick: (hit: GeocodeHit) => void;
  autoFocus?: boolean;
}

export function GeocodeField(props: GeocodeFieldProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  useEffect(() => {
    if (search.trim().length < 3) {
      setHits([]);
      setError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void geocode(search).then((r) => {
        setHits(r.hits);
        setError(r.error);
        setSearching(false);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const submitManual = (): void => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    if (la < -90 || la > 90 || ln < -180 || ln > 180) return;
    props.onPick({
      name: search.trim() || `${la.toFixed(4)}, ${ln.toFixed(4)}`,
      lat: la,
      lng: ln,
      suggestedRadiusMiles: 25,
    });
  };

  return (
    <div>
      <label>
        {props.label}
        <input
          type="search"
          placeholder={props.placeholder ?? "Search a place — e.g. Eastern Sierra"}
          value={search}
          autoFocus={props.autoFocus}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      {searching ? <small>searching…</small> : null}

      {error ? (
        <div className="vl-offline" style={{ margin: "6px 0" }}>
          Place search unavailable ({error}) — enter coordinates instead.
        </div>
      ) : null}

      {hits.length > 0 ? (
        <ul className="vl-hits">
          {hits.map((h) => (
            <li key={`${String(h.lat)},${String(h.lng)}`}>
              <button
                type="button"
                onClick={() => {
                  props.onPick(h);
                  setHits([]);
                  setSearch("");
                }}
              >
                {h.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!searching && !error && hits.length === 0 && search.trim().length >= 3 ? (
        <small>No match — check the spelling, or enter coordinates.</small>
      ) : null}

      {manual || error ? (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 6 }}>
          <label style={{ flex: 1 }}>
            Latitude
            <input type="number" min={-90} max={90} step="any" value={lat} onChange={(e) => setLat(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>
            Longitude
            <input type="number" min={-180} max={180} step="any" value={lng} onChange={(e) => setLng(e.target.value)} style={{ width: "100%" }} />
          </label>
          <button type="button" className="vl-checkin-btn" onClick={submitManual}>
            Use
          </button>
        </div>
      ) : (
        <button type="button" className="vl-checkin-btn" style={{ marginTop: 6 }} onClick={() => setManual(true)}>
          Enter coordinates
        </button>
      )}
    </div>
  );
}
