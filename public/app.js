let activeCategory = null;
let activeRegion = null;
let searchTimeout = null;

// Init
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadRegions(), loadCategories(), loadProgress()]);
  loadItems();

  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadItems(), 250);
  });

  document.getElementById('filter-found').addEventListener('change', () => loadItems());

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
});

async function loadRegions() {
  const regions = await fetch('/api/regions').then(r => r.json());
  const container = document.getElementById('region-filters');

  const allPill = document.createElement('button');
  allPill.className = 'pill active';
  allPill.textContent = 'All';
  allPill.addEventListener('click', () => {
    activeRegion = null;
    container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    allPill.classList.add('active');
    updateTitle();
    loadItems();
  });
  container.appendChild(allPill);

  regions.forEach(r => {
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.textContent = r.name;
    pill.addEventListener('click', () => {
      activeRegion = activeRegion === r.name ? null : r.name;
      container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      (activeRegion ? pill : allPill).classList.add('active');
      updateTitle();
      loadItems();
    });
    container.appendChild(pill);
  });
}

async function loadCategories() {
  const categories = await fetch('/api/categories').then(r => r.json());
  const container = document.getElementById('category-filters');

  const allBtn = document.createElement('button');
  allBtn.className = 'cat-btn active';
  allBtn.innerHTML = `<span>All</span><span class="count">${categories.reduce((s, c) => s + c.item_count, 0)}</span>`;
  allBtn.addEventListener('click', () => {
    activeCategory = null;
    container.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    updateTitle();
    loadItems();
  });
  container.appendChild(allBtn);

  categories.filter(c => c.item_count > 0).forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.innerHTML = `<span>${c.name}</span><span class="count">${c.item_count}</span>`;
    btn.addEventListener('click', () => {
      activeCategory = activeCategory === c.name ? null : c.name;
      container.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      (activeCategory ? btn : allBtn).classList.add('active');
      updateTitle();
      loadItems();
    });
    container.appendChild(btn);
  });
}

async function loadItems() {
  const params = new URLSearchParams();
  if (activeCategory) params.set('category', activeCategory);
  if (activeRegion) params.set('region', activeRegion);
  const search = document.getElementById('search').value.trim();
  if (search) params.set('search', search);
  const found = document.getElementById('filter-found').value;
  if (found) params.set('found', found);

  const items = await fetch(`/api/items?${params}`).then(r => r.json());
  renderGrid(items);
}

