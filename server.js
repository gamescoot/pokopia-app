const dns = require('dns');
const { lookup: originalLookup } = dns;
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://scottharris@localhost:5432/pokopia',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  ...(process.env.DATABASE_URL ? {
    lookup: (hostname, options, callback) => {
      options = { ...options, family: 4 };
      return originalLookup(hostname, options, callback);
    }
  } : {}),
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware - required
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth middleware - optional
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);
      req.userId = decoded.sub;
    } catch (err) { /* proceed without auth */ }
  }
  next();
}

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
app.get('/api/items', optionalAuth, async (req, res) => {
  const { category, region, search, found } = req.query;
  let where = [];
  let params = [];
  let idx = 1;

  if (req.userId) {
    params.push(req.userId);
    idx = 2;
  }

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

  const foundExpr = req.userId ? 'COALESCE(up.found, false)' : 'false';
  if (found === 'true') where.push(`${foundExpr} = true`);
  if (found === 'false') where.push(`${foundExpr} = false`);

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const joinProgress = req.userId
    ? 'LEFT JOIN user_progress up ON up.checklist_item_id = ci.id AND up.user_id = $1'
    : '';

  const { rows } = await pool.query(`
    SELECT ci.id, ci.name, ci.description, ci.unlocks,
           ${foundExpr} AS found,
           c.name AS category, r.name AS region
    FROM checklist_items ci
    JOIN categories c ON c.id = ci.category_id
    LEFT JOIN regions r ON r.id = ci.region_id
    ${joinProgress}
    ${whereClause}
    ORDER BY c.name, ci.name
  `, params);
  res.json(rows);
});

// Get item detail
app.get('/api/items/:id', optionalAuth, async (req, res) => {
  const { id } = req.params;
  let params, foundExpr, joinProgress, idParam;

  if (req.userId) {
    params = [req.userId, id];
    foundExpr = 'COALESCE(up.found, false) AS found';
    joinProgress = 'LEFT JOIN user_progress up ON up.checklist_item_id = ci.id AND up.user_id = $1';
    idParam = '$2';
  } else {
    params = [id];
    foundExpr = 'false AS found';
    joinProgress = '';
    idParam = '$1';
  }

  const { rows: [item] } = await pool.query(`
    SELECT ci.id, ci.name, ci.description, ci.unlocks, ${foundExpr},
           c.name AS category, r.name AS region
    FROM checklist_items ci
    JOIN categories c ON c.id = ci.category_id
    LEFT JOIN regions r ON r.id = ci.region_id
    ${joinProgress}
    WHERE ci.id = ${idParam}
  `, params);

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

// Toggle found - requires login
app.patch('/api/items/:id/toggle', requireAuth, async (req, res) => {
  const { rows: [result] } = await pool.query(`
    INSERT INTO user_progress (user_id, checklist_item_id, found)
    VALUES ($1, $2, true)
    ON CONFLICT (user_id, checklist_item_id)
    DO UPDATE SET found = NOT user_progress.found, updated_at = now()
    RETURNING checklist_item_id AS id, found
  `, [req.userId, req.params.id]);
  res.json(result);
});

// Progress stats
app.get('/api/progress', optionalAuth, async (req, res) => {
  let rows;
  if (req.userId) {
    ({ rows } = await pool.query(`
      SELECT c.name AS category,
             COUNT(ci.id)::int AS total,
             COUNT(up.id) FILTER (WHERE up.found)::int AS found
      FROM checklist_items ci
      JOIN categories c ON c.id = ci.category_id
      LEFT JOIN user_progress up ON up.checklist_item_id = ci.id AND up.user_id = $1
      GROUP BY c.name
      ORDER BY c.name
    `, [req.userId]));
  } else {
    ({ rows } = await pool.query(`
      SELECT c.name AS category, COUNT(ci.id)::int AS total, 0::int AS found
      FROM checklist_items ci
      JOIN categories c ON c.id = ci.category_id
      GROUP BY c.name
      ORDER BY c.name
    `));
  }
  const overall = rows.reduce((a, r) => ({ total: a.total + r.total, found: a.found + r.found }), { total: 0, found: 0 });
  res.json({ overall, categories: rows });
});

app.listen(PORT, () => console.log(`Pokopia Checklist running at http://localhost:${PORT}`));
