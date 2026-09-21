"use client";

import { useEffect, useRef, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { isMapboxConfigured } from "@/lib/location/mapbox-config";
import type { LocationSearchOutcome, LocationSearchSuggestion } from "@/lib/location/types";

const DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 3;

interface LocationSearchBoxProps {
  onSelect: (suggestion: LocationSearchSuggestion) => void;
}

/**
 * Search/autocomplete over Mapbox forward geocoding (villages, towns,
 * wards, landmarks, bus stands...) via /api/location/search — never calls
 * Mapbox directly from the browser. Debounced, and genuinely CANCELS its
 * own outdated request with AbortController (not just discards a stale
 * response) whenever a newer keystroke supersedes it. Never fires below
 * MIN_QUERY_LENGTH characters.
 */
export function LocationSearchBox({ onSelect }: LocationSearchBoxProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapboxConfigured = isMapboxConfigured();

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  function handleChange(next: string) {
    setQuery(next);
    setOpen(true);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    // A newer keystroke always cancels whatever request is still in flight.
    abortRef.current?.abort();

    const trimmed = next.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`/api/location/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(async (res) => {
          const outcome = (await res.json()) as LocationSearchOutcome;
          if (outcome.status === "ok") {
            setResults(outcome.results);
          } else {
            setResults([]);
            setError(outcome.reason);
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return; // cancelled — not an error
          setResults([]);
          setError("Location search failed. Please try again.");
        })
        .finally(() => {
          if (abortRef.current === controller) setLoading(false);
        });
    }, DEBOUNCE_MS);
  }

  function handleSelect(suggestion: LocationSearchSuggestion) {
    setQuery(suggestion.label);
    setOpen(false);
    setResults([]);
    onSelect(suggestion);
  }

  if (!mapboxConfigured) {
    return (
      <p className="text-xs text-foreground-muted">
        Location search is unavailable right now — use &ldquo;Use my current location&rdquo; or choose on the map
        instead.
      </p>
    );
  }

  const showDropdown = open && (results.length > 0 || loading || (!!error && query.trim().length >= MIN_QUERY_LENGTH));

  return (
    <div className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="location-search-results"
          aria-label="Search for a village, town, ward, or landmark"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search village, town, ward, or landmark…"
          className="w-full rounded-lg border border-border bg-white py-2.5 pl-8 pr-8 text-sm text-foreground focus-visible:border-civic-400"
          autoComplete="off"
        />
        {loading && (
          <Loader2
            className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-foreground-muted"
            aria-hidden="true"
          />
        )}
      </div>

      {showDropdown && (
        <ul
          id="location-search-results"
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-white shadow-md"
        >
          {loading && results.length === 0 && (
            <li className="px-3 py-2.5 text-xs text-foreground-muted">Searching…</li>
          )}
          {!loading && error && (
            <li role="alert" className="px-3 py-2.5 text-xs text-priority-medium">
              {error}
            </li>
          )}
          {!loading && !error && results.length === 0 && query.trim().length >= MIN_QUERY_LENGTH && (
            <li className="px-3 py-2.5 text-xs text-foreground-muted">No matching places found.</li>
          )}
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(r)}
                className="block w-full px-3 py-2.5 text-left hover:bg-civic-50"
              >
                <span className="block text-sm font-medium text-foreground">{r.label}</span>
                {r.context && <span className="block text-xs text-foreground-muted">{r.context}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
