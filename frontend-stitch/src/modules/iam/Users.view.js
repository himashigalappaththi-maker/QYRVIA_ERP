// Users & Roles (IAM) - read directory of users + roles, with optional user
// creation (auth.user.create via /auth/register). Backed by /api/iam + /api/auth.
import { pageHeader, card, table, statusBadge, btn, field, selectField, tabs, modal, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase, datetime } from '../../utils/format.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function UsersView({ services, session }) {
  const canCreate = can(session.getPrincipal(), 'auth.user.create');
  let activeTab = 'users';
  let rolesCache = [];

  function loadUsers(outlet) {
    const body = outlet.querySelector('#iam-body');
    body.innerHTML = loading();
    services.iam.users().then((res) => {
      body.innerHTML = card(table([
        { key: 'username', label: 'Username', render: (r) => `<span class="font-medium">${dash(r.username)}</span>` },
        { key: 'full_name', label: 'Name', render: (r) => dash(r.full_name) },
        { key: 'email', label: 'Email', render: (r) => dash(r.email) },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status || 'ACTIVE') },
        { key: 'last_login_at', label: 'Last login', render: (r) => datetime(r.last_login_at) }
      ], asArray(res), { empty: 'No users found' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load users'); });
  }

  function loadRoles(outlet) {
    const body = outlet.querySelector('#iam-body');
    body.innerHTML = loading();
    services.iam.roles().then((res) => {
      rolesCache = asArray(res);
      body.innerHTML = card(table([
        { key: 'code', label: 'Code', render: (r) => `<span class="font-mono text-xs">${dash(r.code)}</span>` },
        { key: 'name', label: 'Name', render: (r) => dash(r.name) },
        { key: 'scope', label: 'Scope', render: (r) => titleCase(r.scope) },
        { key: 'is_system', label: 'System', render: (r) => (r.is_system ? statusBadge('FINAL') : '—') },
        { key: 'description', label: 'Description', render: (r) => dash(r.description) }
      ], rolesCache, { empty: 'No roles found' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load roles'); });
  }

  function refresh(outlet) {
    outlet.querySelector('#iam-tabs').innerHTML = tabs([
      { id: 'users', label: 'Users' }, { id: 'roles', label: 'Roles' }
    ], activeTab);
    (activeTab === 'users' ? loadUsers : loadRoles)(outlet);
  }

  function openCreate(outlet) {
    // Ensure roles are available for the role picker.
    const ensure = rolesCache.length ? Promise.resolve(rolesCache) : services.iam.roles().then((r) => (rolesCache = asArray(r)));
    ensure.then(() => {
      openOverlay(modal({ id: 'unew', title: 'New User', size: 'max-w-xl', body: `<form id="uform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${field({ name: 'username', label: 'Username', required: true })}
        ${field({ name: 'full_name', label: 'Full name' })}
        ${field({ name: 'email', label: 'Email', type: 'email' })}
        ${field({ name: 'password', label: 'Temp password', type: 'password', required: true })}
        ${selectField({ name: 'role_code', label: 'Role', placeholder: 'Select role…', options: rolesCache.map((r) => ({ value: r.code, label: r.name || r.code })) })}
      </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Create user', { action: 'unew-go', icon: 'person_add' })}` }), (root) => {
        on(root, '[data-action="unew-go"]', 'click', async () => {
          const d = Object.fromEntries(new FormData(root.querySelector('#uform')).entries());
          if (!d.username || !d.password) { toast('Username and password are required', 'error'); return; }
          try { await services.iam.register(d); toast('User created', 'success'); closeOverlay(); activeTab = 'users'; refresh(outlet); }
          catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
        });
      });
    });
  }

  return {
    render(outlet) {
      const actions = canCreate ? btn('New User', { action: 'u-new', icon: 'person_add' }) : '';
      outlet.innerHTML = pageHeader('Users & Roles', 'Identity & access management', actions)
        + `<div id="iam-tabs"></div><div id="iam-body"></div>`;
      refresh(outlet);
      on(outlet, '[data-tab]', 'click', (e, t) => { activeTab = t.getAttribute('data-tab'); refresh(outlet); });
      on(outlet, '[data-action="u-new"]', 'click', () => openCreate(outlet));
    }
  };
}