function renderGrid(items) {
  const grid = document.getElementById('card-grid');
  const countEl = document.getElementById('item-count');
  countEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No items match your filters</p></div>`;
    return;
  }

  grid.innerHTML = items.map(item => `
    <div class="card ${item.found ? 'found' : ''}" data-id="${item.id}">
      <div class="card-top">
        <span class="card-name">${esc(item.name)}</span>
        <button class="check-btn" data-id="${item.id}" title="Toggle found">✓</button>
      </div>
      <div class="card-tags">
        <span class="tag tag-category">${esc(item.category)}</span>
        ${item.region ? `<span class="tag tag-region">${esc(item.region)}</span>` : ''}
        ${item.unlocks ? `<span class="tag tag-unlock">🔓 ${esc(item.unlocks)}</span>` : ''}
      </div>
      ${item.description ? `<div class="card-desc">${esc(item.description)}</div>` : ''}
    </div>
  `).join('');

  // Card click -> detail
  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.check-btn')) return;
      openDetail(card.dataset.id);
    });
  });

  // Check button
  grid.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const res = await fetch(`/api/items/${id}/toggle`, { method: 'PATCH' }).then(r => r.json());
      const card = btn.closest('.card');
      card.classList.toggle('found', res.found);
      loadProgress();
    });
  });
}

async function openDetail(id) {
  const item = await fetch(`/api/items/${id}`).then(r => r.json());
  const content = document.getElementById('modal-content');

  let html = `
    <div class="modal-title">${esc(item.name)}</div>
    <div class="modal-tags">
      <span class="tag tag-category">${esc(item.category)}</span>
      ${item.region ? `<span class="tag tag-region">${esc(item.region)}</span>` : ''}
      ${item.unlocks ? `<span class="tag tag-unlock">🔓 ${esc(item.unlocks)}</span>` : ''}
    </div>
  `;

  if (item.description) {
    html += `<div class="modal-desc">${esc(item.description)}</div>`;
  }

  // Habitat detail
  if (item.components && item.components.length) {
    html += `
      <div class="modal-section">
        <h4>Components</h4>
        <table class="comp-table">
          <thead><tr><th>Item</th><th>Qty</th><th>Type</th></tr></thead>
          <tbody>
            ${item.components.map(c => `
              <tr>
                <td class="${c.is_condition ? 'condition' : ''}">${esc(c.component_name)}</td>
                <td>${c.quantity}</td>
                <td>${c.is_condition ? '<span class="condition">Condition</span>' : 'Placeable'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (item.pokemon && item.pokemon.length) {
    html += `
      <div class="modal-section">
        <h4>Discoverable Pokémon</h4>
        <div class="spawn-list">
          ${item.pokemon.map(p => {
            if (p.is_unknown) return `<span class="spawn-chip unknown">??</span>`;
            const cls = p.palette_town_only ? 'spawn-chip palette' : 'spawn-chip';
            return `<span class="${cls}">${esc(p.pokemon_name)}${p.palette_town_only ? ' (Palette Town)' : ''}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Pokemon detail
  if (item.details) {
    const d = item.details;
    html += `<div class="modal-section"><h4>Pokémon Info</h4>`;
    html += `<div class="detail-row"><span class="detail-label">Pokédex #</span><span class="detail-value">${esc(d.pokedex_number)}</span></div>`;
    if (d.pokemon_type) html += `<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">${esc(d.pokemon_type)}</span></div>`;
    if (d.preferred_flavour) html += `<div class="detail-row"><span class="detail-label">Flavour</span><span class="detail-value">${esc(d.preferred_flavour)}</span></div>`;
    html += `</div>`;
  }

  if (item.specialities && item.specialities.length) {
    html += `
      <div class="modal-section">
        <h4>Specialities</h4>
        <div class="spec-chips">
          ${item.specialities.map(s => `<span class="spec-chip">${esc(s.speciality)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  if (item.habitats && item.habitats.length) {
    html += `
      <div class="modal-section">
        <h4>Habitats</h4>
        ${item.habitats.map(h => {
          if (h.is_unknown) return `<div class="habitat-row unknown"><div class="hab-name">?? Unknown Habitat</div></div>`;
          return `
            <div class="habitat-row">
              <div class="hab-name">${esc(h.habitat_name)}${h.palette_town_only ? ' (Palette Town Only)' : ''}</div>
              <div class="hab-conds">${esc(h.time_condition || 'Any Time')} · ${esc(h.weather_condition || 'Any Weather')}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  if (item.likes && item.likes.length) {
    html += `
      <div class="modal-section">
        <h4>Likes</h4>
        <div class="like-chips">
          ${item.likes.map(l => {
            if (l.is_unknown) return `<span class="like-chip unknown">??</span>`;
            if (l.preferred_habitat_climate) return `<span class="like-chip climate">${esc(l.preferred_habitat_climate)} Habitat</span>`;
            return `<span class="like-chip">${esc(l.like_description)}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  html += `
    <button class="modal-found-btn ${item.found ? 'found' : ''}" id="modal-toggle" data-id="${item.id}">
      <span>${item.found ? '✓ Found' : 'Mark as Found'}</span>
    </button>
  `;

  content.innerHTML = html;

  document.getElementById('modal-toggle').addEventListener('click', async () => {
    const res = await fetch(`/api/items/${item.id}/toggle`, { method: 'PATCH' }).then(r => r.json());
    const btn = document.getElementById('modal-toggle');
    btn.classList.toggle('found', res.found);
    btn.querySelector('span').textContent = res.found ? '✓ Found' : 'Mark as Found';
    loadProgress();
    loadItems();
  });

  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

async function loadProgress() {
  const data = await fetch('/api/progress').then(r => r.json());
  const pct = data.overall.total ? Math.round((data.overall.found / data.overall.total) * 100) : 0;
  document.getElementById('progress-text').textContent = `${data.overall.found} / ${data.overall.total} (${pct}%)`;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function updateTitle() {
  const parts = [];
  if (activeCategory) parts.push(activeCategory);
  if (activeRegion) parts.push(activeRegion);
  document.getElementById('content-title').textContent = parts.length ? parts.join(' · ') : 'All Items';
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
