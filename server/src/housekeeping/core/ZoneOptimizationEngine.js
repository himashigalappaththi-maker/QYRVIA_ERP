'use strict';

/**
 * ZoneOptimizationEngine - clusters tasks by physical zone (building / floor /
 * wing / zone key) to minimize walking time. Deterministic.
 *
 * Each task carries a `zone` key; within a zone, tasks are ordered by priority
 * (desc) then roomId so a cleaner works a contiguous area highest-priority
 * first.
 */

function zoneKey(task) { return task.zone || 'UNZONED'; }

function cluster(tasks = []) {
  const map = new Map();
  for (const t of tasks) {
    const z = zoneKey(t);
    if (!map.has(z)) map.set(z, []);
    map.get(z).push(t);
  }
  const clusters = [];
  for (const z of Array.from(map.keys()).sort()) {
    const list = map.get(z).slice().sort((a, b) =>
      (b.priority - a.priority) || String(a.roomId).localeCompare(String(b.roomId)));
    clusters.push({ zone: z, taskIds: list.map((t) => t.id), tasks: list });
  }
  return clusters;
}

/** Flat walking route: zones grouped, highest-priority-first within each. */
function routeOrder(tasks = []) {
  return cluster(tasks).flatMap((c) => c.tasks);
}

module.exports = { cluster, routeOrder, zoneKey };
