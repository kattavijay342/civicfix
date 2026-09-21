"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { getMapboxToken, MAPBOX_STYLE_URL, DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from "@/lib/location/mapbox-config";
import { PRIORITY_COLORS, type CivicMapIssueMarker, type CivicMapProps } from "./mapTypes";
import { cn } from "@/lib/utils";

const SOURCE_ID = "civic-issues";

/**
 * Real mapbox-gl wrapper — always mounted client-only (see CivicMap.tsx,
 * which dynamically imports this with `ssr: false`; mapbox-gl touches
 * `window` at import time and would crash during SSR otherwise).
 *
 * One mapbox-gl.Map instance is created once per mount and only ever
 * mutated imperatively afterwards (add/update layers, move the camera,
 * update marker position) — this is the same pattern Mapbox's own React
 * examples use, and avoids tearing the whole map down and rebuilding it on
 * every prop change, which would flash/reset the user's pan and zoom.
 */
export default function CivicMapView({
  className,
  mode,
  center,
  zoom,
  singleMarker = null,
  draggable = false,
  onSingleMarkerMove,
  issues = [],
  onViewIssue,
  showDensity = false,
  flyToKey,
  fitToIssues = false,
}: CivicMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const mapClickBoundRef = useRef(false);
  const onSingleMarkerMoveRef = useRef(onSingleMarkerMove);
  const onViewIssueRef = useRef(onViewIssue);
  useEffect(() => {
    onSingleMarkerMoveRef.current = onSingleMarkerMove;
    onViewIssueRef.current = onViewIssue;
  });

  const token = getMapboxToken();

  // Create the map exactly once per mount, tear it down on unmount. Guards
  // against double-init (React Strict Mode's mount/unmount/mount in dev)
  // with the mapRef check, and against a leaked instance with map.remove().
  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE_URL,
      center: center ?? DEFAULT_MAP_CENTER,
      zoom: zoom ?? DEFAULT_MAP_ZOOM,
      cooperativeGestures: mode === "multi",
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      mapClickBoundRef.current = false;
    };
    // Intentionally only re-creates the map if the token itself changes —
    // every other prop is applied imperatively in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Single-pin mode (report creation / report detail): one optionally
  // draggable marker, plus tap-anywhere-on-the-map placement. The user's own
  // drag/tap is the source of truth for the final stored coordinates (rule:
  // never silently re-snap it).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== "single") return;

    if (draggable && !mapClickBoundRef.current) {
      map.on("click", (e) => {
        onSingleMarkerMoveRef.current?.(e.lngLat.lat, e.lngLat.lng);
      });
      mapClickBoundRef.current = true;
    }

    if (!singleMarker) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const lngLat: [number, number] = [singleMarker.longitude, singleMarker.latitude];
    if (!markerRef.current) {
      const marker = new mapboxgl.Marker({ color: "#1f7a51", draggable }).setLngLat(lngLat).addTo(map);
      if (draggable) {
        marker.on("dragend", () => {
          const { lat, lng } = marker.getLngLat();
          onSingleMarkerMoveRef.current?.(lat, lng);
        });
      }
      markerRef.current = marker;
    } else {
      markerRef.current.setLngLat(lngLat);
      markerRef.current.setDraggable(draggable);
    }
  }, [mode, singleMarker, draggable]);

  // Imperative recenter — fired after a search result is picked or a GPS
  // fix resolves, so the map visibly jumps there instead of the user having
  // to pan/zoom manually to find their own pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyToKey || mode !== "single" || !singleMarker) return;
    map.flyTo({
      center: [singleMarker.longitude, singleMarker.latitude],
      zoom: Math.max(map.getZoom(), 15),
      essential: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToKey]);

  // Multi-pin mode (government dashboard / landing page): a clustered
  // GeoJSON source, real priority-colored markers, an optional density
  // heatmap, and click-through to the real report.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== "multi") return;

    function build() {
      if (!map) return;
      const geojson = toFeatureCollection(issues);
      const existingSource = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(geojson);
        if (map.getLayer("civic-heatmap")) {
          map.setLayoutProperty("civic-heatmap", "visibility", showDensity ? "visible" : "none");
        }
      } else {
        addIssueLayers(map, geojson, showDensity, onViewIssueRef);
      }

      if (fitToIssues && issues.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const issue of issues) bounds.extend([issue.longitude, issue.latitude]);
        map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
      }
    }

    if (map.isStyleLoaded()) build();
    else map.once("load", build);
  }, [mode, issues, showDensity, fitToIssues]);

  return (
    <div
      ref={containerRef}
      className={cn("civic-mapbox h-full w-full", className)}
      role="application"
      aria-label={mode === "single" ? "Interactive location picker map" : "Interactive issue map"}
    />
  );
}

function toFeatureCollection(issues: CivicMapIssueMarker[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: issues.map((issue) => ({
      type: "Feature",
      id: issue.id,
      geometry: { type: "Point", coordinates: [issue.longitude, issue.latitude] },
      properties: { ...issue } as Record<string, unknown>,
    })),
  };
}

