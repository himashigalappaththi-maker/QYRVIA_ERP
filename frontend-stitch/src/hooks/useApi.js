// useApi - load data into a container with loading + error states. The dumb-UI
// pattern: call a service, render on success, show an error state on failure
// (401/403 are already handled centrally by apiClient).
import { setHTML } from '../utils/dom.js';
import { loading, errorState } from '../components/ui.js';

export async function loadInto(container, loader, renderFn) {
  setHTML(container, loading());
  try {
    const data = await loader();
    setHTML(container, renderFn(data));
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      setHTML(container, errorState(e.status === 403 ? 'You do not have access to this resource.' : 'Session expired.'));
      return;
    }
    setHTML(container, errorState((e && e.message) || 'Failed to load data.'));
  }
}
