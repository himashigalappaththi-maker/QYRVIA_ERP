'use strict';

/**
 * WorkloadBalancer - deterministic assignment of tasks to staff, balancing
 * estimated minutes against per-employee capacity to prevent overload.
 *
 * Tasks are taken highest-priority-first; each is given to the eligible
 * employee with the lowest current load (zone-preferred when set). A task that
 * fits no remaining capacity is returned as `unassigned` (never overloads).
 */

function balance(tasks = [], employees = [], { respectZone = true } = {}) {
  const state = employees.map((e) => ({
    employeeId: e.employeeId,
    capacityMinutes: Number(e.capacityMinutes) || 0,
    zone: e.zone || null,
    taskIds: [],
    workloadMinutes: 0,
    zonesTouched: new Set()
  }));

  const ordered = tasks.slice().sort((a, b) =>
    (b.priority - a.priority) || (b.estimatedMinutes - a.estimatedMinutes) || String(a.id).localeCompare(String(b.id)));

  const unassigned = [];
  for (const task of ordered) {
    const mins = Number(task.estimatedMinutes) || 0;
    let eligible = state.filter((s) => s.workloadMinutes + mins <= s.capacityMinutes);
    if (respectZone && task.zone) {
      const zoneMatch = eligible.filter((s) => s.zone === task.zone || s.zone === null);
      if (zoneMatch.length > 0) eligible = zoneMatch;
    }
    if (eligible.length === 0) { unassigned.push(task.id); continue; }
    // lowest current load; deterministic tie-break by employeeId
    eligible.sort((a, b) => (a.workloadMinutes - b.workloadMinutes) || String(a.employeeId).localeCompare(String(b.employeeId)));
    const target = eligible[0];
    target.taskIds.push(task.id);
    target.workloadMinutes += mins;
    if (task.zone) target.zonesTouched.add(task.zone);
  }

  const assignments = state.map((s) => ({
    employeeId: s.employeeId,
    taskIds: s.taskIds,
    workloadMinutes: s.workloadMinutes,
    zone: s.zonesTouched.size === 1 ? Array.from(s.zonesTouched)[0] : (s.zone || null)
  }));
  return { assignments, unassigned };
}

module.exports = { balance };
