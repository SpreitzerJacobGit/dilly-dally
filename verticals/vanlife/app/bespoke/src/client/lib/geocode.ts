/**
 * The client half of place lookup.
 *
 * The lookup itself moved to the van server (see server/engine/geocoder.ts) —
 * a browser cannot send the User-Agent Nominatim's policy requires, and cannot
 * remember an answer for the next time the uplink is gone. What is left here is
 * the part that genuinely belongs in the browser: reading the device's own
 * position, and naming the ways that can fail.
 */

export interface GeocodeHit {
  name: string;
  lat: number;
  lng: number;
  /** Nominatim's own bbox, used to suggest a sensible starting radius. */
  suggestedRadiusMiles: number;
}

export interface GeocodeResult {
  hits: GeocodeHit[];
  /** Non-null when the lookup could not be made at all, as opposed to finding nothing. */
  error: string | null;
  /** True when these hits came from the van's memory after a live lookup failed. */
  stale: boolean;
}

/** Nominatim returns one long comma-joined string; the head is the part worth reading first. */
export function splitPlaceName(displayName: string): { head: string; rest: string } {
  const parts = displayName.split(",");
  return { head: (parts[0] ?? displayName).trim(), rest: parts.slice(1).join(",").trim() };
}

/** The short label stored on a trip or Target — callers all want the head, not the essay. */
export function shortPlaceName(displayName: string): string {
  return splitPlaceName(displayName).head;
}

export interface DeviceFix {
  lat: number;
  lng: number;
  /** Metres, as reported by the device. Shown so an operator can judge the fix. */
  accuracyMeters: number;
}

export type GeolocationFailure =
  | { kind: "unsupported"; message: string }
  | { kind: "insecure"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "timeout"; message: string };

/**
 * Read the device's position.
 *
 * The failure modes are separated rather than collapsed into one "could not get
 * location", because the fix for each is completely different and only the
 * operator can apply it: a denied permission is a browser setting, an insecure
 * context is the URL you used to reach the van. That second one is not
 * hypothetical here — deploy/README.md documents that the app is reached over
 * Tailscale's HTTPS precisely because plain http://<ip>:18081 gets no
 * geolocation and no PWA install, and someone will eventually use the raw IP.
 */
export async function readDeviceFix(): Promise<{ fix: DeviceFix | null; failure: GeolocationFailure | null }> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return { fix: null, failure: { kind: "unsupported", message: "This browser cannot report a location." } };
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return {
      fix: null,
      failure: {
        kind: "insecure",
        message:
          "Location needs a secure connection. Reach the van over its https:// address rather than a plain http:// IP.",
      },
    };
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          fix: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy },
          failure: null,
        });
      },
      (err) => {
        const failure: GeolocationFailure =
          err.code === err.PERMISSION_DENIED
            ? {
                kind: "denied",
                message: "Location permission is off for this site — allow it in your browser settings.",
              }
            : err.code === err.TIMEOUT
              ? { kind: "timeout", message: "Timed out waiting for a fix — try again with a clearer view of the sky." }
              : { kind: "unavailable", message: "No position available right now — the device could not get a fix." };
        resolve({ fix: null, failure });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

/** A fix with no name is still a perfectly good location; label it with its coordinates. */
export function coordLabel(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/**
 * Where the van is, but only if asking costs nothing: permission already
 * granted, and a fix available quickly.
 *
 * For stamping a check-in, which is a one-tap action whose whole value is that
 * it is instant. A permission prompt in the middle of "Filled water" would be
 * an interruption nobody asked for, and a slow fix would make the tap feel
 * broken — so both resolve to null and the check-in records without a location,
 * exactly as it always has. The location is a bonus, never a precondition.
 */
export async function readGrantedFix(timeoutMs = 2000): Promise<DeviceFix | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  if (typeof window !== "undefined" && !window.isSecureContext) return null;

  // Only proceed on an already-granted permission, so this never prompts.
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status.state !== "granted") return null;
  } catch {
    // No Permissions API means no way to know without prompting — so don't.
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy });
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
