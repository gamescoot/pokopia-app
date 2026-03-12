const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://scottharris@localhost:5432/pokopia',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all regions
app.get('/api/regions', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM regions ORDER BY id');
  res.json(rows);
});

// Get all categories
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, COUNT(ci.id)::int AS item_count
    FROM categories c
    LEFT JOIN checklist_items ci ON ci.category_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `);
  res.json(rows);
});

// Get checklist items with filtering
app.get('/api/items', async (req, res) => {
  const { category, region, search, found } = req.query;
  let where = [];
  let params = [];
  let idx = 1;

  if (category) {
    where.push(`c.name = $${idx++}`);
    params.push(category);
  }
  if (region) {
    where.push(`r.name = $${idx++}`);
    params.push(region);
  }
  if (search) {
    where.push(`ci.name ILIKE $${idx++}`);
    params.push(`%${search}%`);
  }
  if (found === 'true') where.push('ci.found = true');
  if (found === 'false') where.push('ci.found = false');

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT ci.id, ci.name, ci.description, ci.unlocks, ci.found,
           c.name AS category, r.name AS region
    FROM checklist_items ci
    JOIN categories c ON c.id = ci.category_id
    LEFT JOIN regions r ON r.id = ci.region_id
    ${whereClause}
    ORDER BY c.name, ci.name
  `, params);
  res.json(rows);
});

// Get item detail (with habitat or pokemon data)
app.get('/api/items/:id', async (req, res) => {
  const { id } = req.params;

  const { rows: [item] } = await pool.query(`
    SELECT ci.*, c.name AS category, r.name AS region
    FROM checklist_items ci
    JOIN categories c ON c.id = ci.category_id
    LEFT JOIN regions r ON r.id = ci.region_id
    WHERE ci.id = $1
  `, [id]);

  if (!item) return res.status(404).json({ error: 'Not found' });

  // Habitat data
  if (item.category === 'Habitat') {
    const { rows: components } = await pool.query(
      'SELECT * FROM habitat_components WHERE checklist_item_id = $1 ORDER BY component_name', [id]
    );
    const { rows: pokemon } = await pool.query(
      'SELECT * FROM habitat_pokemon WHERE checklist_item_id = $1 ORDER BY is_unknown, pokemon_name', [id]
    );
    item.components = components;
    item.pokemon = pokemon;
  }

  // Pokemon data
  if (item.category.startsWith('Pokémon')) {
    const { rows: [details] } = await pool.query(
      'SELECT * FROM pokemon_details WHERE checklist_item_id = $1', [id]
    );
    if (details) {
      item.details = details;
      const { rows: habitats } = await pool.query(
        'SELECT * FROM pokemon_habitats WHERE pokemon_detail_id = $1 ORDER BY is_unknown, habitat_name', [details.id]
      );
      const { rows: specialities } = await pool.query(
        'SELECT * FROM pokemon_specialities WHERE pokemon_detail_id = $1 ORDER BY speciality', [details.id]
      );
      const { rows: likes } = await pool.query(
        'SELECT * FROM pokemon_likes WHERE pokemon_detail_id = $1 ORDER BY is_unknown, preferred_habitat_climate DESC NULLS LAST', [details.id]
      );
      item.habitats = habitats;
      item.specialities = specialities;
      item.likes = likes;
    }
  }

  res.json(item);
});

// Toggle found
app.patch('/api/items/:id/toggle', async (req, res) => {
  const { rows: [item] } = await pool.query(
    'UPDATE checklist_items SET found = NOT found WHERE id = $1 RETURNING id, found', [req.params.id]
  );
  res.json(item);
});

// Progress stats
app.get('/api/progress', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      c.name AS category,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ci.found)::int AS found
    FROM checklist_items ci
    JOIN categories c ON c.id = ci.category_id
    GROUP BY c.name
    ORDER BY c.name
  `);
  const overall = rows.reduce((a, r) => ({ total: a.total + r.total, found: a.found + r.found }), { total: 0, found: 0 });
  res.json({ overall, categories: rows });
});

app.listen(PORT, () => console.log(`Pokopia Checklist running at http://localhost:${PORT}`));
