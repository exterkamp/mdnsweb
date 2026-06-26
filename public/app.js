let currentRecords = [];
let serverIp = '127.0.0.1';
let editingId = null;
let scanCandidates = [];
let lastRecordsJson = '';
let lastLogsJson = '';

// ── Toasts ──────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? 'check_circle' : 'error';
  toast.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

// ── URL helper ──────────────────────────────────────────────
function buildUrl(record) {
  if (!record.port) return `http://${record.name}`;
  const proto = record.serviceType === '_https._tcp' ? 'https' : 'http';
  const defaultPort = proto === 'https' ? 443 : 80;
  return record.port === defaultPort
    ? `${proto}://${record.name}`
    : `${proto}://${record.name}:${record.port}`;
}

function copyToClipboard(text, label) {
  navigator.clipboard.writeText(text).then(() => showToast(`Copied ${label}`));
}

// ── Data loading ────────────────────────────────────────────
async function loadRecords() {
  try {
    const res = await fetch('/api/records');
    if (!res.ok) throw new Error();
    const data = await res.json();

    const newJson = JSON.stringify(data.records);
    const changed = newJson !== lastRecordsJson;
    lastRecordsJson = newJson;
    currentRecords = data.records;
    serverIp = data.serverIp;

    document.getElementById('stat-ip').textContent = data.serverIp;
    document.getElementById('stat-hostname').textContent = data.serverName;

    if (changed && editingId === null) renderRecords();
  } catch {
    showToast('Error loading records', 'error');
  }
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('stat-uptime').textContent = formatUptime(data.uptime);

    const newJson = JSON.stringify(data.activityLog);
    if (newJson !== lastLogsJson) {
      lastLogsJson = newJson;
      renderLogs(data.activityLog);
    }
  } catch {}
}

// ── Add record dialog ───────────────────────────────────────
function openAddDialog() {
  document.getElementById('add-record-dialog').show();
}

function closeAddDialog() {
  document.getElementById('add-record-dialog').close();
}

