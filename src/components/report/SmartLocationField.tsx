"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";
import { MapPin, LocateFixed, Navigation, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { stateNames, getDistricts, getConstituencies, getAreas } from "@/lib/jurisdiction";
import { locationBreakdown } from "@/lib/location-format";
import type { CivicLocation } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SmartLocationFieldProps {
  value: CivicLocation | null;
  onChange: (location: CivicLocation | null) => void;
  error?: string;
}

type PinSource = "gps" | "manual" | null;

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
  const [pinPercent, setPinPercent] = useState<{ x: number; y: number } | null>(null);
  const [pinConfirmed, setPinConfirmed] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsNote, setGpsNote] = useState<string | null>(null);

  const mapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

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
    const lat =
      "latitude" in overrides ? overrides.latitude! : pinSource === "gps" && gpsCoords ? gpsCoords.lat : null;
    const lng =
      "longitude" in overrides ? overrides.longitude! : pinSource === "gps" && gpsCoords ? gpsCoords.lng : null;

    onChange({
      displayName,
      state: s,
      district: d,
      constituency: c,
      area: a,
      landmark: l.trim() || undefined,
      latitude: lat,
      longitude: lng,
      source: pinSource === "gps" && lat != null && lng != null ? "gps" : "manual",
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

  function pinFromPointer(clientX: number, clientY: number) {
    const box = mapRef.current;
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
    return { x, y };
  }

  function startManualPin() {
    setGpsCoords(null);
    setGpsNote(null);
    setPinSource("manual");
    setPinConfirmed(false);
    setPinPercent((p) => p ?? { x: 50, y: 50 });
  }

  function handleMapPointerDown(e: PointerEvent<HTMLDivElement>) {
    const pos = pinFromPointer(e.clientX, e.clientY);
    if (!pos) return;
    setPinSource("manual");
    setPinConfirmed(false);
    setGpsCoords(null);
    setPinPercent(pos);
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function handleMapPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const pos = pinFromPointer(e.clientX, e.clientY);
    if (pos) setPinPercent(pos);
  }

  function endMapDrag() {
    draggingRef.current = false;
  }

  function handleUseCurrentLocation() {
    if (!("geolocation" in navigator)) {
      setGpsNote("Location access was not available. You can select the location manually on the map.");
      return;
    }
    setGpsLoading(true);
    setGpsNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setPinSource("gps");
        setPinPercent({ x: 50, y: 50 });
        setPinConfirmed(false);
        setGpsLoading(false);
      },
      () => {
        setGpsNote("Location access was not available. You can select the location manually on the map.");
        setGpsLoading(false);
      },
      { timeout: 8000 },
    );
  }

  function confirmPin() {
    setPinConfirmed(true);
    if (pinSource === "gps" && gpsCoords) {
      emitLocation({ latitude: gpsCoords.lat, longitude: gpsCoords.lng });
    } else {
      emitLocation({ latitude: null, longitude: null });
    }
  }

  function resetPin() {
    setPinSource(null);
    setPinPercent(null);
    setPinConfirmed(false);
    setGpsCoords(null);
    setGpsNote(null);
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
        <p className="mt-0.5 text-xs text-foreground-muted">Confirm where the problem is located.</p>

        <div
          ref={mapRef}
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={endMapDrag}
          onPointerLeave={endMapDrag}
          className="relative mt-3 aspect-[16/9] touch-none select-none overflow-hidden rounded-xl border border-border bg-[#eef3ee]"
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-60" aria-hidden="true">
            <defs>
              <pattern id="loc-map-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#d5ded5" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#loc-map-grid)" />
          </svg>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            <path
              d="M0,90 C120,60 220,120 360,80 C440,55 520,100 640,70"
              fill="none"
              stroke="#c9d4c9"
              strokeWidth="8"
            />
            <path d="M90,0 C120,90 80,180 130,260" fill="none" stroke="#c9d4c9" strokeWidth="6" />
          </svg>

          {!pinPercent && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-foreground-muted">
              Tap or drag to place a pin — or use the buttons below.
            </p>
          )}

          {pinPercent && (
            <div
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-full cursor-grab items-center justify-center rounded-full border-2 border-white bg-civic-600 text-white shadow-md active:cursor-grabbing"
              style={{ left: `${pinPercent.x}%`, top: `${pinPercent.y}%` }}
            >
              <MapPin className="h-4 w-4" aria-hidden="true" />
            </div>
          )}

          <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">
            Demo map
          </span>
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

        {gpsNote && <p className="mt-2 text-xs text-priority-medium">{gpsNote}</p>}

        {pinPercent && !pinConfirmed && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-civic-300 bg-civic-50/60 px-3 py-2.5">
            <p className="text-xs text-foreground-muted">
              {pinSource === "gps" && gpsCoords
                ? `GPS location: ${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`
                : "Drag the pin to fine-tune, then confirm."}
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

        {pinConfirmed && pinPercent && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-civic-50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-civic-800">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Location confirmed
              {pinSource === "gps" && gpsCoords
                ? ` — ${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`
                : " — approximate pin"}
            </p>
            <button type="button" onClick={resetPin} className="text-xs font-medium text-civic-700 hover:underline">
              Change
            </button>
          </div>
        )}

        <p className="mt-2 text-[11px] text-foreground-muted">
          {pinSource === "manual" && pinPercent
            ? "Illustrative demo map, not to scale — exact coordinates need a connected map provider."
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
