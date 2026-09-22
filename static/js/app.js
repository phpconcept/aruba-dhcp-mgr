/* Aruba DHCP Manager — logique commune : connexion switch, bandeau d'état.
 * Reprend le principe de l'ancien ArubaDhcpMgt (PHP) : aucun identifiant
 * n'est jamais gardé côté navigateur au-delà du formulaire de la popup ;
 * seul le cookie de session (opaque) permet de retrouver la connexion
 * active côté serveur.
 */

let g_status = { connected: [], current: null };

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

function switchName(switchId) {
  const sw = AVAILABLE_SWITCHES.find((s) => s.id === switchId);
  return sw ? sw.name : switchId;
}

function populateSwitchSelects() {
  const html = AVAILABLE_SWITCHES.map((s) => `<option value="${s.id}">${s.name} (${s.host})</option>`).join('');
  document.getElementById('switch-picker').innerHTML = html;
  document.getElementById('connect-switch-id').innerHTML = html;
}

function updateBanner() {
  const banner = document.getElementById('connection-banner');
  const text = document.getElementById('connection-banner-text');
  const btnConnect = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');

  if (g_status.current && g_status.connected.includes(g_status.current)) {
    banner.classList.remove('alert-warning');
    banner.classList.add('alert-success');
    text.textContent = `Connecté à ${switchName(g_status.current)}`;
    btnConnect.textContent = 'Changer de switch';
    btnDisconnect.classList.remove('d-none');
  } else {
    banner.classList.remove('alert-success');
    banner.classList.add('alert-warning');
    text.textContent = 'Aucun switch connecté';
    btnConnect.textContent = 'Se connecter';
    btnDisconnect.classList.add('d-none');
  }

  const picker = document.getElementById('switch-picker');
  if (g_status.current) picker.value = g_status.current;
}

async function refreshStatus() {
  g_status = await apiFetch('/api/switch/status');
  updateBanner();
  return g_status;
}

function openConnectModal() {
  document.getElementById('modal-connect-error').classList.add('d-none');
  document.getElementById('connect-password').value = '';
  const picker = document.getElementById('switch-picker');
  if (picker.value) document.getElementById('connect-switch-id').value = picker.value;
  new bootstrap.Modal(document.getElementById('modal-connect')).show();
}

async function submitConnect() {
  const switchId = document.getElementById('connect-switch-id').value;
  const username = document.getElementById('connect-username').value;
  const password = document.getElementById('connect-password').value;
  const errorBox = document.getElementById('modal-connect-error');
  errorBox.classList.add('d-none');

  const result = await apiFetch('/api/switch/connect', {
    method: 'POST',
    body: JSON.stringify({ switch_id: switchId, username, password }),
  });

  if (!result.ok) {
    errorBox.textContent = result.error || 'Connexion refusée.';
    errorBox.classList.remove('d-none');
    return;
  }

  bootstrap.Modal.getInstance(document.getElementById('modal-connect')).hide();
  await refreshStatus();
  document.dispatchEvent(new CustomEvent('adm:switch-connected', { detail: { switchId } }));
}

async function submitDisconnect() {
  if (!g_status.current) return;
  await apiFetch('/api/switch/disconnect', {
    method: 'POST',
    body: JSON.stringify({ switch_id: g_status.current }),
  });
  await refreshStatus();
}

function renderDashboardSwitchCards() {
  const container = document.getElementById('dashboard-switch-list');
  if (!container) return;
  container.innerHTML = AVAILABLE_SWITCHES.map((s) => `
    <div class="col-md-4">
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">${s.name}</h5>
          <p class="card-text text-muted">${s.host}</p>
        </div>
      </div>
    </div>
  `).join('');
}

async function loadPoolsIfConnected() {
  const tbody = document.getElementById('pools-table-body');
  const errorBox = document.getElementById('pools-error');
  if (!tbody) return;
  await refreshStatus();
  errorBox.classList.add('d-none');

  if (!g_status.current) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Connectez-vous à un switch pour afficher les pools.</td></tr>';
    return;
  }

  const result = await apiFetch(`/api/pools?switch_id=${g_status.current}`);
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    tbody.innerHTML = '';
    return;
  }

  if (result.pools.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Aucun pool configuré.</td></tr>';
    return;
  }

  tbody.innerHTML = result.pools.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.ip || ''}</td>
      <td>${p.mask || ''}</td>
      <td>${p.default_gateways.join(', ')}</td>
      <td>${p.dns_servers.join(', ')}</td>
      <td>${p.ip_ranges.map((r) => `${r.ip_start} - ${r.ip_end}`).join('<br>')}</td>
    </tr>
  `).join('');
}

async function loadBindingsIfConnected() {
  const tbody = document.getElementById('bindings-table-body');
  const errorBox = document.getElementById('bindings-error');
  if (!tbody) return;
  await refreshStatus();
  errorBox.classList.add('d-none');

  if (!g_status.current) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Connectez-vous à un switch pour afficher les réservations.</td></tr>';
    return;
  }

  const result = await apiFetch(`/api/bindings?switch_id=${g_status.current}`);
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    tbody.innerHTML = '';
    return;
  }

  if (result.bindings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Aucune réservation.</td></tr>';
    return;
  }

  tbody.innerHTML = result.bindings.map((b) => `
    <tr>
      <td>${b.ip}</td>
      <td>${b.mac}</td>
      <td>${b.type}</td>
      <td>${b.expire}</td>
      <td>${b.name || b.pool || ''}</td>
    </tr>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  populateSwitchSelects();
  refreshStatus();
  document.getElementById('btn-connect').addEventListener('click', openConnectModal);
  document.getElementById('btn-disconnect').addEventListener('click', submitDisconnect);
  document.getElementById('btn-connect-submit').addEventListener('click', submitConnect);
});