async function submitAddRecord() {
  const nameEl     = document.getElementById('record-name');
  const ipEl       = document.getElementById('record-ip');
  const portEl     = document.getElementById('record-port');
  const protocolEl = document.getElementById('record-protocol');
  const descEl     = document.getElementById('record-description');

  const name        = nameEl.value.trim();
  const ip          = ipEl.value.trim() || serverIp;
  const port        = portEl.value.trim() || null;
  const serviceType = protocolEl.value;
  const description = descEl.value.trim();

  if (!name) { showToast('Hostname is required', 'error'); return; }

  try {
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, description, port, serviceType }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to add record');

    closeAddDialog();
    nameEl.value = '';
    ipEl.value   = '';
    portEl.value = '';
    descEl.value = '';

    showToast(`Registered ${result.name}`);
    loadRecords();
    loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Delete ──────────────────────────────────────────────────
async function deleteRecord(id, name) {
  if (!confirm(`Delete record for ${name}?`)) return;
  try {
    const res = await fetch(`/api/records/${id}`, { method: 'DELETE' });
    if (!res.ok) { const r = await res.json(); throw new Error(r.error); }
    showToast(`Deleted ${name}`);
    loadRecords(); loadStatus();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Toggle ──────────────────────────────────────────────────
async function toggleRecord(id, enabled) {
  try {
    const res = await fetch(`/api/records/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) { const r = await res.json(); throw new Error(r.error); }
    const updated = await res.json();
    showToast(`${updated.name} ${updated.enabled ? 'enabled' : 'disabled'}`);
    loadRecords(); loadStatus();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Edit ────────────────────────────────────────────────────
function startEditing(id)  { editingId = id;   renderRecords(); }
function cancelEditing()   { editingId = null;  renderRecords(); }

async function saveEdit(id) {
  const nameEl     = document.getElementById(`edit-name-${id}`);
  const ipEl       = document.getElementById(`edit-ip-${id}`);
  const portEl     = document.getElementById(`edit-port-${id}`);
  const protocolEl = document.getElementById(`edit-protocol-${id}`);
  const descEl     = document.getElementById(`edit-desc-${id}`);

  const body = {
    name:        nameEl.value.trim(),
    ip:          ipEl.value.trim(),
    port:        portEl.value.trim() || null,
    serviceType: protocolEl.value,
    description: descEl.value.trim(),
  };

  try {
    const res = await fetch(`/api/records/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to save');
    showToast('Record updated');
    editingId = null;
    loadRecords(); loadStatus();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Render Records ──────────────────────────────────────────
function renderRecords() {
  const container = document.getElementById('records-list-container');
  document.getElementById('record-count').textContent = `${currentRecords.length} Total`;

  if (currentRecords.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined">inbox</span>
        <p>No records yet. Add one or scan Docker.</p>
      </div>`;
    return;
  }

  container.innerHTML = currentRecords.map(record => {
    if (editingId === record.id) {
      const proto = record.serviceType || '_http._tcp';
      return `
        <div class="record-item" style="flex-direction:column;align-items:stretch;">
          <div class="edit-form">
            <md-outlined-text-field id="edit-name-${record.id}" label="Hostname" value="${record.name}" required></md-outlined-text-field>
            <md-outlined-text-field id="edit-ip-${record.id}" label="Target IP" value="${record.ip}" required></md-outlined-text-field>
            <div class="port-row">
              <md-outlined-text-field id="edit-port-${record.id}" label="Port" type="number" min="1" max="65535" value="${record.port || ''}"></md-outlined-text-field>
              <md-outlined-select id="edit-protocol-${record.id}" label="Protocol" data-current="${proto}">
                <md-select-option value="_http._tcp">
                  <div slot="headline">HTTP</div>
                </md-select-option>
                <md-select-option value="_https._tcp">
                  <div slot="headline">HTTPS</div>
                </md-select-option>
              </md-outlined-select>
            </div>
            <md-outlined-text-field id="edit-desc-${record.id}" label="Description" value="${(record.description || '').replace(/"/g, '&quot;')}"></md-outlined-text-field>
            <div class="edit-actions">
              <md-text-button onclick="cancelEditing()">Cancel</md-text-button>
              <md-filled-button onclick="saveEdit('${record.id}')">
                <span class="material-symbols-outlined" slot="icon">check</span>
                Save
              </md-filled-button>
            </div>
          </div>
        </div>`;
    }

    const url = buildUrl(record);
    const bonjourBadge = record.port
      ? `<span class="badge badge-bonjour" title="Bonjour advertised">
           <span class="material-symbols-outlined">wifi_tethering</span>${record.serviceType === '_https._tcp' ? 'https' : 'http'}:${record.port}
         </span>`
      : '';

    return `
      <div class="record-item${record.enabled ? '' : ' is-disabled'}">
        <div class="record-info">
          <div class="record-name-row">
            <a href="${url}" target="_blank" class="record-domain">${record.name}</a>
            <span class="badge badge-ip">${record.ip}</span>
            ${bonjourBadge}
          </div>
          <p class="record-desc">${record.description || 'No description'}</p>
        </div>
        <div class="record-actions">
          <md-switch ${record.enabled ? 'selected' : ''} title="${record.enabled ? 'Disable' : 'Enable'}" onchange="toggleRecord('${record.id}', this.selected)"></md-switch>
          <md-icon-button title="Copy URL" onclick="copyToClipboard('${url}', '${record.name}')">
            <span class="material-symbols-outlined">content_copy</span>
          </md-icon-button>
          <md-icon-button title="Edit" onclick="startEditing('${record.id}')">
            <span class="material-symbols-outlined">edit</span>
          </md-icon-button>
          <md-icon-button title="Delete" onclick="deleteRecord('${record.id}', '${record.name}')">
            <span class="material-symbols-outlined" style="color:var(--md-sys-color-error);">delete</span>
          </md-icon-button>
        </div>
      </div>`;
  }).join('');

  // Set select values after Material Web upgrades
  queueMicrotask(() => {
    document.querySelectorAll('md-outlined-select[data-current]').forEach(el => {
      el.value = el.dataset.current;
    });
  });
}

// ── Render Logs ─────────────────────────────────────────────
function renderLogs(logs) {
  const tbody = document.getElementById('logs-container');
  if (!logs || logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="log-empty">No traffic yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = logs.map(log => `
    <tr class="log-row-${log.type}">
      <td class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</td>
      <td><span class="log-badge log-badge-${log.type}">${log.type}</span></td>
      <td>${log.message}</td>
      <td>${log.details}</td>
    </tr>`).join('');
}

// ── Docker Scan ─────────────────────────────────────────────
async function openScanModal() {
  const dialog = document.getElementById('scan-dialog');
  document.getElementById('scan-modal-body').innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;padding:2.5rem;">
      <md-circular-progress indeterminate></md-circular-progress>
    </div>`;
  document.getElementById('scan-select-all').checked = false;
  dialog.show();

  try {
    const res = await fetch('/api/docker-scan');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    scanCandidates = data.candidates;
    renderScanResults();
  } catch (err) {
    document.getElementById('scan-modal-body').innerHTML =
      `<p style="color:var(--md-sys-color-error);text-align:center;padding:2rem;">${err.message}</p>`;
  }
}

function closeScanModal() {
  document.getElementById('scan-dialog').close();
  scanCandidates = [];
}

document.getElementById('scan-dialog').addEventListener('close', () => {
  scanCandidates = [];
});

function toggleSelectAll(checked) {
  document.querySelectorAll('.scan-cb').forEach(cb => {
    if (!cb.disabled) cb.checked = checked;
  });
}

function renderScanResults() {
  const body = document.getElementById('scan-modal-body');
  const existingNames = new Set(currentRecords.map(r => r.name.toLowerCase()));

  if (scanCandidates.length === 0) {
    body.innerHTML = `<p style="color:var(--md-sys-color-on-surface-variant);text-align:center;padding:2rem;">No containers with mapped ports found.</p>`;
    return;
  }

  body.innerHTML = `
    <table class="scan-table">
      <thead>
        <tr>
          <th></th>
          <th>Hostname</th>
          <th>IP</th>
          <th>Port</th>
          <th>Protocol</th>
        </tr>
      </thead>
      <tbody>
        ${scanCandidates.map((c, i) => {
          const exists = existingNames.has(c.name.toLowerCase());
          return `
            <tr class="${exists ? 'exists' : ''}">
              <td><md-checkbox class="scan-cb" data-index="${i}" ${!exists ? 'checked' : 'disabled'}></md-checkbox></td>
              <td class="scan-mono">${c.name}${exists ? ' <span style="font-size:0.7rem;opacity:0.6;">(exists)</span>' : ''}</td>
              <td class="scan-mono" style="color:var(--md-sys-color-on-surface-variant);">${c.ip}</td>
              <td class="scan-mono" style="color:var(--md-sys-color-on-surface-variant);">${c.port}</td>
              <td>
                <select class="scan-select scan-proto" data-index="${i}" ${exists ? 'disabled' : ''}>
                  <option value="_http._tcp">HTTP</option>
                  <option value="_https._tcp">HTTPS</option>
                </select>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function importSelected() {
  const checkboxes = Array.from(document.querySelectorAll('.scan-cb')).filter(cb => cb.checked && !cb.disabled);
  if (checkboxes.length === 0) { showToast('Nothing selected', 'error'); return; }

  let ok = 0, fail = 0;
  for (const cb of checkboxes) {
    const i = parseInt(cb.dataset.index, 10);
    const candidate = { ...scanCandidates[i] };
    const protoEl = document.querySelector(`.scan-proto[data-index="${i}"]`);
    if (protoEl) candidate.serviceType = protoEl.value;

    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidate),
    });
    res.ok ? ok++ : fail++;
  }

  closeScanModal();
  loadRecords(); loadStatus();
  if (ok)   showToast(`Imported ${ok} record${ok > 1 ? 's' : ''}`);
  if (fail) showToast(`${fail} failed to import`, 'error');
}

// ── Init ────────────────────────────────────────────────────
loadRecords();
loadStatus();
setInterval(() => { loadRecords(); loadStatus(); }, 3000);

// ── Dev hot reload ───────────────────────────────────────────
fetch('/api/meta').then(r => r.json()).then(({ dev }) => {
  if (!dev) return;
  (function connect() {
    const es = new EventSource('/__dev_reload');
    let ready = false;
    es.onopen = () => { if (ready) location.reload(); ready = true; };
    es.onmessage = () => location.reload();
    es.onerror = () => { es.close(); setTimeout(connect, 1500); };
  })();
});
