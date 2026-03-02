const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY: Secrets from env vars (#1, #18) ─────────────────────────────────
// Fallback = original secret so existing saved tokens keep working.
// In production set ADMIN_JWT_SECRET + CUSTOMER_JWT_SECRET as env vars.
const ADMIN_SECRET    = process.env.ADMIN_JWT_SECRET    || 'bsc-store-v2-secret';
const CUSTOMER_SECRET = process.env.CUSTOMER_JWT_SECRET || 'bsc-store-v2-secret';
const MONGO_URI = process.env.MONGO_URI;

// ── SECURITY: Rate limiting on login (#2) ─────────────────────────────────────
// Simple in-memory rate limiter (no extra package needed)
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 10;
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > maxAttempts) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000 / 60);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retryAfter} min.` });
  }
  next();
}
// Clean up old entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) { if (now > entry.resetAt) loginAttempts.delete(ip); }
}, 30 * 60 * 1000);

app.use(express.json({ limit: '500kb' })); // #4: reduced from 10mb
app.use(express.static(path.join(__dirname, 'public')));

// ── MONGODB ───────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('bscstore');
  console.log('✅ Connected to MongoDB');

  await db.collection('customers').createIndex({ phone: 1 }, { unique: true });
  await db.collection('customers').createIndex({ customerId: 1 });
  await db.collection('milkSubscriptions').createIndex({ customerId: 1 });
  await db.collection('milkLogs').createIndex({ customerId: 1, month: 1 });
  await db.collection('orders').createIndex({ customerId: 1, createdAt: -1 });
  await db.collection('orders').createIndex({ phone: 1 });
  // New unified ledger index
  await db.collection('ledger').createIndex({ customerId: 1, createdAt: -1 });
  // Keep old indexes for migration compat
  await db.collection('udharEntries').createIndex({ customerId: 1 });
  await db.collection('udharPayments').createIndex({ customerId: 1 });
  // Subcategories
  await db.collection('subcategories').createIndex({ catId: 1 });
  // Smart search — compound text index across all searchable fields
  await db.collection('products').createIndex(
    { name: 'text', brand: 'text', keywords: 'text', searchTokens: 'text' },
    { weights: { name: 10, brand: 5, keywords: 8, searchTokens: 3 }, name: 'product_text_search', default_language: 'none' }
  );
  await db.collection('products').createIndex({ catId: 1, subCatId: 1 });
  // Barcode & SKU indexes for fast scanner lookups
  await db.collection('products').createIndex({ barcode: 1 }, { unique: true, sparse: true });
  await db.collection('products').createIndex({ sku: 1 }, { unique: true, sparse: true });

  const settings = await db.collection('settings').findOne({ _id: 'main' });
  if (!settings) {
    await db.collection('settings').insertOne({
      _id: 'main',
      adminPassword: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
      whatsapp: '', upiId: '', minOrder: 99, storeName: 'BSC Store',
      milkPrice: 60, freeDeliveryMin: 99,
      freeGift: { threshold: 100, productId: null, qty: 1, autoAdd: false, label: '', discountPrice: 0 },
      upsellProductIds: [],
      storeLocation: null
    });
  }
}

// ── MULTER ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function getNextId(name) {
  const res = await db.collection('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return res.seq;
}

// ── STOCK HELPERS ─────────────────────────────────────────────────────────────
function computeStockStatus(stockQuantity, lowStockThreshold) {
  const qty = typeof stockQuantity === 'number' ? stockQuantity : null;
  const threshold = typeof lowStockThreshold === 'number' ? lowStockThreshold : 5;
  if (qty === null) return { stockStatus: 'In Stock', isLowStock: false }; // legacy
  if (qty === 0) return { stockStatus: 'Out of Stock', isLowStock: false };
  if (qty <= threshold) return { stockStatus: 'Low Stock', isLowStock: true };
  return { stockStatus: 'In Stock', isLowStock: false };
}

function migrateProduct(p) {
  const { stockStatus, isLowStock } = computeStockStatus(p.stockQuantity, p.lowStockThreshold);
  const base = {
    id: p.id, name: p.name, catId: p.catId || 0,
    subCatId: p.subCatId || null,
    imageUrl: p.imageUrl || '', featured: p.featured || false, isNew: p.isNew || false,
    brand: p.brand || '', keywords: p.keywords || [], searchTokens: p.searchTokens || [],
    sku: p.sku || '', barcode: p.barcode || '',
    mrp: p.mrp || null,
    stockQuantity: typeof p.stockQuantity === 'number' ? p.stockQuantity : null,
    lowStockThreshold: typeof p.lowStockThreshold === 'number' ? p.lowStockThreshold : 5,
    stockStatus, isLowStock,
    disabled: p.disabled || false,
  };
  if (p.variants) return { ...base, variants: p.variants };
  return {
    ...base,
    variants: [{ id: 'v1', label: p.unit || '1 unit', imageUrl: p.imageUrl || '',
      mrp: p.mrp || null, inStock: p.inStock !== false,
      priceTiers: p.priceTiers || [{ minQty: 1, price: 0 }] }]
  };
}

// ── SYNONYMS MAP ──────────────────────────────────────────────────────────────
// Bidirectional: searching either word will find the other
const SYNONYMS = {
  // Hindi → English
  doodh: ['milk', 'dairy'],
  dudh: ['milk', 'dairy'],
  dahi: ['curd', 'yogurt', 'yoghurt', 'set curd'],
  paneer: ['cottage cheese', 'cheese', 'chenna'],
  makhan: ['butter'],
  ghee: ['clarified butter'],
  chawal: ['rice'],
  aata: ['wheat flour', 'flour', 'atta'],
  maida: ['flour', 'refined flour', 'all purpose flour'],
  dal: ['lentils', 'pulses', 'daal'],
  sabzi: ['vegetables', 'veggies'],
  tamatar: ['tomato', 'tomatoes'],
  pyaaz: ['onion', 'onions'],
  aloo: ['potato', 'potatoes'],
  mirchi: ['chilli', 'chili', 'pepper'],
  namak: ['salt'],
  cheeni: ['sugar'],
  tel: ['oil', 'cooking oil'],
  sarson: ['mustard'],
  jeera: ['cumin'],
  haldi: ['turmeric'],
  adrak: ['ginger'],
  lehsun: ['garlic'],
  dhania: ['coriander', 'cilantro'],
  anda: ['egg', 'eggs'],
  murga: ['chicken'],
  macchi: ['fish'],
  murg: ['chicken'],
  roti: ['bread', 'chapati', 'chapatti'],
  bread: ['roti', 'pav'],
  chai: ['tea'],
  coffee: ['kafi'],
  nimbu: ['lemon', 'lime'],
  kela: ['banana'],
  seb: ['apple'],
  aam: ['mango'],
  angoor: ['grapes'],
  narangi: ['orange'],
  // English → Hindi (reverse for discoverability)
  milk: ['doodh', 'dudh', 'dairy milk'],
  curd: ['dahi', 'yogurt', 'yoghurt'],
  butter: ['makhan'],
  rice: ['chawal'],
  flour: ['aata', 'atta', 'maida'],
  potato: ['aloo'],
  onion: ['pyaaz'],
  tomato: ['tamatar'],
  egg: ['anda'],
  eggs: ['anda'],
  chicken: ['murga', 'murg'],
  bread: ['roti', 'pav'],
  tea: ['chai'],
  lemon: ['nimbu'],
  // Brand / type aliases
  toned: ['milk', 'doodh'],
  full: ['milk', 'doodh'],
  skimmed: ['milk', 'doodh'],
  lassi: ['curd', 'dahi', 'buttermilk', 'chaach'],
  chaach: ['buttermilk', 'lassi', 'curd'],
  buttermilk: ['chaach', 'lassi', 'curd', 'dahi'],
  shrikhand: ['curd', 'dahi', 'yogurt'],
  cream: ['malai'],
  malai: ['cream'],
  pouch: ['packet', 'pack'],
  packet: ['pack', 'pouch'],
};

// Expand a query string into all synonym variants (flat, deduplicated)
function expandQuery(raw) {
  const q = raw.trim().toLowerCase();
  const terms = new Set([q]);
  // Add whole-query synonym matches
  if (SYNONYMS[q]) SYNONYMS[q].forEach(s => terms.add(s));
  // Also check word-by-word
  q.split(/\s+/).forEach(word => {
    if (SYNONYMS[word]) SYNONYMS[word].forEach(s => terms.add(s));
  });
  return [...terms];
}

// Calculate balance from ledger (credits - payments)
async function getCustomerBalance(customerId) {
  const entries = await db.collection('ledger').find({ customerId }).toArray();
  let balance = 0;
  entries.forEach(e => {
    if (e.type === 'credit') balance += (e.amount || 0);
    else if (e.type === 'payment') balance -= (e.amount || 0);
  });
  return balance;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(h.replace('Bearer ', ''), ADMIN_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function customerAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), CUSTOMER_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── PUBLIC STORE ──────────────────────────────────────────────────────────────
app.get('/api/store', async (req, res) => {
  try {
    const [settings, categories, products, banners, subcategories] = await Promise.all([
      db.collection('settings').findOne({ _id: 'main' }),
      db.collection('categories').find().toArray(),
      db.collection('products').find().toArray(),
      db.collection('banners').find().toArray(),
      db.collection('subcategories').find().toArray(),
    ]);
    const fg = settings.freeGift || {};
    res.json({
      categories, products: products.map(p => {
        const migrated = migrateProduct(p);
        // For customers: mark variants as out of stock if product has 0 stock
        if (migrated.stockQuantity === 0) {
          migrated.variants = migrated.variants.map(v => ({ ...v, inStock: false }));
        }
        return migrated;
      }), banners, subcategories,
      settings: {
        storeName: settings.storeName, minOrder: settings.minOrder,
        upiId: settings.upiId, whatsapp: settings.whatsapp,
        freeDeliveryMin: settings.freeDeliveryMin || 99,
        upsellProductIds: settings.upsellProductIds || [],
        storeLocation: settings.storeLocation || null,
        freeGift: {
          threshold: fg.threshold || 0, productId: fg.productId || null,
          variantId: fg.variantId || null, qty: fg.qty || 1,
          autoAdd: fg.autoAdd !== false, label: fg.label || '',
          discountPrice: typeof fg.discountPrice === 'number' ? fg.discountPrice : 0,
        }
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', loginRateLimit, async (req, res) => {
  try {
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    if (sha256(req.body.password) !== settings.adminPassword)
      return res.status(401).json({ error: 'Wrong password' });
    res.json({ token: jwt.sign({ admin: true }, ADMIN_SECRET, { expiresIn: '30d' }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));

// ── UPLOAD ────────────────────────────────────────────────────────────────────
app.post('/api/admin/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
app.get('/api/admin/categories', adminAuth, async (req, res) => {
  try { res.json(await db.collection('categories').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const cat = { id: await getNextId('categoryId'), name: req.body.name || 'New Category', imageUrl: req.body.imageUrl || '' };
    await db.collection('categories').insertOne(cat);
    res.json(cat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.collection('categories').findOneAndUpdate(
      { id: parseInt(req.params.id) }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try { await db.collection('categories').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SUBCATEGORIES ─────────────────────────────────────────────────────────────
app.get('/api/admin/subcategories', adminAuth, async (req, res) => {
  try { res.json(await db.collection('subcategories').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    const sub = { id: await getNextId('subcategoryId'), name: req.body.name || 'New Subcategory', catId: parseInt(req.body.catId) || 0, imageUrl: req.body.imageUrl || '' };
    await db.collection('subcategories').insertOne(sub);
    res.json(sub);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.collection('subcategories').findOneAndUpdate(
      { id: parseInt(req.params.id) }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try { await db.collection('subcategories').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

// Build a flat token array from all text fields + synonym expansion
// Stored on the product for fast text-index matching
function buildSearchTokens(body) {
  const parts = [
    body.name || '',
    body.brand || '',
    ...(Array.isArray(body.keywords) ? body.keywords : (body.keywords||'').split(','))
  ];
  const tokens = new Set();
  parts.forEach(p => {
    const clean = p.toLowerCase().trim();
    if (!clean) return;
    tokens.add(clean);
    clean.split(/\s+/).forEach(word => {
      tokens.add(word);
      if (SYNONYMS[word]) SYNONYMS[word].forEach(s => tokens.add(s));
    });
    if (SYNONYMS[clean]) SYNONYMS[clean].forEach(s => tokens.add(s));
  });
  return [...tokens];
}

// ── PUBLIC SEARCH ──────────────────────────────────────────────────────────────
// GET /api/search?q=doodh
app.get('/api/search', async (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw) return res.json({ results: [] });

    const expandedTerms = expandQuery(raw);
    const q = raw.toLowerCase();

    // Build an OR regex that matches any expanded term
    const regexParts = expandedTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const orRegex = new RegExp(regexParts.join('|'), 'i');

    // 1) Fetch all products (small dataset — no pagination needed at this scale)
    const allProds = await db.collection('products').find().toArray();
    const [allCats, allSubcats] = await Promise.all([
      db.collection('categories').find().toArray(),
      db.collection('subcategories').find().toArray(),
    ]);

    // Build lookup maps for category/subcategory name matching
    const catMap = {};
    allCats.forEach(c => { catMap[c.id] = c.name.toLowerCase(); });
    const subcatMap = {};
    allSubcats.forEach(s => { subcatMap[s.id] = s.name.toLowerCase(); });

    // Score each product
    const scored = [];
    for (const p of allProds) {
      let score = 0;
      const pName = (p.name || '').toLowerCase();
      const pBrand = (p.brand || '').toLowerCase();
      const pKeywords = (p.keywords || []).map(k => k.toLowerCase());
      const pTokens = (p.searchTokens || []).map(k => k.toLowerCase());
      const pCatName = catMap[p.catId] || '';
      const pSubcatName = subcatMap[p.subCatId] || '';

      for (const term of expandedTerms) {
        const t = term.toLowerCase();
        // Exact name match — highest score
        if (pName === t) { score += 100; continue; }
        // Name starts with term
        if (pName.startsWith(t)) { score += 60; continue; }
        // Name contains term
        if (pName.includes(t)) { score += 40; }
        // Brand match
        if (pBrand === t) score += 50;
        else if (pBrand.includes(t)) score += 25;
        // Keywords exact
        if (pKeywords.includes(t)) score += 45;
        // Keywords partial
        else if (pKeywords.some(k => k.includes(t) || t.includes(k))) score += 20;
        // Search tokens
        if (pTokens.includes(t)) score += 30;
        // Category / subcategory name
        if (pCatName.includes(t)) score += 15;
        if (pSubcatName.includes(t)) score += 20;
      }

      // Boost: original query in name/brand/keywords even without synonym expansion
      if (pName.includes(q)) score += 35;
      if (pBrand.includes(q)) score += 20;
      if (pKeywords.some(k => k.includes(q))) score += 25;

      if (score > 0) scored.push({ product: migrateProduct(p), score });
    }

    // Sort by score descending, then name
    scored.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));

    res.json({
      query: raw,
      expandedTerms,
      results: scored.map(s => s.product),
      total: scored.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try { res.json((await db.collection('products').find().toArray()).map(migrateProduct)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const p = {
      id: await getNextId('productId'), name: req.body.name || 'New Product',
      catId: parseInt(req.body.catId) || 0,
      subCatId: req.body.subCatId ? parseInt(req.body.subCatId) : null,
      imageUrl: req.body.imageUrl || '',
      brand: req.body.brand || '',
      keywords: Array.isArray(req.body.keywords) ? req.body.keywords : (req.body.keywords || '').split(',').map(k=>k.trim()).filter(Boolean),
      searchTokens: buildSearchTokens(req.body),
      sku: req.body.sku || '',
      barcode: req.body.barcode || '',
      mrp: req.body.mrp ? parseFloat(req.body.mrp) : null,
      stockQuantity: req.body.stockQuantity !== undefined ? parseInt(req.body.stockQuantity) : null,
      lowStockThreshold: req.body.lowStockThreshold !== undefined ? parseInt(req.body.lowStockThreshold) : 5,
      disabled: false,
      featured: req.body.featured || false, isNew: req.body.isNew || false,
      variants: req.body.variants || [{ id: 'v1', label: '1 unit', imageUrl: '', mrp: null, inStock: true, priceTiers: [{ minQty: 1, price: 0 }] }]
    };
    await db.collection('products').insertOne(p);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.keywords && !Array.isArray(update.keywords)) {
      update.keywords = update.keywords.split(',').map(k=>k.trim()).filter(Boolean);
    }
    update.searchTokens = buildSearchTokens(update);
    // Stock fields — keep as numbers
    if (update.stockQuantity !== undefined) update.stockQuantity = parseInt(update.stockQuantity);
    if (update.lowStockThreshold !== undefined) update.lowStockThreshold = parseInt(update.lowStockThreshold);
    if (update.mrp !== undefined && update.mrp !== '') update.mrp = parseFloat(update.mrp);
    // Remove empty barcode/sku to avoid index conflicts
    if (update.barcode === '') delete update.barcode;
    if (update.sku === '') delete update.sku;
    const result = await db.collection('products').findOneAndUpdate(
      { id: parseInt(req.params.id) }, { $set: update }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(migrateProduct(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try { await db.collection('products').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BARCODE / SKU SEARCH (Admin only) ─────────────────────────────────────────
// GET /api/admin/products/search?q=8901262010023
// Searches by: barcode (exact), sku (exact), name (partial case-insensitive)
app.get('/api/admin/products/search', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    // 1) Exact barcode match
    let product = await db.collection('products').findOne({ barcode: q });
    if (!product) product = await db.collection('products').findOne({ sku: q });
    if (product) return res.json({ results: [migrateProduct(product)], matchType: product.barcode === q ? 'barcode' : 'sku' });
    // 2) Partial name match
    const byName = await db.collection('products').find({ name: { $regex: q, $options: 'i' } }).limit(10).toArray();
    res.json({ results: byName.map(migrateProduct), matchType: 'name' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STOCK MANAGEMENT ──────────────────────────────────────────────────────────
// PATCH /api/admin/products/:id/stock — update stockQuantity and/or lowStockThreshold
app.patch('/api/admin/products/:id/stock', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { stockQuantity, lowStockThreshold, adjustment } = req.body;
    const product = await db.collection('products').findOne({ id });
    if (!product) return res.status(404).json({ error: 'Not found' });
    const update = {};
    if (typeof adjustment === 'number') {
      // Relative adjustment (+/-) — safe: no negative stock
      const current = typeof product.stockQuantity === 'number' ? product.stockQuantity : 0;
      update.stockQuantity = Math.max(0, current + adjustment);
    } else if (typeof stockQuantity === 'number') {
      update.stockQuantity = Math.max(0, stockQuantity);
    }
    if (typeof lowStockThreshold === 'number') update.lowStockThreshold = Math.max(0, lowStockThreshold);
    const result = await db.collection('products').findOneAndUpdate(
      { id }, { $set: update }, { returnDocument: 'after' }
    );
    res.json(migrateProduct(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/products/low-stock — list products at or below threshold
app.get('/api/admin/products/low-stock', adminAuth, async (req, res) => {
  try {
    const products = await db.collection('products').find({
      stockQuantity: { $type: 'number' },
      $expr: { $lte: ['$stockQuantity', '$lowStockThreshold'] }
    }).toArray();
    res.json(products.map(migrateProduct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BANNERS ───────────────────────────────────────────────────────────────────
app.get('/api/admin/banners', adminAuth, async (req, res) => {
  try { res.json(await db.collection('banners').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const b = { id: await getNextId('bannerId'), imageUrl: req.body.imageUrl || '', title: req.body.title || '', subtitle: req.body.subtitle || '', bgColor: req.body.bgColor || '#1a1a2e', action: req.body.action || null };
    await db.collection('banners').insertOne(b);
    res.json(b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.collection('banners').findOneAndUpdate(
      { id: parseInt(req.params.id) }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try { await db.collection('banners').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await db.collection('settings').findOne({ _id: 'main' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { newPassword, ...rest } = req.body;
    const update = { ...rest };
    if (newPassword) update.adminPassword = sha256(newPassword);
    await db.collection('settings').updateOne({ _id: 'main' }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── CUSTOMERS (Master Registry) ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/customers', adminAuth, async (req, res) => {
  try {
    const customers = await db.collection('customers').find({ deleted: { $ne: true } }).sort({ joinedAt: -1 }).toArray();
    const subs = await db.collection('milkSubscriptions').find().toArray();
    const subMap = {};
    subs.forEach(s => { subMap[s.customerId] = s; });

    // Get ledger balances
    const ledgerEntries = await db.collection('ledger').find().toArray();
    const balanceMap = {};
    ledgerEntries.forEach(e => {
      if (!balanceMap[e.customerId]) balanceMap[e.customerId] = 0;
      if (e.type === 'credit') balanceMap[e.customerId] += (e.amount || 0);
      else if (e.type === 'payment') balanceMap[e.customerId] -= (e.amount || 0);
    });

    // Also include old udhar entries for customers not yet migrated
    const oldEntries = await db.collection('udharEntries').find().toArray();
    const oldPayments = await db.collection('udharPayments').find().toArray();
    const oldBalMap = {};
    oldEntries.forEach(e => {
      if (!oldBalMap[e.customerId]) oldBalMap[e.customerId] = 0;
      oldBalMap[e.customerId] += (e.amount || 0);
    });
    oldPayments.forEach(p => {
      if (!oldBalMap[p.customerId]) oldBalMap[p.customerId] = 0;
      oldBalMap[p.customerId] -= (p.amount || 0);
    });

    res.json(customers.map(c => ({
      ...c, pin: undefined,
      milkSubscription: subMap[c.customerId] || null,
      balance: (balanceMap[c.customerId] || 0) + (oldBalMap[c.customerId] || 0)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const c = await db.collection('customers').findOne({ customerId, deleted: { $ne: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const [milkSub, orders, ledgerEntries, oldUdharEntries, oldUdharPayments, milkLogs, milkPayments] = await Promise.all([
      db.collection('milkSubscriptions').findOne({ customerId }),
      db.collection('orders').find({ $or: [{ customerId }, { phone: c.phone }] }).sort({ createdAt: -1 }).toArray(),
      db.collection('ledger').find({ customerId }).sort({ createdAt: -1 }).toArray(),
      db.collection('udharEntries').find({ customerId }).sort({ date: -1 }).toArray(),
      db.collection('udharPayments').find({ customerId }).sort({ date: -1 }).toArray(),
      db.collection('milkLogs').find({ customerId }).sort({ date: -1 }).limit(90).toArray(),
      db.collection('milkPayments').find({ customerId }).sort({ paidAt: -1 }).toArray(),
    ]);

    // Compute balance from both new ledger and old udhar (migration compat)
    const ledgerBalance = ledgerEntries.reduce((s, e) => {
      if (e.type === 'credit') return s + (e.amount || 0);
      if (e.type === 'payment') return s - (e.amount || 0);
      return s;
    }, 0);
    const oldUdharBalance = oldUdharEntries.reduce((s, e) => s + (e.amount || 0), 0)
      - oldUdharPayments.reduce((s, p) => s + (p.amount || 0), 0);

    res.json({
      customer: { ...c, pin: undefined },
      milkSubscription: milkSub || null,
      milkLogs, milkPayments, orders,
      ledgerEntries,
      udharEntries: oldUdharEntries,
      udharPayments: oldUdharPayments,
      balance: ledgerBalance + oldUdharBalance,
      ledgerBalance,
      oldUdharBalance
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/customers', adminAuth, async (req, res) => {
  try {
    const { name, phone, address, block, villa, pin, notes, creditLimit } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    const phoneExists = await db.collection('customers').findOne({ phone, deleted: { $ne: true } });
    if (phoneExists) return res.status(409).json({ error: 'Phone already registered' });
    // If a deleted account exists with this phone, restore it instead of creating new
    const deletedExisting = await db.collection('customers').findOne({ phone, deleted: true });
    if (deletedExisting) {
      await db.collection('customers').updateOne({ phone }, { $set: {
        name, address: address||'', block: block||'', villa: villa||'',
        notes: notes||'', deleted: false, deletedAt: null,
        pin: pin ? sha256(String(pin)) : deletedExisting.pin,
        pinPlain: pin ? String(pin) : deletedExisting.pinPlain,
        active: true
      }});
      const restored = await db.collection('customers').findOne({ phone });
      return res.json({ ok: true, customer: { ...restored, pin: undefined } });
    }
    const customerId = await getNextId('customerId');
    const customer = {
      customerId, name, phone, address: address || '', block: block || '', villa: villa || '',
      pin: pin ? sha256(String(pin)) : null, pinPlain: pin ? String(pin) : null,
      active: true, tags: [], creditLimit: creditLimit || 0,
      notes: notes || '', joinedAt: new Date().toISOString()
    };
    await db.collection('customers').insertOne(customer);
    res.json({ ok: true, customer: { ...customer, pin: undefined } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const { pin, ...rest } = req.body;
    const update = { ...rest };
    // Admin can set/reset a customer's PIN
    if (pin && /^\d{4}$/.test(String(pin))) {
      update.pin = sha256(String(pin));
      update.pinPlain = String(pin);
    }
    const result = await db.collection('customers').findOneAndUpdate(
      { customerId }, { $set: update }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, customer: { ...result, pin: undefined } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SOFT DELETE — preserves all related data, sets deleted flag
app.delete('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const hard = req.query.hard === 'true';
    if (hard) {
      // Hard delete: remove everything
      await Promise.all([
        db.collection('customers').deleteOne({ customerId }),
        db.collection('milkSubscriptions').deleteOne({ customerId }),
        db.collection('ledger').deleteMany({ customerId }),
        db.collection('udharEntries').deleteMany({ customerId }),
        db.collection('udharPayments').deleteMany({ customerId }),
        db.collection('milkLogs').deleteMany({ customerId }),
        db.collection('milkPayments').deleteMany({ customerId }),
      ]);
      res.json({ ok: true, type: 'hard' });
    } else {
      // Soft delete (default)
      await db.collection('customers').updateOne(
        { customerId },
        { $set: { deleted: true, deletedAt: new Date().toISOString() } }
      );
      res.json({ ok: true, type: 'soft' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── UNIFIED LEDGER ─────────────────────────────────────────────────────────────
// Each entry: customerId, type ('credit'|'payment'), amount, note, createdAt
// ═══════════════════════════════════════════════════════════════════════════════

// Get ledger entries for a customer
app.get('/api/admin/ledger', adminAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.query.customerId);
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const entries = await db.collection('ledger').find({ customerId }).sort({ createdAt: -1 }).toArray();
    res.json(entries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add ledger entry (credit = they owe, payment = they paid)
app.post('/api/admin/ledger', adminAuth, async (req, res) => {
  try {
    const { customerId, type, amount, note, date } = req.body;
    if (!customerId || !type || !amount) return res.status(400).json({ error: 'customerId, type, amount required' });
    if (!['credit', 'payment'].includes(type)) return res.status(400).json({ error: 'type must be credit or payment' });
    const entry = {
      id: await getNextId('ledgerId'),
      customerId: parseInt(customerId),
      type, // 'credit' or 'payment'
      amount: parseFloat(amount),
      note: note || '',
      date: date || new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString()
    };
    await db.collection('ledger').insertOne(entry);
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/ledger/:id', adminAuth, async (req, res) => {
  try {
    const { amount, note, date } = req.body;
    const update = {};
    if (amount != null) update.amount = parseFloat(amount);
    if (note != null) update.note = note;
    if (date) update.date = date;
    await db.collection('ledger').updateOne({ id: parseInt(req.params.id) }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/ledger/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('ledger').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UDHAR SUMMARY (uses unified ledger + old udhar for migration compat) ────
app.get('/api/admin/udhar-summary', adminAuth, async (req, res) => {
  try {
    const customers = await db.collection('customers').find({ deleted: { $ne: true } }).toArray();
    const [ledgerAll, oldEntries, oldPayments] = await Promise.all([
      db.collection('ledger').find().toArray(),
      db.collection('udharEntries').find().toArray(),
      db.collection('udharPayments').find().toArray(),
    ]);

    const summary = customers.map(c => {
      const cid = c.customerId;
      // New ledger
      const ledger = ledgerAll.filter(e => e.customerId === cid);
      const credits = ledger.filter(e => e.type === 'credit').reduce((s, e) => s + (e.amount || 0), 0);
      const payments = ledger.filter(e => e.type === 'payment').reduce((s, e) => s + (e.amount || 0), 0);
      // Old udhar (migration compat)
      const oldU = oldEntries.filter(e => e.customerId === cid).reduce((s, e) => s + (e.amount || 0), 0);
      const oldP = oldPayments.filter(p => p.customerId === cid).reduce((s, p) => s + (p.amount || 0), 0);
      const totalCredit = credits + oldU;
      const totalPaid = payments + oldP;
      const balance = totalCredit - totalPaid;
      return {
        customer: { id: cid, name: c.name, phone: c.phone, address: c.address },
        totalUdhar: totalCredit, totalPaid, balance
      };
    }).filter(x => x.totalUdhar > 0 || x.balance !== 0);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LEGACY UDHAR ENDPOINTS (kept for backward compat) ────────────────────────
app.get('/api/admin/udhar', adminAuth, async (req, res) => {
  try {
    const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
    res.json(await db.collection('udharEntries').find(cid ? { customerId: cid } : {}).sort({ date: -1 }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/udhar', adminAuth, async (req, res) => {
  try {
    const { customerId, items, amount, date, note, type } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
    // Save to new ledger AND old udharEntries for compatibility
    const ledgerEntry = {
      id: await getNextId('ledgerId'),
      customerId: parseInt(customerId),
      type: 'credit',
      amount: parseFloat(amount),
      note: note || (items && items.length ? items.map(i=>i.name).join(', ') : ''),
      date: date || new Date().toISOString().slice(0, 10),
      source: 'manual',
      items: items || [],
      createdAt: new Date().toISOString()
    };
    await db.collection('ledger').insertOne(ledgerEntry);
    // Also keep legacy for migration period
    const entry = {
      id: await getNextId('udharId'), customerId: parseInt(customerId),
      items: items || [], amount: parseFloat(amount),
      date: date || new Date().toISOString().slice(0, 10),
      note: note || '', type: type || 'purchase', createdAt: new Date().toISOString()
    };
    await db.collection('udharEntries').insertOne(entry);
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/udhar/:id', adminAuth, async (req, res) => {
  try {
    const { customerId, ...rest } = req.body;
    await db.collection('udharEntries').updateOne({ id: parseInt(req.params.id) }, { $set: rest });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/udhar/:id', adminAuth, async (req, res) => {
  try { await db.collection('udharEntries').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/udhar-payments', adminAuth, async (req, res) => {
  try {
    const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
    res.json(await db.collection('udharPayments').find(cid ? { customerId: cid } : {}).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/udhar-payments', adminAuth, async (req, res) => {
  try {
    const { customerId, amount, method, note } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
    // Save to new ledger
    const ledgerEntry = {
      id: await getNextId('ledgerId'),
      customerId: parseInt(customerId),
      type: 'payment',
      amount: parseFloat(amount),
      note: note || method || 'Cash',
      date: new Date().toISOString().slice(0, 10),
      source: 'payment',
      createdAt: new Date().toISOString()
    };
    await db.collection('ledger').insertOne(ledgerEntry);
    // Legacy
    const pay = {
      id: await getNextId('udharPayId'), customerId: parseInt(customerId),
      amount: parseFloat(amount), method: method || 'cash', note: note || '',
      paidAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10)
    };
    await db.collection('udharPayments').insertOne(pay);
    res.json({ ok: true, pay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/udhar-payments/:id', adminAuth, async (req, res) => {
  try { await db.collection('udharPayments').deleteOne({ id: parseInt(req.params.id) }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── ORDERS ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customerId) filter.customerId = parseInt(req.query.customerId);
    // #12: Date filtering — today, or custom date range
    if (req.query.date === 'today') {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
      filter.createdAt = { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() };
    } else if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from + 'T00:00:00.000Z').toISOString();
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to   + 'T23:59:59.999Z').toISOString();
    }
    res.json(await db.collection('orders').find(filter).sort({ createdAt: -1 }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const existing = await db.collection('orders').findOne({ id: orderId });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // If cancelling an order that was previously pending/processing, restore stock
    const newStatus = req.body.status;
    if (newStatus === 'cancelled' && existing.status !== 'cancelled' && !existing.stockRestored) {
      const regularItems = (existing.items || []).filter(i => !i.isFreeGift);
      for (const item of regularItems) {
        const product = await db.collection('products').findOne({ id: item.productId });
        if (product && typeof product.stockQuantity === 'number') {
          await db.collection('products').updateOne(
            { id: item.productId },
            { $inc: { stockQuantity: item.qty } }
          );
        }
      }
      req.body.stockRestored = true;
    }

    const result = await db.collection('orders').findOneAndUpdate(
      { id: orderId }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });

    // #5: WhatsApp notification when order is delivered
    if (newStatus === 'delivered' && existing.status !== 'delivered') {
      try {
        const storeSettings = await db.collection('settings').findOne({ _id: 'main' });
        const wa = storeSettings?.whatsapp;
        // Return notification URL in response so admin frontend can open it
        const customerPhone = existing.phone?.replace(/\D/g, '');
        if (wa && customerPhone) {
          const msg = encodeURIComponent(`Hi ${existing.customerName}, your order #${orderId} of ₹${existing.total} has been delivered! Thank you for shopping with ${storeSettings.storeName || 'us'} 🛒`);
          result._waNotifyUrl = `https://wa.me/${customerPhone}?text=${msg}`;
        }
      } catch (_) { /* non-critical — don't fail the order update */ }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('orders').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Convert order → ledger credit entry
