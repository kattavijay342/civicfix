"use client";

import { useMemo, useState } from "react";
import { MapPin, LocateFixed, Navigation, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import { locationBreakdown } from "@/lib/location-format";
import { classifyGeolocationError, describeGeolocationFailure, GEOLOCATION_OPTIONS } from "@/lib/location/gps";
import { sanitizeCoordinates } from "@/lib/location/validation";
import { attemptReverseGeocode } from "@/lib/actions/location";
import { LocationSearchBox } from "@/components/report/LocationSearchBox";
import { CivicMap } from "@/components/map/CivicMap";
import type { LocationSearchSuggestion } from "@/lib/location/types";
import type { CivicLocation } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SmartLocationFieldProps {
  value: CivicLocation | null;
  onChange: (location: CivicLocation | null) => void;
  error?: string;
}

type PinSource = "gps" | "manual" | "search" | null;

const secondaryBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-4 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

const fieldClass =
  "mt-1.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm text-foreground focus-visible:border-civic-400 disabled:cursor-not-allowed disabled:bg-surface-muted/60 disabled:text-foreground-muted";

export function SmartLocationField({ value, onChange, error }: SmartLocationFieldProps) {
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [constituency, setConstituency] = useState("");
  const [area, setArea] = useState("");
  const [areaQuery, setAreaQuery] = useState("");
  const [areaSuggestOpen, setAreaSuggestOpen] = useState(false);
  const [landmark, setLandmark] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [pinSource, setPinSource] = useState<PinSource>(null);
  const [pinCoords, setPinCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [pinConfirmed, setPinConfirmed] = useState(false);
  const [flyToKey, setFlyToKey] = useState<string | undefined>(undefined);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  // Phase 6B: reverse geocoding is wired in for real (src/lib/actions/location.ts)
  // against Mapbox — see src/lib/location/reverse-geocoding.ts.
  const [addressNote, setAddressNote] = useState<string | null>(null);
  const [addressLookupPending, setAddressLookupPending] = useState(false);

  const districtOptions = useMemo(() => getDistricts(state), [state]);
  const constituencyOptions = useMemo(() => getConstituencies(state, district), [state, district]);
  const areaOptions = useMemo(() => getAreas(state, district, constituency), [state, district, constituency]);
  const filteredAreaOptions = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    if (!q) return areaOptions;
    return areaOptions.filter((a) => a.toLowerCase().includes(q));
  }, [areaOptions, areaQuery]);

  const jurisdictionReady = !!(state && district && constituency && area);

  function emitLocation(overrides: {
    state?: string;
    district?: string;
    constituency?: string;
    area?: string;
    landmark?: string;
    latitude?: number | null;
    longitude?: number | null;
  }) {
    const s = overrides.state ?? state;
    const d = overrides.district ?? district;
    const c = overrides.constituency ?? constituency;
    const a = overrides.area ?? area;
    const l = overrides.landmark ?? landmark;

    if (!s || !d || !c || !a) {
      onChange(null);
      return;
    }

    const displayName = l.trim() ? `${l.trim()}, ${a}` : `${a}, ${c}`;
    const rawLat = "latitude" in overrides ? overrides.latitude! : (pinCoords?.lat ?? null);
    const rawLng = "longitude" in overrides ? overrides.longitude! : (pinCoords?.lng ?? null);
    // Never trust an unvalidated coordinate into the report, and never fall
    // back to a fake default like (0, 0) — an invalid pair is simply null.
    const sanitized =
      rawLat != null && rawLng != null
        ? sanitizeCoordinates(rawLat, rawLng, pinSource === "gps" ? gpsCoords?.accuracy : null)
        : null;

    onChange({
      displayName,
      state: s,
      district: d,
      constituency: c,
      area: a,
      landmark: l.trim() || undefined,
      latitude: sanitized?.latitude ?? null,
      longitude: sanitized?.longitude ?? null,
      accuracy: sanitized?.accuracy ?? null,
      source: sanitized ? (pinSource === "gps" ? "gps" : pinSource === "search" ? "search" : "manual") : "manual",
    });
  }

  function handleStateChange(next: string) {
    setState(next);
    setDistrict("");
    setConstituency("");
    setArea("");
    setAreaQuery("");
    emitLocation({ state: next, district: "", constituency: "", area: "" });
  }

  function handleDistrictChange(next: string) {
    setDistrict(next);
    setConstituency("");
    setArea("");
    setAreaQuery("");
    emitLocation({ district: next, constituency: "", area: "" });
  }

  function handleConstituencyChange(next: string) {
    setConstituency(next);
    setArea("");
    setAreaQuery("");
    emitLocation({ constituency: next, area: "" });
  }

  function commitArea(next: string) {
    const trimmed = next.trim();
    setArea(trimmed);
    setAreaQuery(trimmed);
    setAreaSuggestOpen(false);
    emitLocation({ area: trimmed });
  }

  function handleLandmarkChange(next: string) {
    setLandmark(next);
    if (jurisdictionReady) emitLocation({ landmark: next });
  }

  /** Fired for both a click and a drag-end on the map's single marker — a
   * real map, real coordinates, no percentage-based fake positioning. Any
   * hands-on placement/adjustment on the map itself is "manual," even if the
   * marker started out from a GPS fix or search result. */
  function handleMapMove(lat: number, lng: number) {
    const sanitized = sanitizeCoordinates(lat, lng, null);
    if (!sanitized) return;
    setPinSource("manual");
    setPinCoords({ lat: sanitized.latitude, lng: sanitized.longitude });
    setPinConfirmed(false);
    setGpsCoords(null);
    setAddressNote(null);
  }

  function startManualPin() {
    setGpsCoords(null);
    setGpsNote(null);
    setAddressNote(null);
    setPinSource(null);
    setPinCoords(null);
    setPinConfirmed(false);
  }

  function handleSearchSelect(suggestion: LocationSearchSuggestion) {
    setGpsCoords(null);
    setGpsNote(null);
    setPinSource("search");
    setPinCoords({ lat: suggestion.latitude, lng: suggestion.longitude });
    setPinConfirmed(false);
    setFlyToKey(String(Date.now()));
    setAddressNote(suggestion.context ? `${suggestion.label}, ${suggestion.context}` : suggestion.label);
    // Never overwrite something the citizen already typed themselves — only
    // fill the free-text landmark field when it's still empty.
    if (!landmark.trim()) handleLandmarkChange(suggestion.label);
  }

  function handleUseCurrentLocation() {
    if (gpsLoading) return; // defensive guard alongside the disabled button
    if (!("geolocation" in navigator)) {
      setGpsNote(describeGeolocationFailure("unsupported"));
      return;
    }
    setGpsLoading(true);
    setGpsNote(null);
    setAddressNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const sanitized = sanitizeCoordinates(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        if (!sanitized) {
          setGpsNote(describeGeolocationFailure("position_unavailable"));
          setGpsLoading(false);
          return;
        }
        setGpsCoords({ lat: sanitized.latitude, lng: sanitized.longitude, accuracy: sanitized.accuracy });
        setPinCoords({ lat: sanitized.latitude, lng: sanitized.longitude });
        setPinSource("gps");
        setPinConfirmed(false);
        setGpsLoading(false);
        setFlyToKey(String(Date.now()));

        // Fire-and-forget: attempts real reverse geocoding through Mapbox
        // (src/lib/location/reverse-geocoding.ts) exactly once per confirmed
        // fix, never repeated for the same coordinates.
        setAddressLookupPending(true);
        attemptReverseGeocode(sanitized.latitude, sanitized.longitude)
          .then((outcome) => {
            setAddressNote(
              outcome.status === "ok"
                ? outcome.result.formattedAddress
                : "Address lookup unavailable — please confirm the location manually using the fields above."
            );
          })
          .finally(() => setAddressLookupPending(false));
      },
      (error) => {
        setGpsNote(describeGeolocationFailure(classifyGeolocationError(error)));
        setGpsLoading(false);
      },
      GEOLOCATION_OPTIONS
    );
  }

  function confirmPin() {
    setPinConfirmed(true);
    if (pinCoords) emitLocation({ latitude: pinCoords.lat, longitude: pinCoords.lng });
  }

  function resetPin() {
    setPinSource(null);
    setPinCoords(null);
    setPinConfirmed(false);
    setGpsCoords(null);
    setGpsNote(null);
    setAddressNote(null);
    emitLocation({ latitude: null, longitude: null });
  }

  const jurisdictionChain = jurisdictionReady ? [area, constituency, district, state] : [];
  const detailRows = value ? locationBreakdown(value) : [];

  return (
    <section className="rounded-2xl border border-border bg-white p-6">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-civic-700" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Where is the problem?</h2>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">
        Tell us the area and pinpoint the exact location on the map.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-foreground-muted" htmlFor="loc-state">
            State <span className="text-priority-critical">*</span>
          </label>
          <select
            id="loc-state"
            value={state}
            onChange={(e) => handleStateChange(e.target.value)}
            className={fieldClass}
          >
            <option value="">Select state</option>
            {stateNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-foreground-muted" htmlFor="loc-district">
            District <span className="text-priority-critical">*</span>
          </label>
          <select
            id="loc-district"
            value={district}
            disabled={!state}
            onChange={(e) => handleDistrictChange(e.target.value)}
            className={fieldClass}
          >
            <option value="">{state ? "Select district" : "Select state first"}</option>
            {districtOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-foreground-muted" htmlFor="loc-constituency">
            Constituency <span className="text-priority-critical">*</span>
          </label>
          <select
            id="loc-constituency"
            value={constituency}
            disabled={!district}
            onChange={(e) => handleConstituencyChange(e.target.value)}
            className={fieldClass}
          >
            <option value="">{district ? "Select constituency" : "Select district first"}</option>
            {constituencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="relative">
          <label className="text-xs font-medium text-foreground-muted" htmlFor="loc-area">
            Area / Village / Ward <span className="text-priority-critical">*</span>
          </label>
          <input
            id="loc-area"
            value={areaQuery}
            disabled={!constituency}
            onChange={(e) => {
              setAreaQuery(e.target.value);
              setAreaSuggestOpen(true);
              if (area && e.target.value !== area) setArea("");
            }}
            onFocus={() => setAreaSuggestOpen(true)}
            onBlur={() => {
              setTimeout(() => setAreaSuggestOpen(false), 150);
              if (areaQuery.trim()) commitArea(areaQuery);
            }}
            placeholder={constituency ? "Search or select area..." : "Select constituency first"}
            className={fieldClass}
            autoComplete="off"
          />
          {areaSuggestOpen && constituency && filteredAreaOptions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full divide-y divide-border overflow-hidden rounded-lg border border-border bg-white shadow-md">
              {filteredAreaOptions.map((a) => (
                <li key={a}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitArea(a)}
                    className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-civic-50"
                  >
                    {a}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {constituency && (
            <p className="mt-1 text-[11px] text-foreground-muted/80">
              Not listed? Type your village/area name — it will be saved as entered.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <label className="text-xs font-medium text-foreground-muted" htmlFor="loc-landmark">
          Specific Location / Landmark <span className="text-foreground-muted/70">(optional)</span>
        </label>
        <input
          id="loc-landmark"
          value={landmark}
          onChange={(e) => handleLandmarkChange(e.target.value)}
          placeholder="e.g. Main Road near Government School"
          className={fieldClass}
        />
      </div>

      <div className="mt-5 border-t border-border pt-5">
        <p className="text-xs font-semibold text-foreground">Pinpoint the exact location</p>
        <p className="mt-0.5 text-xs text-foreground-muted">
          Search for a place, use your current location, or drag the pin on the map.
        </p>

        <div className="mt-3">
          <LocationSearchBox onSelect={handleSearchSelect} />
        </div>

        <div className="relative mt-3 aspect-[16/9] overflow-hidden rounded-xl border border-border">
          <CivicMap
            mode="single"
            singleMarker={pinCoords ? { latitude: pinCoords.lat, longitude: pinCoords.lng } : null}
            draggable
            onSingleMarkerMove={handleMapMove}
            flyToKey={flyToKey}
            center={pinCoords ? [pinCoords.lng, pinCoords.lat] : undefined}
            zoom={pinCoords ? 15 : undefined}
          />
          {!pinCoords && (
            <p className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-xs text-foreground-muted">
              Search above, use your current location, or tap the map to place a pin.
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleUseCurrentLocation}
            disabled={gpsLoading}
            className={cn(
              secondaryBtn,
              "border-civic-200 bg-civic-50 text-civic-700 hover:border-civic-300 hover:bg-civic-100",
            )}
          >
            <LocateFixed className={cn("h-3.5 w-3.5", gpsLoading && "animate-spin")} aria-hidden="true" />
            {gpsLoading ? "Locating..." : "Use my current location"}
          </button>
          <button
            type="button"
            onClick={startManualPin}
            className={cn(
              secondaryBtn,
              "border-border bg-white text-foreground-muted hover:border-civic-200 hover:text-foreground",
            )}
          >
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            Choose on map
          </button>
        </div>

        {gpsNote && (
          <p role="alert" className="mt-2 text-xs text-priority-medium">
            {gpsNote}
          </p>
        )}

        {pinCoords && !pinConfirmed && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-civic-300 bg-civic-50/60 px-3 py-2.5">
            <p className="text-xs text-foreground-muted" aria-live="polite">
              {pinSource === "gps" && gpsCoords ? (
                <>
                  GPS location: {gpsCoords.lat.toFixed(5)}, {gpsCoords.lng.toFixed(5)}
                  {gpsCoords.accuracy != null && (
                    <> (accuracy: approximately {Math.round(gpsCoords.accuracy)} m)</>
                  )}
                  <br />
                  <span className="text-foreground-muted/80">
                    {addressLookupPending ? "Looking up address…" : addressNote}
                  </span>
                </>
              ) : pinSource === "search" ? (
                <>
                  {addressNote}
                  <br />
                  <span className="text-foreground-muted/80">
                    {pinCoords.lat.toFixed(5)}, {pinCoords.lng.toFixed(5)}
                  </span>
                </>
              ) : (
                "Drag the pin to fine-tune, then confirm."
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmPin}
                className="rounded-full bg-civic-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-civic-700"
              >
                Confirm location
              </button>
              <button
                type="button"
                onClick={resetPin}
                className="rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground-muted hover:border-civic-200"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {pinConfirmed && pinCoords && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-civic-50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-civic-800">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Location confirmed — {pinCoords.lat.toFixed(5)}, {pinCoords.lng.toFixed(5)}
              {pinSource === "gps" && gpsCoords?.accuracy != null ? ` (±${Math.round(gpsCoords.accuracy)} m)` : ""}
            </p>
            <button type="button" onClick={resetPin} className="text-xs font-medium text-civic-700 hover:underline">
              Change
            </button>
          </div>
        )}

        <p className="mt-2 text-[11px] text-foreground-muted">
          {pinSource === "manual"
            ? "Drag the pin to fine-tune the exact spot, then confirm."
            : "Pinpointing the map is optional, but helps AI route this issue faster."}
        </p>
      </div>

      {jurisdictionReady && value && (
        <div className="mt-5 rounded-2xl border border-civic-200 bg-civic-50 p-5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-civic-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Location identified
          </p>
          <div className="mt-3 border-t border-civic-200 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-civic-700">Civic jurisdiction</p>
            <p className="mt-1 text-sm font-medium text-foreground">{jurisdictionChain.join(" → ")}</p>
          </div>
          <p className="mt-3 text-xs text-civic-700">AI can now route this issue automatically.</p>

          {detailRows.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-civic-700 hover:underline"
              >
                {detailsOpen ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
                {detailsOpen ? "Hide location details" : "View location details"}
              </button>
              {detailsOpen && (
                <dl className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-white/60 p-3 text-xs">
                  {detailRows.map((row) => (
                    <div key={row.label}>
                      <dt className="text-foreground-muted">{row.label}</dt>
                      <dd className="font-semibold text-foreground">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          <p className="mt-4 border-t border-civic-200 pt-3 text-[11px] text-foreground-muted">
            Jurisdiction selected from a small Andhra Pradesh / Telangana demo dataset — not an official government
            boundary lookup.
          </p>
        </div>
      )}

      {error && !jurisdictionReady && <p className="mt-2 text-xs font-medium text-priority-critical">{error}</p>}
    </section>
  );
}
