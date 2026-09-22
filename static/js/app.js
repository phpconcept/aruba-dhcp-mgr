/* Aruba DHCP Manager — logique commune : connexion switch, bandeau d'état,
 * pools et réservations DHCP.
 * Reprend le principe de l'ancien ArubaDhcpMgt (PHP) : aucun identifiant
 * n'est jamais gardé côté navigateur au-delà du formulaire de la popup ;
 * seul le cookie de session (opaque) permet de retrouver la connexion
 * active côté serveur.
 */

let g_status = { connected: [], current: null };
let g_currentPool = null;

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

function formatNow() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} à ${hh}h${min}`;
}

function setLastUpdated(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = `Dernière mise à jour : ${formatNow()}`;
}

function refreshCurrentPage() {
  if (document.getElementById('pools-table-body')) loadPoolsIfConnected();
  if (document.getElementById('bindings-table-body')) loadBindingsIfConnected();
  if (document.getElementById('pool-detail-content')) loadPoolDetailIfConnected();
  if (document.getElementById('dashboard-switch-list')) renderDashboardSwitchCards();
  if (document.getElementById('switch-detail-content')) loadSwitchDetailIfConnected();
}

function csvToList(value) {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function isValidIPv4(value) {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
}

function isValidMac(value) {
  const cleaned = value.trim().toUpperCase().replace(/[:\-.]/g, '');
  return /^[0-9A-F]{12}$/.test(cleaned);
}

function isValidName(value) {
  return /^[A-Za-z0-9-]+$/.test(value.trim());
}

const NAME_MAX_LENGTH = 32; // limite ArubaOS-Switch sur le nom d'un pool DHCP

function nameValidationError(name) {
  if (!isValidName(name)) {
    return `Nom invalide : « ${name} » (lettres, chiffres et tirets uniquement).`;
  }
  if (name.length > NAME_MAX_LENGTH) {
    return `Nom trop long : « ${name} » (${name.length} caractères, ${NAME_MAX_LENGTH} max).`;
  }
  return null;
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

function ipInSubnet(ip, network, mask) {
  const ipInt = ipToInt(ip);
  const netInt = ipToInt(network);
  const maskInt = ipToInt(mask);
  return (ipInt & maskInt) === (netInt & maskInt);
}

function switchName(switchId) {
  const sw = AVAILABLE_SWITCHES.find((s) => s.id === switchId);
  return sw ? sw.name : switchId;
}

function populateSwitchSelects() {
  const html = AVAILABLE_SWITCHES.map((s) => `<option value="${s.id}">${s.name} (${s.host})</option>`).join('');
  document.getElementById('connect-switch-id').innerHTML = html;
}

function updateBanner() {
  const banner = document.getElementById('connection-banner');
  const text = document.getElementById('connection-banner-text');
  const btnRefresh = document.getElementById('btn-refresh');

  if (g_status.current && g_status.connected.includes(g_status.current)) {
    banner.classList.remove('alert-warning');
    banner.classList.add('alert-success');
    text.textContent = `Connecté à ${switchName(g_status.current)}`;
    btnRefresh.classList.remove('d-none');
  } else {
    banner.classList.remove('alert-success');
    banner.classList.add('alert-warning');
    text.textContent = 'Aucun switch connecté';
    btnRefresh.classList.add('d-none');
  }
}

async function refreshStatus() {
  g_status = await apiFetch('/api/switch/status');
  updateBanner();
  return g_status;
}

function openConnectModal(switchId) {
  document.getElementById('modal-connect-error').classList.add('d-none');
  document.getElementById('connect-password').value = '';
  if (switchId) document.getElementById('connect-switch-id').value = switchId;
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

  // Connexion réussie : direction la fiche de ce switch plutôt que de
  // rester sur la page courante (navigation complète, plus simple qu'un
  // rechargement en place puisqu'on change de page de toute façon).
  window.location.href = `/switches/${encodeURIComponent(switchId)}`;
}

async function disconnectSwitch(switchId) {
  await apiFetch('/api/switch/disconnect', {
    method: 'POST',
    body: JSON.stringify({ switch_id: switchId }),
  });
  await refreshCurrentPage();
}

async function renderDashboardSwitchCards() {
  const container = document.getElementById('dashboard-switch-list');
  if (!container) return;
  await refreshStatus();

  if (AVAILABLE_SWITCHES.length === 0) {
    container.innerHTML = '<p class="text-muted">Aucun switch enregistré pour l\'instant.</p>';
    return;
  }

  container.innerHTML = AVAILABLE_SWITCHES.map((s) => {
    const isConnected = g_status.connected.includes(s.id);
    const connectBtn = isConnected
      ? `<button type="button" class="btn btn-sm btn-outline-danger me-2" onclick="disconnectSwitch('${s.id}')">Déconnecter</button>`
      : `<button type="button" class="btn btn-sm btn-outline-primary me-2" onclick="openConnectModal('${s.id}')">Connecter</button>`;
    // La suppression se fait depuis la fiche du switch (/switches/<id>),
    // pas depuis la carte, pour alléger le dashboard.
    return `
    <div class="col-md-4">
      <div class="card ${isConnected ? 'border-success' : ''}">
        <div class="card-body">
          <h5 class="card-title"><a href="/switches/${encodeURIComponent(s.id)}" class="link-discreet">${s.name}</a></h5>
          <p class="card-text text-muted">${s.host}</p>
          ${connectBtn}
        </div>
      </div>
    </div>
  `;
  }).join('');
}

function openAddSwitchModal() {
  document.getElementById('modal-add-switch-error').classList.add('d-none');
  document.getElementById('new-switch-name').value = '';
  document.getElementById('new-switch-host').value = '';
  new bootstrap.Modal(document.getElementById('modal-add-switch')).show();
}

async function submitAddSwitch() {
  const errorBox = document.getElementById('modal-add-switch-error');
  errorBox.classList.add('d-none');

  const payload = {
    name: document.getElementById('new-switch-name').value,
    host: document.getElementById('new-switch-host').value,
  };

  const result = await apiFetch('/api/switches', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || "Échec de l'ajout du switch.";
    errorBox.classList.remove('d-none');
    return;
  }

  location.reload();
}

function deleteSwitch(switchId, switchLabel) {
  confirmAction(`Supprimer le switch "${switchLabel}" de la liste ?`, async () => {
    const result = await apiFetch(`/api/switches/${encodeURIComponent(switchId)}`, { method: 'DELETE' });
    if (!result.ok) {
      const errorBox = document.getElementById('dashboard-error') || document.getElementById('switch-detail-error');
      if (errorBox) {
        errorBox.textContent = result.error || 'Échec de la suppression.';
        errorBox.classList.remove('d-none');
      }
      return;
    }
    // Si on supprime le switch depuis sa propre fiche, la page n'a plus lieu
    // d'être : retour au dashboard plutôt qu'un rechargement sur place.
    if (window.location.pathname === `/switches/${switchId}`) {
      window.location.href = '/';
    } else {
      location.reload();
    }
  });
}

// ------------------------------------------------------------------
// Pools DHCP
// ------------------------------------------------------------------

async function loadPoolsIfConnected() {
  const tbody = document.getElementById('pools-table-body');
  const errorBox = document.getElementById('pools-error');
  if (!tbody) return;
  await refreshStatus();
  errorBox.classList.add('d-none');

  if (!g_status.current) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Connectez-vous à un switch pour afficher les pools.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Chargement en cours...</td></tr>';
  const result = await apiFetch(`/api/pools?switch_id=${g_status.current}`);
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    tbody.innerHTML = '';
    return;
  }

  setLastUpdated('pools-last-updated');

  if (result.pools.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Aucun pool configuré.</td></tr>';
    return;
  }

  tbody.innerHTML = result.pools.map((p) => `
    <tr>
      <td><a href="/pools/${encodeURIComponent(p.name)}">${p.name}</a></td>
      <td>${p.ip || ''}</td>
      <td>${p.mask || ''}</td>
      <td>${p.default_gateways.join(', ')}</td>
      <td>${p.dns_servers.join(', ')}</td>
      <td>${p.ip_ranges.map((r) => `${r.ip_start} - ${r.ip_end}`).join('<br>')}</td>
      <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="deletePool('${p.name}')">Supprimer</button></td>
    </tr>
  `).join('');
}

function openAddPoolModal() {
  document.getElementById('modal-add-pool-error').classList.add('d-none');
  ['pool-name', 'pool-ip', 'pool-mask', 'pool-gateways', 'pool-dns'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  new bootstrap.Modal(document.getElementById('modal-add-pool')).show();
}

async function submitAddPool() {
  const errorBox = document.getElementById('modal-add-pool-error');
  errorBox.classList.add('d-none');

  const ip = document.getElementById('pool-ip').value.trim();
  const mask = document.getElementById('pool-mask').value.trim() || '255.255.255.0';
  const name = document.getElementById('pool-name').value.trim();

  if (!ip) {
    errorBox.textContent = "L'adresse IP réseau est requise.";
    errorBox.classList.remove('d-none');
    return;
  }
  if (!isValidIPv4(ip)) {
    errorBox.textContent = `Adresse IP réseau invalide : « ${ip} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (!isValidIPv4(mask)) {
    errorBox.textContent = `Masque invalide : « ${mask} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (name) {
    const nameError = nameValidationError(name);
    if (nameError) {
      errorBox.textContent = nameError;
      errorBox.classList.remove('d-none');
      return;
    }
  }

  const payload = {
    switch_id: g_status.current,
    name,
    ip,
    mask,
    default_gateways: csvToList(document.getElementById('pool-gateways').value),
    dns_servers: csvToList(document.getElementById('pool-dns').value),
  };

  const result = await apiFetch('/api/pools', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || 'Échec de la création du pool.';
    errorBox.classList.remove('d-none');
    return;
  }

  bootstrap.Modal.getInstance(document.getElementById('modal-add-pool')).hide();
  await loadPoolsIfConnected();
}

function deletePool(name) {
  confirmAction(`Supprimer le pool "${name}" ?`, async () => {
    const result = await apiFetch(`/api/pools/${encodeURIComponent(name)}?switch_id=${g_status.current}`, { method: 'DELETE' });
    if (!result.ok) {
      const errorBox = document.getElementById('pools-error');
      errorBox.textContent = result.error || 'Échec de la suppression.';
      errorBox.classList.remove('d-none');
      return;
    }
    await loadPoolsIfConnected();
  });
}

// ------------------------------------------------------------------
// Réservations (bindings) DHCP
// ------------------------------------------------------------------

async function loadBindingsIfConnected() {
  const tbody = document.getElementById('bindings-table-body');
  const errorBox = document.getElementById('bindings-error');
  if (!tbody) return;
  await refreshStatus();
  errorBox.classList.add('d-none');

  if (!g_status.current) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Connectez-vous à un switch pour afficher les réservations.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Chargement en cours...</td></tr>';
  const result = await apiFetch(`/api/bindings?switch_id=${g_status.current}`);
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    tbody.innerHTML = '';
    return;
  }

  setLastUpdated('bindings-last-updated');

  if (result.bindings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Aucune réservation.</td></tr>';
    return;
  }

  tbody.innerHTML = result.bindings.map((b) => {
    const isStatic = b.type === 'static';
    const label = b.name || b.pool || '';
    const deleteBtn = isStatic
      ? `<button type="button" class="btn btn-sm btn-outline-danger" onclick="deleteBinding('${b.name}')">Supprimer</button>`
      : '';
    return `
    <tr>
      <td>${b.ip}</td>
      <td>${b.mac}</td>
      <td>${b.type}</td>
      <td>${b.expire}</td>
      <td>${label}</td>
      <td>${deleteBtn}</td>
    </tr>
  `;
  }).join('');
}

function openAddBindingModal() {
  document.getElementById('modal-add-binding-error').classList.add('d-none');
  ['binding-name', 'binding-mac', 'binding-ip', 'binding-ip-mask'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  new bootstrap.Modal(document.getElementById('modal-add-binding')).show();
}

async function submitAddBinding() {
  const errorBox = document.getElementById('modal-add-binding-error');
  errorBox.classList.add('d-none');

  const ip = document.getElementById('binding-ip').value.trim();
  const mac = document.getElementById('binding-mac').value.trim();
  const name = document.getElementById('binding-name').value.trim();

  if (!isValidIPv4(ip)) {
    errorBox.textContent = `Adresse IP invalide : « ${ip} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (!isValidMac(mac)) {
    errorBox.textContent = `Adresse MAC invalide : « ${mac} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (name) {
    const nameError = nameValidationError(name);
    if (nameError) {
      errorBox.textContent = nameError;
      errorBox.classList.remove('d-none');
      return;
    }
  }

  const payload = {
    switch_id: g_status.current,
    name,
    mac,
    ip,
    ip_mask: document.getElementById('binding-ip-mask').value.trim(),
  };

  const result = await apiFetch('/api/bindings', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || 'Échec de la création de la réservation.';
    errorBox.classList.remove('d-none');
    return;
  }

  bootstrap.Modal.getInstance(document.getElementById('modal-add-binding')).hide();
  await loadBindingsIfConnected();
}

function deleteBinding(name) {
  confirmAction(`Supprimer la réservation "${name}" ?`, async () => {
    const result = await apiFetch(`/api/bindings/${encodeURIComponent(name)}?switch_id=${g_status.current}`, { method: 'DELETE' });
    if (!result.ok) {
      const errorBox = document.getElementById('bindings-error');
      errorBox.textContent = result.error || 'Échec de la suppression.';
      errorBox.classList.remove('d-none');
      return;
    }
    await loadBindingsIfConnected();
  });
}

// ------------------------------------------------------------------
// Confirmation générique (remplace window.confirm pour les suppressions)
// ------------------------------------------------------------------

let g_confirmCallback = null;

function confirmAction(message, onConfirm) {
  document.getElementById('modal-confirm-text').textContent = message;
  g_confirmCallback = onConfirm;
  new bootstrap.Modal(document.getElementById('modal-confirm')).show();
}

// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  populateSwitchSelects();
  refreshStatus();
  document.getElementById('btn-connect-submit').addEventListener('click', submitConnect);
  document.getElementById('btn-refresh').addEventListener('click', refreshCurrentPage);
  document.getElementById('btn-confirm-submit').addEventListener('click', async () => {
    bootstrap.Modal.getInstance(document.getElementById('modal-confirm')).hide();
    if (g_confirmCallback) {
      const cb = g_confirmCallback;
      g_confirmCallback = null;
      await cb();
    }
  });
});


// ------------------------------------------------------------------
// Fiche / édition d'un pool
// ------------------------------------------------------------------

async function loadPoolDetailIfConnected() {
  const content = document.getElementById('pool-detail-content');
  const errorBox = document.getElementById('pool-detail-error');
  if (!content) return;
  await refreshStatus();
  errorBox.classList.add('d-none');
  content.classList.add('d-none');

  if (!g_status.current) {
    errorBox.textContent = 'Connectez-vous à un switch pour afficher ce pool.';
    errorBox.classList.remove('d-none');
    return;
  }

  errorBox.classList.add('d-none');
  errorBox.textContent = '';
  const loadingBox = document.getElementById('pool-detail-loading');
  loadingBox.classList.remove('d-none');

  const result = await apiFetch(`/api/pools/${encodeURIComponent(POOL_NAME)}?switch_id=${g_status.current}`);
  loadingBox.classList.add('d-none');
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    return;
  }

  renderPoolDetail(result);
  content.classList.remove('d-none');
  setLastUpdated('pool-detail-last-updated');
}

function renderPoolDetail(result) {
  const p = result.pool;
  g_currentPool = p;
  document.getElementById('detail-name').textContent = p.name;
  document.getElementById('detail-ip').textContent = p.ip || '';
  document.getElementById('detail-mask').textContent = p.mask || '';
  document.getElementById('detail-gateways').value = p.default_gateways.join(', ');
  document.getElementById('detail-dns').value = p.dns_servers.join(', ');

  const rangesBody = document.getElementById('ranges-table-body');
  rangesBody.innerHTML = p.ip_ranges.length === 0
    ? '<tr><td colspan="3" class="text-muted">Aucune plage définie.</td></tr>'
    : p.ip_ranges.map((r) => `
        <tr>
          <td>${r.ip_start}</td>
          <td>${r.ip_end}</td>
          <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="deleteRange('${r.ip_start}', '${r.ip_end}')">Supprimer</button></td>
        </tr>
      `).join('');

  const dynBody = document.getElementById('dynamic-bindings-table-body');
  dynBody.innerHTML = result.dynamic_bindings.length === 0
    ? '<tr><td colspan="3" class="text-muted">Aucun bail actif.</td></tr>'
    : result.dynamic_bindings.map((b) => `<tr><td>${b.ip}</td><td>${b.mac}</td><td>${b.expire}</td></tr>`).join('');

  const staticBody = document.getElementById('static-bindings-table-body');
  staticBody.innerHTML = result.static_bindings.length === 0
    ? '<tr><td colspan="4" class="text-muted">Aucune réservation statique détectée dans ce sous-réseau.</td></tr>'
    : result.static_bindings.map((b) => `
        <tr>
          <td>${b.name}</td>
          <td>${b.ip}</td>
          <td>${b.mac}</td>
          <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="deletePoolBinding('${b.name}')">Supprimer</button></td>
        </tr>
      `).join('');
}

function openAddPoolBindingModal() {
  document.getElementById('modal-add-pool-binding-error').classList.add('d-none');
  ['pool-binding-name', 'pool-binding-mac', 'pool-binding-ip'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  new bootstrap.Modal(document.getElementById('modal-add-pool-binding')).show();
}

async function submitAddPoolBinding() {
  const errorBox = document.getElementById('modal-add-pool-binding-error');
  errorBox.classList.add('d-none');

  const ip = document.getElementById('pool-binding-ip').value.trim();
  const mac = document.getElementById('pool-binding-mac').value.trim();
  const name = document.getElementById('pool-binding-name').value.trim();

  if (!isValidIPv4(ip)) {
    errorBox.textContent = `Adresse IP invalide : « ${ip} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (g_currentPool && !ipInSubnet(ip, g_currentPool.ip, g_currentPool.mask)) {
    errorBox.textContent = `L'IP ${ip} n'appartient pas au sous-réseau du pool (${g_currentPool.ip}/${g_currentPool.mask}).`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (!isValidMac(mac)) {
    errorBox.textContent = `Adresse MAC invalide : « ${mac} ».`;
    errorBox.classList.remove('d-none');
    return;
  }
  if (name) {
    const nameError = nameValidationError(name);
    if (nameError) {
      errorBox.textContent = nameError;
      errorBox.classList.remove('d-none');
      return;
    }
  }

  const payload = {
    switch_id: g_status.current,
    name,
    mac,
    ip,
    ip_mask: g_currentPool.mask,
  };

  const result = await apiFetch('/api/bindings', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || 'Échec de la création de la réservation.';
    errorBox.classList.remove('d-none');
    return;
  }

  bootstrap.Modal.getInstance(document.getElementById('modal-add-pool-binding')).hide();
  await loadPoolDetailIfConnected();
}

function deletePoolBinding(name) {
  confirmAction(`Supprimer la réservation "${name}" ?`, async () => {
    const errorBox = document.getElementById('pool-binding-error');
    const result = await apiFetch(`/api/bindings/${encodeURIComponent(name)}?switch_id=${g_status.current}`, { method: 'DELETE' });
    if (!result.ok) {
      errorBox.textContent = result.error || 'Échec de la suppression.';
      errorBox.classList.remove('d-none');
      return;
    }
    await loadPoolDetailIfConnected();
  });
}

async function submitSavePool() {
  const errorBox = document.getElementById('detail-edit-error');
  errorBox.classList.add('d-none');
  const payload = {
    switch_id: g_status.current,
    default_gateways: csvToList(document.getElementById('detail-gateways').value),
    dns_servers: csvToList(document.getElementById('detail-dns').value),
  };
  const result = await apiFetch(`/api/pools/${encodeURIComponent(POOL_NAME)}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || 'Échec de la mise à jour.';
    errorBox.classList.remove('d-none');
    return;
  }
  await loadPoolDetailIfConnected();
}

async function submitAddRange() {
  const errorBox = document.getElementById('detail-range-error');
  errorBox.classList.add('d-none');
  const payload = {
    switch_id: g_status.current,
    ip_start: document.getElementById('range-start').value,
    ip_end: document.getElementById('range-end').value,
  };
  const result = await apiFetch(`/api/pools/${encodeURIComponent(POOL_NAME)}/ranges`, { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) {
    errorBox.textContent = result.error || "Échec de l'ajout de la plage.";
    errorBox.classList.remove('d-none');
    return;
  }
  document.getElementById('range-start').value = '';
  document.getElementById('range-end').value = '';
  await loadPoolDetailIfConnected();
}

function deleteRange(ipStart, ipEnd) {
  confirmAction(`Supprimer la plage ${ipStart} - ${ipEnd} ?`, async () => {
    const errorBox = document.getElementById('detail-range-error');
    errorBox.classList.add('d-none');
    const params = new URLSearchParams({ switch_id: g_status.current, ip_start: ipStart, ip_end: ipEnd });
    const result = await apiFetch(`/api/pools/${encodeURIComponent(POOL_NAME)}/ranges?${params}`, { method: 'DELETE' });
    if (!result.ok) {
      errorBox.textContent = result.error || 'Échec de la suppression.';
      errorBox.classList.remove('d-none');
      return;
    }
    await loadPoolDetailIfConnected();
  });
}


// ------------------------------------------------------------------
// Fiche d'un switch (informations générales + paramètres DHCP globaux)
// ------------------------------------------------------------------

async function loadSwitchDetailIfConnected() {
  const content = document.getElementById('switch-detail-content');
  const errorBox = document.getElementById('switch-detail-error');
  const loadingBox = document.getElementById('switch-detail-loading');
  if (!content) return;
  await refreshStatus();
  renderSwitchActions();
  errorBox.classList.add('d-none');
  content.classList.add('d-none');

  if (!g_status.connected.includes(SWITCH_ID)) {
    errorBox.textContent = 'Connectez-vous à ce switch depuis le dashboard pour voir ses paramètres.';
    errorBox.classList.remove('d-none');
    return;
  }

  loadingBox.classList.remove('d-none');
  const result = await apiFetch(`/api/switches/${encodeURIComponent(SWITCH_ID)}/dhcp-status`);
  loadingBox.classList.add('d-none');

  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    return;
  }

  const badge = document.getElementById('dhcp-status-badge');
  if (result.dhcp_enabled === true) {
    badge.innerHTML = '<span class="badge bg-success">Activé</span>';
  } else if (result.dhcp_enabled === false) {
    badge.innerHTML = '<span class="badge bg-secondary">Désactivé</span>';
  } else {
    badge.innerHTML = '<span class="badge bg-warning text-dark">Indéterminé</span> <span class="text-muted small">(format de sortie switch non reconnu)</span>';
  }

  content.classList.remove('d-none');
  setLastUpdated('switch-detail-last-updated');
}

function renderSwitchActions() {
  const container = document.getElementById('switch-actions');
  if (!container) return;

  const isConnected = g_status.connected.includes(SWITCH_ID);
  const connectBtn = isConnected
    ? `<button type="button" class="btn btn-sm btn-outline-danger me-2" onclick="disconnectSwitch('${SWITCH_ID}')">Déconnecter</button>`
    : `<button type="button" class="btn btn-sm btn-outline-primary me-2" onclick="openConnectModal('${SWITCH_ID}')">Connecter</button>`;
  // Suppression réservée aux switchs déconnectés, comme sur le dashboard.
  const deleteBtn = isConnected
    ? ''
    : `<button type="button" class="btn btn-sm btn-outline-danger" onclick="deleteSwitch('${SWITCH_ID}', '${SWITCH_NAME.replace(/'/g, "\\'")}')">Supprimer</button>`;

  container.innerHTML = connectBtn + deleteBtn;
}