function addIssueLayers(
  map: mapboxgl.Map,
  geojson: GeoJSON.FeatureCollection<GeoJSON.Point>,
  showDensity: boolean,
  onViewIssueRef: React.MutableRefObject<((id: string) => void) | undefined>
) {
  map.addSource(SOURCE_ID, {
    type: "geojson",
    data: geojson,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });

  map.addLayer({
    id: "civic-heatmap",
    type: "heatmap",
    source: SOURCE_ID,
    maxzoom: 11,
    layout: { visibility: showDensity ? "visible" : "none" },
    paint: {
      "heatmap-weight": 1,
      "heatmap-intensity": 1,
      "heatmap-radius": 28,
      "heatmap-opacity": 0.55,
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,0,0)",
        0.3,
        "#fef3c7",
        0.6,
        "#fb923c",
        1,
        "#dc2626",
      ],
    },
  });

  map.addLayer({
    id: "civic-clusters",
    type: "circle",
    source: SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#1f7a51",
      "circle-opacity": 0.9,
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "civic-cluster-count",
    type: "symbol",
    source: SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": "{point_count_abbreviated}",
      "text-font": ["DIN Pro Medium", "Arial Unicode MS Bold"],
      "text-size": 12,
    },
    paint: { "text-color": "#ffffff" },
  });

  map.addLayer({
    id: "civic-points",
    type: "circle",
    source: SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": [
        "match",
        ["get", "priority"],
        "CRITICAL",
        PRIORITY_COLORS.CRITICAL,
        "HIGH",
        PRIORITY_COLORS.HIGH,
        "MEDIUM",
        PRIORITY_COLORS.MEDIUM,
        "LOW",
        PRIORITY_COLORS.LOW,
        "#6b7280",
      ],
      "circle-radius": 10,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  // Priority is never conveyed by color alone — a letter label on every
  // individual marker (C/H/M/L) keeps it readable without color vision.
  map.addLayer({
    id: "civic-point-labels",
    type: "symbol",
    source: SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["match", ["get", "priority"], "CRITICAL", "C", "HIGH", "H", "MEDIUM", "M", "LOW", "L", "?"],
      "text-size": 10,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": "#ffffff" },
  });

  for (const layer of ["civic-clusters", "civic-points"]) {
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  map.on("click", "civic-clusters", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["civic-clusters"] });
    const clusterId = features[0]?.properties?.cluster_id;
    const source = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    const geometry = features[0]?.geometry;
    if (clusterId == null || !source || geometry?.type !== "Point") return;
    source.getClusterExpansionZoom(clusterId, (err, targetZoom) => {
      if (err || targetZoom == null) return;
      map.easeTo({ center: geometry.coordinates as [number, number], zoom: targetZoom });
    });
  });

  map.on("click", "civic-points", (e) => {
    const feature = e.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    showIssuePopup(map, feature.geometry.coordinates as [number, number], feature.properties ?? {}, onViewIssueRef);
  });
}

/**
 * Builds popup content via real DOM nodes with `textContent` rather than
 * `setHTML` — report titles/descriptions are citizen-submitted free text,
 * so treating them as trusted HTML would be an XSS hole.
 */
function showIssuePopup(
  map: mapboxgl.Map,
  coords: [number, number],
  props: Record<string, unknown>,
  onViewIssueRef: React.MutableRefObject<((id: string) => void) | undefined>
) {
  const container = document.createElement("div");
  container.className = "min-w-[200px] max-w-[240px] font-sans";

  const title = document.createElement("p");
  title.className = "text-sm font-semibold leading-snug text-foreground";
  title.textContent = typeof props.title === "string" ? props.title : "Issue";
  container.appendChild(title);

  const priority = typeof props.priority === "string" ? props.priority : undefined;
  if (priority) {
    const priorityEl = document.createElement("p");
    priorityEl.className = "mt-1 text-xs font-semibold";
    priorityEl.style.color = PRIORITY_COLORS[priority as keyof typeof PRIORITY_COLORS] ?? "#6b7280";
    priorityEl.textContent = `${priority} priority`;
    container.appendChild(priorityEl);
  }

  const metaParts = [props.statusLabel, props.department].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (metaParts.length > 0) {
    const meta = document.createElement("p");
    meta.className = "mt-1 text-xs text-foreground-muted";
    meta.textContent = metaParts.join(" · ");
    container.appendChild(meta);
  }

  if (typeof props.reportedDateLabel === "string" && props.reportedDateLabel) {
    const date = document.createElement("p");
    date.className = "mt-0.5 text-xs text-foreground-muted";
    date.textContent = `Reported ${props.reportedDateLabel}`;
    container.appendChild(date);
  }

  const id = typeof props.id === "string" ? props.id : undefined;
  if (id) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "mt-2 text-xs font-medium text-civic-700 hover:underline";
    link.textContent = "View Issue →";
    link.addEventListener("click", () => onViewIssueRef.current?.(id));
    container.appendChild(link);
  }

  new mapboxgl.Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: "260px" })
    .setLngLat(coords)
    .setDOMContent(container)
    .addTo(map);
}
