// Files - look up a file by id (metadata + download), and delete. The backend
// has no list endpoint and upload is multipart-oriented, so this is a lookup
// workspace. Backed by /api/files.
import { pageHeader, card, sectionTitle, btn, field, definitionList, statusBadge, infoBanner, loading, emptyState } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, datetime, num } from '../../utils/format.js';
import { asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function FilesView({ services, session }) {
  const canDelete = can(session.getPrincipal(), 'files.delete');

  async function lookup(outlet) {
    const id = (outlet.querySelector('[name="fid"]') || {}).value;
    if (!id) { toast('Enter a file id', 'error'); return; }
    const el = outlet.querySelector('#f-detail');
    el.innerHTML = loading();
    try {
      const f = asObject(await services.files.byId(id));
      if (!f || !(f.id)) { el.innerHTML = emptyState('No file found for that id', 'folder_off'); return; }
      const actions = [
        btn('Download', { action: 'f-download', id: f.id, variant: 'ghost', icon: 'download' }),
        canDelete ? btn('Delete', { action: 'f-delete', id: f.id, variant: 'danger', icon: 'delete' }) : ''
      ].join('');
      el.innerHTML = card(sectionTitle(dash(f.file_name || 'File'), actions) + definitionList([
        ['Name', dash(f.file_name)], ['Type', dash(f.mime_type)],
        ['Size', f.file_size != null ? num(f.file_size) + ' bytes' : '—'],
        ['Status', statusBadge(f.status || 'OPEN')],
        ['Uploaded', datetime(f.created_at)], ['SHA-256', `<span class="font-mono text-xs break-all">${dash(f.sha256)}</span>`]
      ]));
    } catch (e) { el.innerHTML = emptyState((e && e.message) || 'File not found', 'folder_off'); }
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Files', 'Document store lookup')
        + card(`<form id="f-look" class="flex flex-wrap items-end gap-3">
            ${field({ name: 'fid', label: 'File id', placeholder: 'Paste a file id' })}
            <div>${btn('Look up', { action: 'f-find', icon: 'search' })}</div></form>`, 'mb-5')
        + `<div id="f-detail">${infoBanner('Look up a stored file by id to view metadata or download it.')}</div>`;
      on(outlet, '[data-action="f-find"]', 'click', (e) => { e.preventDefault(); lookup(outlet); });
      on(outlet, '#f-look', 'submit', (e) => { e.preventDefault(); lookup(outlet); });
      on(outlet, '[data-action="f-download"]', 'click', async (e, t) => {
        const id = t.getAttribute('data-id');
        try {
          const r = asObject(await services.files.token(id));
          const tok = r.token || r.download_token;
          const url = '/api/files/' + encodeURIComponent(id) + '/download' + (tok ? '?token=' + encodeURIComponent(tok) : '');
          window.open(url, '_blank');
        } catch (err) { toast((err && err.message) || 'Download failed', 'error'); }
      });
      on(outlet, '[data-action="f-delete"]', 'click', async (e, t) => {
        if (!confirm('Delete this file?')) return;
        try { await services.files.remove(t.getAttribute('data-id')); toast('File deleted', 'success'); outlet.querySelector('#f-detail').innerHTML = emptyState('File deleted', 'folder_off'); }
        catch (err) { toast((err && err.message) || 'Delete failed', 'error'); }
      });
    }
  };
}
