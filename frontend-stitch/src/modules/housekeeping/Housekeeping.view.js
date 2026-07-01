// Housekeeping - room-status board (from /api/pms/rooms) with status counts and
// per-room task creation, plus a Task Operations console (assign / complete by
// task id). The backend exposes housekeeping writes but no task LIST route, so
// task ops are id-keyed and stated honestly.
import { pageHeader, card, table, statusBadge, btn, kpiCard, modal, selectField, field, textareaField, toolbar, loading, errorState, infoBanner } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { titleCase } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const TASK_TYPES = ['CLEAN_DEPARTURE', 'CLEAN_STAYOVER', 'INSPECT', 'LINEN_CHANGE', 'TURNDOWN', 'DEEP_CLEAN', 'MAINTENANCE', 'LOST_AND_FOUND', 'OTHER'];

export function HousekeepingView({ services, session }) {
  const principal = session.getPrincipal();
  const canAssign = can(principal, 'housekeeping.assign');
  const canComplete = can(principal, 'housekeeping.complete');

  function loadBoard(outlet) {
    const body = outlet.querySelector('#hk-board');
    body.innerHTML = loading();
    services.rooms.list({}).then((res) => {
      const rooms = asArray(res);
      const counts = {};
      rooms.forEach((r) => { const s = String(r.status || 'UNKNOWN').toUpperCase(); counts[s] = (counts[s] || 0) + 1; });
      const kpis = Object.entries(counts).map(([k, v]) => kpiCard({ label: titleCase(k), value: v, icon: 'meeting_room' })).join('');
      body.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">${kpis || ''}</div>` + card(table([
        { key: 'room_number', label: 'Room' },
        { key: 'room_type_code', label: 'Type', render: (r) => r.room_type_code || '—' },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
        { label: 'Action', render: (r) => (canAssign ? btn('New task', { action: 'hk-new', id: r.id, variant: 'ghost', icon: 'add_task' }) : '') }
      ], rooms, { empty: 'No rooms configured' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load rooms'); });
  }

  function openCreateTask(outlet, roomId) {
    openOverlay(modal({ id: 'hktask', title: 'Create Housekeeping Task', body: `<form id="hk-form" class="space-y-4">
      ${selectField({ name: 'task_type', label: 'Task type', required: true, options: TASK_TYPES.map((t) => ({ value: t, label: titleCase(t) })) })}
      ${field({ name: 'room_id', label: 'Room id', value: roomId || '', required: true })}
      ${field({ name: 'scheduled_for', label: 'Scheduled for', type: 'date' })}
      ${textareaField({ name: 'notes', label: 'Notes' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Create', { action: 'hk-go', icon: 'add_task' })}` }), (root) => {
      on(root, '[data-action="hk-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#hk-form')).entries());
        if (!d.task_type) { toast('Task type required', 'error'); return; }
        try {
          const r = asObject(await services.housekeeping.createTask({ task_type: d.task_type, room_id: d.room_id || undefined, scheduled_for: d.scheduled_for || undefined, notes: d.notes || undefined }));
          toast('Task created: ' + (r.id || ''), 'success'); closeOverlay();
        } catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
      });
    });
  }

  function renderTaskOps(outlet) {
    outlet.querySelector('#hk-ops').innerHTML = card(`
      ${infoBanner('The backend does not list tasks; enter a task id to assign or complete it (task ids are returned when a task is created or auto-created at check-out).', 'task_alt')}
      <div class="flex flex-wrap items-end gap-3">
        ${field({ name: 'task_id', label: 'Task id' })}
        ${field({ name: 'user_id', label: 'Assignee user id (for assign)' })}
        <div class="flex gap-2">
          ${canAssign ? btn('Assign', { action: 'hk-assign', variant: 'secondary', icon: 'person_add' }) : ''}
          ${canComplete ? btn('Complete', { action: 'hk-complete', icon: 'task_alt' }) : ''}
        </div>
      </div>`, 'mt-6');
    const tid = () => (outlet.querySelector('[name="task_id"]') || {}).value;
    on(outlet, '[data-action="hk-assign"]', 'click', async () => {
      const id = tid(); const uid = (outlet.querySelector('[name="user_id"]') || {}).value;
      if (!id || !uid) { toast('Task id and user id required', 'error'); return; }
      try { await services.housekeeping.assignTask(id, uid); toast('Task assigned', 'success'); } catch (e) { toast((e && e.message) || 'Assign failed', 'error'); }
    });
    on(outlet, '[data-action="hk-complete"]', 'click', async () => {
      const id = tid(); if (!id) { toast('Task id required', 'error'); return; }
      try { await services.housekeeping.completeTask(id, {}); toast('Task completed', 'success'); } catch (e) { toast((e && e.message) || 'Complete failed', 'error'); }
    });
  }

  return {
    render(outlet) {
      const actions = canAssign ? btn('New Task', { action: 'hk-new-top', icon: 'add_task' }) : '';
      outlet.innerHTML = pageHeader('Housekeeping', 'Room-status board & task operations', actions)
        + '<div id="hk-board"></div><div id="hk-ops"></div>';
      loadBoard(outlet);
      renderTaskOps(outlet);
      on(outlet, '[data-action="hk-new"]', 'click', (e, t) => openCreateTask(outlet, t.getAttribute('data-id')));
      on(outlet, '[data-action="hk-new-top"]', 'click', () => openCreateTask(outlet, ''));
    }
  };
}
