import { describe, it, expect } from "vitest";
import { computeBounds, projectPoints, computeDensityGrid } from "./projection";

describe("computeBounds", () => {
  it("returns null for no points", () => {
    expect(computeBounds([])).toBeNull();
  });

  it("computes the real min/max envelope of the given points", () => {
    const bounds = computeBounds([
      { id: "a", latitude: 16.0, longitude: 80.0 },
      { id: "b", latitude: 17.0, longitude: 81.5 },
      { id: "c", latitude: 15.5, longitude: 79.0 },
    ]);
    expect(bounds).toEqual({ minLat: 15.5, maxLat: 17.0, minLng: 79.0, maxLng: 81.5 });
  });
});

describe("projectPoints", () => {
  it("returns an empty array for no points", () => {
    expect(projectPoints([])).toEqual([]);
  });

  it("centers a single point (degenerate range on both axes)", () => {
    const [p] = projectPoints([{ id: "a", latitude: 16.0, longitude: 80.0 }]);
    expect(p.xPercent).toBe(50);
    expect(p.yPercent).toBe(50);
  });

  it("places the northernmost point above the southernmost one (y increases downward)", () => {
    const points = projectPoints([
      { id: "north", latitude: 20.0, longitude: 80.0 },
      { id: "south", latitude: 10.0, longitude: 80.0 },
    ]);
    const north = points.find((p) => p.id === "north")!;
    const south = points.find((p) => p.id === "south")!;
    expect(north.yPercent).toBeLessThan(south.yPercent);
  });

  it("places the easternmost point to the right of the westernmost one", () => {
    const points = projectPoints([
      { id: "east", latitude: 16.0, longitude: 85.0 },
      { id: "west", latitude: 16.0, longitude: 75.0 },
    ]);
    const east = points.find((p) => p.id === "east")!;
    const west = points.find((p) => p.id === "west")!;
    expect(east.xPercent).toBeGreaterThan(west.xPercent);
  });

  it("keeps every projected position within the padded [0, 100] surface", () => {
    const points = projectPoints([
      { id: "a", latitude: -60, longitude: -170 },
      { id: "b", latitude: 80, longitude: 175 },
      { id: "c", latitude: 10, longitude: 10 },
    ]);
    for (const p of points) {
      expect(p.xPercent).toBeGreaterThanOrEqual(0);
      expect(p.xPercent).toBeLessThanOrEqual(100);
      expect(p.yPercent).toBeGreaterThanOrEqual(0);
      expect(p.yPercent).toBeLessThanOrEqual(100);
    }
  });
});

describe("computeDensityGrid", () => {
  it("returns no cells for no points", () => {
    expect(computeDensityGrid([])).toEqual([]);
  });

  it("groups nearby points into the same real cell with an accurate count", () => {
    const points = projectPoints([
      { id: "a", latitude: 16.001, longitude: 80.001 },
      { id: "b", latitude: 16.002, longitude: 80.002 },
      { id: "c", latitude: 40.0, longitude: -70.0 },
    ]);
    const grid = computeDensityGrid(points, 6);
    const totalCounted = grid.reduce((sum, cell) => sum + cell.count, 0);
    expect(totalCounted).toBe(3);
    // The two close points should land in a cell with count >= 2 somewhere.
    expect(grid.some((cell) => cell.count >= 2)).toBe(true);
  });
});