app.post('/api/admin/orders/:id/convert-to-udhar', adminAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.addedToUdhar) return res.status(400).json({ error: 'Already added to udhar' });
    const customer = await db.collection('customers').findOne({
      $or: [{ phone: order.phone }, { customerId: order.customerId }]
    });
    if (!customer) return res.status(404).json({ error: 'No registered customer for this order' });
    const udharItems = (order.items || []).filter(i => !i.isFreeGift).map(i => ({
      name: i.name + (i.variant ? ` (${i.variant})` : ''), qty: i.qty, price: i.price
    }));
    // Add to unified ledger
    await db.collection('ledger').insertOne({
      id: await getNextId('ledgerId'),
      customerId: customer.customerId,
      type: 'credit',
      amount: parseFloat(order.total),
      note: `App Order #${orderId}`,
      date: (order.createdAt || new Date().toISOString()).slice(0, 10),
      source: 'app_order',
      orderId,
      items: udharItems,
      createdAt: new Date().toISOString()
    });
    // Also keep in legacy for compat
    await db.collection('udharEntries').insertOne({
      id: await getNextId('udharId'), customerId: customer.customerId,
      items: udharItems, amount: parseFloat(order.total),
      date: (order.createdAt || new Date().toISOString()).slice(0, 10),
      note: `App Order #${orderId}`, type: 'app_order',
      orderId, createdAt: new Date().toISOString()
    });
    await db.collection('orders').updateOne({ id: orderId }, { $set: { addedToUdhar: true, customerId: customer.customerId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark order as paid (creates payment in ledger)
app.post('/api/admin/orders/:id/mark-paid', adminAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const customer = await db.collection('customers').findOne({
      $or: [{ phone: order.phone }, { customerId: order.customerId }]
    });
    if (!customer) return res.status(404).json({ error: 'No registered customer' });
    // Add payment to ledger
    await db.collection('ledger').insertOne({
      id: await getNextId('ledgerId'),
      customerId: customer.customerId,
      type: 'payment',
      amount: parseFloat(order.total),
      note: `Payment for Order #${orderId}`,
      date: new Date().toISOString().slice(0, 10),
      source: 'order_payment',
      orderId,
      createdAt: new Date().toISOString()
    });
    await db.collection('orders').updateOne({ id: orderId }, { $set: { paid: true, paidAt: new Date().toISOString() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC: Place order
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, block, villa, note, items, freeGift, paymentMethod } = req.body;
    if (!customerName || !phone || !items?.length) return res.status(400).json({ error: 'Missing fields' });

    // ── SERVER-SIDE PRICE RECALCULATION (#3) ─────────────────────────────────
    // Never trust client-submitted prices — recalculate from DB
    const regularItems = items.filter(i => !i.isFreeGift);
    let recalcTotal = 0;
    const validatedItems = [];
    for (const item of regularItems) {
      const product = await db.collection('products').findOne({ id: item.productId });
      if (!product) continue;
      if (product.disabled) return res.status(400).json({ error: `"${product.name}" is not available.` });
      if (typeof product.stockQuantity === 'number') {
        if (product.stockQuantity === 0) return res.status(400).json({ error: `"${product.name}" is Out of Stock.` });
        if (product.stockQuantity < item.qty) return res.status(400).json({ error: `Only ${product.stockQuantity} unit(s) of "${product.name}" available.` });
        const updateResult = await db.collection('products').findOneAndUpdate(
          { id: item.productId, stockQuantity: { $gte: item.qty } },
          { $inc: { stockQuantity: -item.qty } },
          { returnDocument: 'after' }
        );
        if (!updateResult) {
          return res.status(400).json({ error: `"${product.name}" stock changed during checkout. Please try again.` });
        }
      }
      // Find the matching variant and tier to get the real server-side price
      const migrated = migrateProduct(product);
      const variant = migrated.variants.find(v => v.id === item.variantId) || migrated.variants[0];
      const tiers = [...(variant?.priceTiers || [])].sort((a, b) => a.minQty - b.minQty);
      let serverPrice = tiers[0]?.price || 0;
      for (const tier of tiers) { if (item.qty >= tier.minQty) serverPrice = tier.price; }
      recalcTotal += serverPrice * item.qty;
      validatedItems.push({ ...item, price: serverPrice });
    }
    // Handle free gift pricing from settings
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    if (freeGift) {
      const giftPrice = settings?.freeGift?.discountPrice ?? 0;
      recalcTotal += giftPrice;
    }
    const total = parseFloat(recalcTotal.toFixed(2));
    // ─────────────────────────────────────────────────────────────────────────

    const id = await getNextId('orderId');
    const customer = await db.collection('customers').findOne({ phone });
    const order = {
      id, customerName, phone, block, villa: villa || '', note: note || '',
      items: [...validatedItems, ...(items.filter(i => i.isFreeGift))],
      total, freeGift: freeGift || null, paymentMethod: paymentMethod || 'cod',
      customerId: customer ? customer.customerId : null,
      status: 'pending', addedToUdhar: false, createdAt: new Date().toISOString()
    };
    if (paymentMethod === 'account' && customer) {
      const udharItems = validatedItems.map(i => ({
        name: i.name + (i.variant ? ` (${i.variant})` : ''), qty: i.qty, price: i.price
      }));
      await db.collection('ledger').insertOne({
        id: await getNextId('ledgerId'),
        customerId: customer.customerId,
        type: 'credit',
        amount: total,
        note: `App Order #${id}`,
        date: new Date().toISOString().slice(0, 10),
        source: 'app_order',
        orderId: id,
        items: udharItems,
        createdAt: new Date().toISOString()
      });
      await db.collection('udharEntries').insertOne({
        id: await getNextId('udharId'), customerId: customer.customerId,
        items: udharItems, amount: total,
        date: new Date().toISOString().slice(0, 10),
        note: `App Order #${id}`, type: 'app_order',
        orderId: id, createdAt: new Date().toISOString()
      });
      order.addedToUdhar = true;
    }
    await db.collection('orders').insertOne(order);
    res.json({ ok: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── MILK SUBSCRIPTIONS (Admin-Controlled Only) ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/milk/subscriptions', adminAuth, async (req, res) => {
  try {
    const subs = await db.collection('milkSubscriptions').find().toArray();
    const customers = await db.collection('customers').find({ deleted: { $ne: true } }).toArray();
    const custMap = {};
    customers.forEach(c => { custMap[c.customerId] = { customerId: c.customerId, name: c.name, phone: c.phone, address: c.address }; });
    res.json(subs.map(s => ({ ...s, customer: custMap[s.customerId] || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/subscriptions', adminAuth, async (req, res) => {
  try {
    const { customerId, defaultQty, pricePerLitre, startDate, notes, defaultItems } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const customer = await db.collection('customers').findOne({ customerId: parseInt(customerId) });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const existing = await db.collection('milkSubscriptions').findOne({ customerId: parseInt(customerId) });
    if (existing) return res.status(409).json({ error: 'Subscription already exists for this customer' });
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const items = Array.isArray(defaultItems) && defaultItems.length ? defaultItems : null;
    const totalQty = items ? items.reduce((s,i) => s + parseFloat(i.qty||0), 0) : parseFloat(defaultQty)||0.5;
    const sub = {
      customerId: parseInt(customerId),
      defaultQty: totalQty,
      pricePerLitre: parseFloat(pricePerLitre) || settings.milkPrice || 60,
      defaultItems: items || null,
      status: 'active',
      startDate: startDate || new Date().toISOString().slice(0, 10),
      pausedFrom: null, pausedUntil: null,
      notes: notes || '', createdBy: 'admin',
      createdAt: new Date().toISOString()
    };
    await db.collection('milkSubscriptions').insertOne(sub);
    res.json({ ok: true, subscription: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/milk/subscriptions/:customerId', adminAuth, async (req, res) => {
  try {
    const result = await db.collection('milkSubscriptions').findOneAndUpdate(
      { customerId: parseInt(req.params.customerId) }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Subscription not found' });
    res.json({ ok: true, subscription: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/subscriptions/:customerId/pause', adminAuth, async (req, res) => {
  try {
    await db.collection('milkSubscriptions').updateOne(
      { customerId: parseInt(req.params.customerId) },
      { $set: { status: 'paused', pausedFrom: req.body.pausedFrom || new Date().toISOString().slice(0, 10), pausedUntil: req.body.pausedUntil || null } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/subscriptions/:customerId/resume', adminAuth, async (req, res) => {
  try {
    await db.collection('milkSubscriptions').updateOne(
      { customerId: parseInt(req.params.customerId) },
      { $set: { status: 'active', pausedFrom: null, pausedUntil: null } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/milk/subscriptions/:customerId', adminAuth, async (req, res) => {
  try {
    await db.collection('milkSubscriptions').deleteOne({ customerId: parseInt(req.params.customerId) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Returns only customers with milk subscriptions
app.get('/api/admin/milk/customers', adminAuth, async (req, res) => {
  try {
    const subs = await db.collection('milkSubscriptions').find().toArray();
    const customerIds = subs.map(s => s.customerId);
    const customers = await db.collection('customers').find({ customerId: { $in: customerIds }, deleted: { $ne: true } }).toArray();
    const subMap = {};
    subs.forEach(s => { subMap[s.customerId] = s; });
    res.json(customers.map(c => ({
      id: c.customerId, customerId: c.customerId,
      name: c.name, phone: c.phone, address: c.address,
      defaultQty: subMap[c.customerId]?.defaultQty || 0,
      defaultItems: subMap[c.customerId]?.defaultItems || null,
      pricePerLitre: subMap[c.customerId]?.pricePerLitre || 60,
      active: subMap[c.customerId]?.status === 'active',
      joinedAt: c.joinedAt
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MILK LOGS ─────────────────────────────────────────────────────────────────
app.get('/api/admin/milk/logs', adminAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const logs = await db.collection('milkLogs').find({ month }).toArray();
    res.json({ logs, settings: { milkPrice: settings.milkPrice || 60 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/logs', adminAuth, async (req, res) => {
  try {
    const { customerId, date, qty, price, items } = req.body;
    const month = date.slice(0, 7);
    const cid = parseInt(customerId);
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const existing = await db.collection('milkLogs').findOne({ customerId: cid, date });

    // Support items array (multiple milk types per day)
    // items: [{type: 'Full Cream', qty: 1, price: 60}, {type: 'Toned', qty: 0.5, price: 58}]
    let logItems = items && items.length ? items : null;
    let totalQty = logItems
      ? logItems.reduce((s, i) => s + parseFloat(i.qty || 0), 0)
      : parseFloat(qty) || 0;

    if (existing) {
      if (totalQty === 0) {
        await db.collection('milkLogs').deleteOne({ customerId: cid, date });
      } else {
        const upd = { qty: totalQty, price: parseFloat(price) || settings.milkPrice || 60, markedAt: new Date().toISOString() };
        if (logItems) upd.items = logItems;
        await db.collection('milkLogs').updateOne({ customerId: cid, date }, { $set: upd });
      }
    } else if (totalQty > 0) {
      const doc = {
        id: await getNextId('milkLogId'), customerId: cid, date, month,
        qty: totalQty, price: parseFloat(price) || settings.milkPrice || 60,
        markedAt: new Date().toISOString()
      };
      if (logItems) doc.items = logItems;
      await db.collection('milkLogs').insertOne(doc);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BULK MARK — marks all active milk subscribers as delivered for a given date
app.post('/api/admin/milk/bulk-mark', adminAuth, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const month = date.slice(0, 7);
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const subs = await db.collection('milkSubscriptions').find({ status: 'active' }).toArray();
    let marked = 0;
    for (const sub of subs) {
      const existing = await db.collection('milkLogs').findOne({ customerId: sub.customerId, date });
      if (!existing) {
        const doc = {
          id: await getNextId('milkLogId'),
          customerId: sub.customerId, date, month,
          qty: sub.defaultQty,
          price: sub.pricePerLitre || settings.milkPrice || 60,
          markedAt: new Date().toISOString()
        };
        if (sub.defaultItems && sub.defaultItems.length) doc.items = sub.defaultItems;
        await db.collection('milkLogs').insertOne(doc);
        marked++;
      }
    }
    res.json({ ok: true, marked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate monthly billing — returns summary of all milk dues for a month
app.get('/api/admin/milk/billing/:month', adminAuth, async (req, res) => {
  try {
    const { month } = req.params;
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const subs = await db.collection('milkSubscriptions').find().toArray();
    const customerIds = subs.map(s => s.customerId);
    const customers = await db.collection('customers').find({ customerId: { $in: customerIds }, deleted: { $ne: true } }).toArray();
    const logs = await db.collection('milkLogs').find({ month }).toArray();
    const payments = await db.collection('milkPayments').find({ month }).toArray();
    const custMap = {};
    customers.forEach(c => { custMap[c.customerId] = c; });
    const subMap = {};
    subs.forEach(s => { subMap[s.customerId] = s; });

    const billing = customerIds.map(cid => {
      const c = custMap[cid];
      if (!c) return null;
      const sub = subMap[cid];
      const custLogs = logs.filter(l => l.customerId === cid);
      const totalLitres = custLogs.reduce((s, l) => s + l.qty, 0);
      // If log has items array, sum each item's qty*price; otherwise use log.qty * log.price
      const totalBilled = custLogs.reduce((s, l) => {
        if (l.items && l.items.length) {
          return s + l.items.reduce((is, i) => is + parseFloat(i.qty||0) * parseFloat(i.price||0), 0);
        }
        return s + l.qty * (l.price || sub?.pricePerLitre || settings.milkPrice || 60);
      }, 0);
      const totalPaid = payments.filter(p => p.customerId === cid).reduce((s, p) => s + p.amount, 0);
      return {
        customerId: cid,
        customerName: c.name,
        phone: c.phone,
        address: c.address,
        dailyQty: sub?.defaultQty || 0,
        totalLitres,
        totalBilled: parseFloat(totalBilled.toFixed(2)),
        totalPaid,
        due: parseFloat((totalBilled - totalPaid).toFixed(2))
      };
    }).filter(Boolean);

    res.json({ month, billing, totals: {
      totalBilled: billing.reduce((s, b) => s + b.totalBilled, 0),
      totalPaid: billing.reduce((s, b) => s + b.totalPaid, 0),
      totalDue: billing.reduce((s, b) => s + b.due, 0)
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/milk/payments', adminAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(await db.collection('milkPayments').find({ month }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/payment', adminAuth, async (req, res) => {
  try {
    const { customerId, month, amount, note } = req.body;
    await db.collection('milkPayments').insertOne({
      customerId: parseInt(customerId), month,
      amount: parseFloat(amount), note: note || 'Manual', paidAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/milk/settings', adminAuth, async (req, res) => {
  try {
    if (req.body.milkPrice)
      await db.collection('settings').updateOne({ _id: 'main' }, { $set: { milkPrice: parseFloat(req.body.milkPrice) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── MIGRATION UTILITY ─────────────────────────────────────────────────────────
// Migrates old udharEntries + udharPayments → unified ledger
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/migrate-to-ledger', adminAuth, async (req, res) => {
  try {
    const [entries, payments] = await Promise.all([
      db.collection('udharEntries').find().toArray(),
      db.collection('udharPayments').find().toArray(),
    ]);
    let migratedCredits = 0, migratedPayments = 0;
    for (const e of entries) {
      const exists = await db.collection('ledger').findOne({ source: 'legacy_udhar', legacyId: e.id });
      if (!exists) {
        await db.collection('ledger').insertOne({
          id: await getNextId('ledgerId'),
          customerId: e.customerId,
          type: 'credit',
          amount: e.amount,
          note: e.note || (e.items||[]).map(i=>i.name).join(', ') || 'Migrated entry',
          date: e.date || e.createdAt?.slice(0,10) || new Date().toISOString().slice(0,10),
          source: 'legacy_udhar',
          legacyId: e.id,
          items: e.items || [],
          createdAt: e.createdAt || new Date().toISOString()
        });
        migratedCredits++;
      }
    }
    for (const p of payments) {
      const exists = await db.collection('ledger').findOne({ source: 'legacy_payment', legacyId: p.id });
      if (!exists) {
        await db.collection('ledger').insertOne({
          id: await getNextId('ledgerId'),
          customerId: p.customerId,
          type: 'payment',
          amount: p.amount,
          note: p.note || p.method || 'Migrated payment',
          date: p.date || p.paidAt?.slice(0,10) || new Date().toISOString().slice(0,10),
          source: 'legacy_payment',
          legacyId: p.id,
          createdAt: p.paidAt || new Date().toISOString()
        });
        migratedPayments++;
      }
    }
    res.json({ ok: true, migratedCredits, migratedPayments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── CUSTOMER PORTAL ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// REGISTER — saves to customers ONLY
app.post('/api/milk/register', async (req, res) => {
  try {
    const { name, phone, address, pin } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: '4-digit PIN required' });

    const existing = await db.collection('customers').findOne({ phone });

    if (existing) {
      // If account was deleted — restore it and set new PIN
      if (existing.deleted) {
        await db.collection('customers').updateOne({ phone }, { $set: {
          name: name || existing.name,
          address: address || existing.address || '',
          pin: sha256(String(pin)),
          pinPlain: String(pin),
          deleted: false, deletedAt: null, active: true
        }});
        return res.json({ ok: true, restored: true });
      }
      // If admin pre-created this account (no PIN set yet) — let customer complete it
      if (!existing.pin) {
        await db.collection('customers').updateOne({ phone }, { $set: {
          name: name || existing.name,
          address: address || existing.address || '',
          pin: sha256(String(pin)),
          pinPlain: String(pin),
          joinedAt: existing.joinedAt || new Date().toISOString()
        }});
        return res.json({ ok: true, linked: true });
      }
      // Already fully registered and active
      return res.status(409).json({ error: 'This phone number is already registered. Please login instead.' });
    }

    // Brand new customer — create fresh
    const customerId = await getNextId('customerId');
    await db.collection('customers').insertOne({
      customerId, name, phone, address: address || '',
      block: '', villa: '', pin: sha256(String(pin)), pinPlain: String(pin),
      active: true, tags: [], creditLimit: 0, notes: '',
      joinedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LOGIN
app.post('/api/milk/login', async (req, res) => {
  try {
    const { phone, password, pin } = req.body;
    const c = await db.collection('customers').findOne({ phone });
    const attempt = pin || password;
    if (!c || sha256(String(attempt)) !== c.pin)
      return res.status(401).json({ error: 'Wrong phone or PIN' });
    if (c.deleted)
      return res.status(401).json({ error: 'Account not found. Please register again.' });
    const token = jwt.sign({ cid: c.customerId, phone: c.phone }, CUSTOMER_SECRET, { expiresIn: '90d' });
    res.json({ token, customer: { id: c.customerId, name: c.name, phone: c.phone, address: c.address } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DASHBOARD
app.get('/api/customer/dashboard', customerAuth, async (req, res) => {
  try {
    const c = await db.collection('customers').findOne({ customerId: req.user.cid });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const key = new Date().toISOString().slice(0, 7);
    const [milkSub, log, milkPayments, orders, ledgerEntries, udharEntries, udharPayments] = await Promise.all([
      db.collection('milkSubscriptions').findOne({ customerId: c.customerId }),
      db.collection('milkLogs').find({ customerId: c.customerId, month: key }).toArray(),
      db.collection('milkPayments').find({ customerId: c.customerId, month: key }).toArray(),
      db.collection('orders').find({ $or: [{ customerId: c.customerId }, { phone: c.phone }] }).sort({ createdAt: -1 }).limit(30).toArray(),
      db.collection('ledger').find({ customerId: c.customerId }).toArray(),
      db.collection('udharEntries').find({ customerId: c.customerId }).toArray(),
      db.collection('udharPayments').find({ customerId: c.customerId }).toArray(),
    ]);
    const pricePerLitre = milkSub?.pricePerLitre || settings.milkPrice || 60;
    const totalLitres = log.reduce((s, l) => s + l.qty, 0);
    const milkAmt = log.reduce((s, l) => {
      if (l.items && l.items.length) return s + l.items.reduce((is, i) => is + parseFloat(i.qty||0)*parseFloat(i.price||0), 0);
      return s + l.qty * (l.price || pricePerLitre);
    }, 0);
    const milkPaid = milkPayments.reduce((s, p) => s + p.amount, 0);
    const ledgerBalance = ledgerEntries.reduce((s, e) => e.type === 'credit' ? s + e.amount : s - e.amount, 0);
    const oldUdharBalance = udharEntries.reduce((s, e) => s + (e.amount || 0), 0) - udharPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const { pin, ...safeCustomer } = c;
    res.json({
      customer: safeCustomer, milkSubscription: milkSub || null,
      log, totalLitres, milkAmt, milkPaid, pricePerLitre, month: key,
      orders, udharEntries, udharPayments, ledgerEntries,
      udharBalance: ledgerBalance + oldUdharBalance
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LEDGER
app.get('/api/customer/ledger', customerAuth, async (req, res) => {
  try {
    const cid = req.user.cid;
    const c = await db.collection('customers').findOne({ customerId: cid });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const entries = [];
    const [milkLogs, milkPayments, orders, udharEntries, udharPayments, ledgerEntries] = await Promise.all([
      db.collection('milkLogs').find({ customerId: cid, month }).toArray(),
      db.collection('milkPayments').find({ customerId: cid, month }).toArray(),
      db.collection('orders').find({ $or: [{ customerId: cid }, { phone: c.phone }], status: { $ne: 'cancelled' } }).toArray(),
      db.collection('udharEntries').find({ customerId: cid }).toArray(),
      db.collection('udharPayments').find({ customerId: cid }).toArray(),
      db.collection('ledger').find({ customerId: cid }).toArray(),
    ]);
    milkLogs.forEach(l => {
      const amount = l.items && l.items.length
        ? parseFloat(l.items.reduce((s,i) => s + parseFloat(i.qty||0)*parseFloat(i.price||0), 0).toFixed(2))
        : parseFloat((l.qty * (l.price || settings.milkPrice || 60)).toFixed(2));
      const desc = l.items && l.items.length
        ? `Milk delivery — ${l.items.map(i=>`${i.qty}L ${i.type}`).join(', ')}`
        : `Milk delivery — ${l.qty}L`;
      entries.push({ id: 'milk_' + l.id, date: l.date, type: 'milk', source: 'SUBSCRIPTION', description: desc, amount, debit: true, time: l.markedAt, note: '' });
    });
    milkPayments.forEach(p => entries.push({ id: 'milkpay_' + p.paidAt?.slice(0,10) + '_' + p.amount, date: p.paidAt ? p.paidAt.slice(0, 10) : month + '-01', type: 'payment', source: 'PAYMENT', description: `Milk payment — ${p.note || 'Cash'}`, amount: parseFloat(p.amount), debit: false, time: p.paidAt, note: p.note || '' }));
    orders.filter(o => o.createdAt && o.createdAt.slice(0, 7) === month).forEach(o => entries.push({ id: 'order_' + o.id, date: o.createdAt.slice(0, 10), type: 'order', source: 'APP', description: `App order #${o.id} — ${(o.items || []).slice(0, 2).map(i => i.name).join(', ')}${(o.items || []).length > 2 ? ` +${o.items.length - 2} more` : ''}`, amount: parseFloat(o.total), debit: true, time: o.createdAt, note: o.note || '', orderId: o.id, orderStatus: o.status }));
    // New ledger entries
    ledgerEntries.filter(e => e.date && e.date.slice(0, 7) === month).forEach(e => {
      if (e.source === 'app_order' || e.source === 'legacy_udhar') {
        entries.push({ id: 'ledger_' + e.id, date: e.date, type: e.type === 'credit' ? 'udhar' : 'udhar_payment', source: 'STORE', description: e.note || 'Store purchase', amount: parseFloat(e.amount), debit: e.type === 'credit', time: e.createdAt, note: e.note || '' });
      } else if (e.type === 'payment') {
        entries.push({ id: 'ledger_' + e.id, date: e.date, type: 'udhar_payment', source: 'PAYMENT', description: `Payment received — ${e.note || 'Cash'}`, amount: parseFloat(e.amount), debit: false, time: e.createdAt, note: e.note || '' });
      } else if (e.type === 'credit') {
        entries.push({ id: 'ledger_' + e.id, date: e.date, type: 'udhar', source: 'STORE', description: e.note || 'Store purchase', amount: parseFloat(e.amount), debit: true, time: e.createdAt, note: e.note || '' });
      }
    });
    // Old udhar (not in new ledger)
    udharEntries.filter(e => e.date && e.date.slice(0, 7) === month && !e.inLedger).forEach(e => entries.push({ id: 'udhar_' + e.id, date: e.date, type: 'udhar', source: 'STORE', description: (e.items || []).length ? e.items.slice(0, 2).map(i => i.name).join(', ') + (e.items.length > 2 ? ` +${e.items.length - 2} more` : '') : (e.note || 'Store purchase'), amount: parseFloat(e.amount), debit: true, time: e.createdAt, note: e.note || '' }));
    udharPayments.filter(p => p.date && p.date.slice(0, 7) === month).forEach(p => entries.push({ id: 'udpay_' + p.id, date: p.date, type: 'udhar_payment', source: 'PAYMENT', description: `Payment received — ${p.method || 'Cash'}`, amount: parseFloat(p.amount), debit: false, time: p.paidAt, note: p.note || '' }));
    entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    const milkTotal = entries.filter(e => e.type === 'milk').reduce((s, e) => s + e.amount, 0);
    const orderTotal = entries.filter(e => e.type === 'order').reduce((s, e) => s + e.amount, 0);
    const udharTotal = entries.filter(e => e.type === 'udhar').reduce((s, e) => s + e.amount, 0);
    const paymentsTotal = entries.filter(e => e.type === 'payment' || e.type === 'udhar_payment').reduce((s, e) => s + e.amount, 0);
    const totalDebits = milkTotal + orderTotal + udharTotal;
    res.json({ month, entries, summary: { milkTotal, orderTotal, udharTotal, paymentsTotal, totalDebits, outstanding: totalDebits - paymentsTotal } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customer/ledger/months', customerAuth, async (req, res) => {
  try {
    const cid = req.user.cid;
    const c = await db.collection('customers').findOne({ customerId: cid });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const monthSet = new Set([new Date().toISOString().slice(0, 7)]);
    const [milkLogs, milkPayments, orders, udharEntries, udharPayments] = await Promise.all([
      db.collection('milkLogs').find({ customerId: cid }).toArray(),
      db.collection('milkPayments').find({ customerId: cid }).toArray(),
      db.collection('orders').find({ $or: [{ customerId: cid }, { phone: c.phone }] }).toArray(),
      db.collection('udharEntries').find({ customerId: cid }).toArray(),
      db.collection('udharPayments').find({ customerId: cid }).toArray(),
    ]);
    milkLogs.forEach(l => monthSet.add(l.month));
    milkPayments.filter(p => p.paidAt).forEach(p => monthSet.add(p.paidAt.slice(0, 7)));
    orders.filter(o => o.createdAt).forEach(o => monthSet.add(o.createdAt.slice(0, 7)));
    udharEntries.filter(e => e.date).forEach(e => monthSet.add(e.date.slice(0, 7)));
    udharPayments.filter(p => p.date).forEach(p => monthSet.add(p.date.slice(0, 7)));
    res.json({ months: [...monthSet].sort().reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SERVE PAGES ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ BSC Store running at http://localhost:${PORT}`);
    console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
  });
}).catch(err => {
  console.error('❌ Failed to connect to MongoDB:', err);
  process.exit(1);
});
