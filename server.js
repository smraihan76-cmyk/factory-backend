const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();
const ZKLib = require('node-zklib');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'maya-garments-dev-secret-please-change';

// ডিউটি শুরুর কত মিনিট পর্যন্ত দেরি হলে সেটাকে লেট ধরা হবে না (গ্রেস পিরিয়ড)
const LATE_GRACE_MINUTES = 15;

// মেশিনের ঘড়ি বাংলাদেশ সময়ে (UTC+৬) কিন্তু সার্ভার UTC-তে চলে বলে যে ৬ ঘণ্টার পার্থক্য হয়ে যায়, সেটা ঠিক করার জন্য
const TIMEZONE_CORRECTION_MS = 6 * 60 * 60 * 1000;

// একটা UTC Date/timestamp থেকে বাংলাদেশ ক্যালেন্ডার তারিখ (YYYY-MM-DD) বের করে —
// রাত ১২টা থেকে ভোর ৬টার মধ্যে UTC আর বাংলাদেশ তারিখ আলাদা হয়ে যায়, তাই এই হেল্পার জরুরি
function bdDateStr(date) {
  return new Date(new Date(date).getTime() + TIMEZONE_CORRECTION_MS).toISOString().slice(0, 10);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// প্রথমবার সার্ভার চালু হলে টেবিলগুলো তৈরি হবে (যদি না থাকে)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      designation TEXT,
      rate_type TEXT NOT NULL DEFAULT 'piece',
      rate_amount NUMERIC NOT NULL DEFAULT 0,
      joining_date DATE DEFAULT CURRENT_DATE,
      machine_user_id TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // পুরনো staff টেবিলে column না থাকলে যোগ করে দেয় (already-deployed ডাটাবেজের জন্য নিরাপদ)
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS machine_user_id TEXT;`);

  // উপস্থিতির প্রতিটা ঘটনা (check_in, break_start, break_end, check_out) এখানে জমা হয়
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_events (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_time TIMESTAMP NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ডিউটি টাইম (পুরো ফ্যাক্টরির জন্য একটাই শিডিউল, একটাই রো থাকবে id=1)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duty_schedule (
      id INTEGER PRIMARY KEY DEFAULT 1,
      duty_start TIME NOT NULL DEFAULT '09:00',
      lunch_start TIME NOT NULL DEFAULT '13:00',
      lunch_end TIME NOT NULL DEFAULT '14:00',
      duty_end TIME NOT NULL DEFAULT '18:00',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ফিঙ্গারপ্রিন্ট মেশিনের তালিকা
  await pool.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 4370,
      active BOOLEAN DEFAULT true,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;`);

  // সাধারণ সেটিংস (যেমন মেশিন সিঙ্ক ইন্টারভাল)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('machine_sync_interval_seconds', '30')
    ON CONFLICT (key) DO NOTHING;
  `);

  // ইউজার (এডমিন/মডারেটর) — লগইনের জন্য
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'moderator',
      is_partner BOOLEAN DEFAULT false,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;`);
  // প্রথম এডমিন অ্যাকাউন্ট — না থাকলে অটোমেটিক তৈরি হবে
  const adminCheck = await pool.query(`SELECT id FROM users WHERE phone = '01775515571'`);
  if (adminCheck.rows.length === 0) {
    const hash = await bcrypt.hash('admin', 10);
    await pool.query(
      `INSERT INTO users (name, phone, password_hash, role) VALUES ('Admin', '01775515571', $1, 'admin')`,
      [hash]
    );
    console.log('ডিফল্ট এডমিন অ্যাকাউন্ট তৈরি হলো ✅');
  }

  // পার্টনারের ক্যাশ/খরচের হিসাব
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      added_by_user_id INTEGER NOT NULL REFERENCES users(id),
      image_url TEXT,
      event_time TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE partner_transactions ADD COLUMN IF NOT EXISTS image_url TEXT;`);

  // পার্টনার নোটিফিকেশন (কে কী করলো সেটা অন্য পার্টনারদের জানানোর জন্য)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT false,
      type TEXT DEFAULT 'info',
      edit_request_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE partner_notifications ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'info';`);
  await pool.query(`ALTER TABLE partner_notifications ADD COLUMN IF NOT EXISTS edit_request_id INTEGER;`);
  await pool.query(`ALTER TABLE partner_notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;`);

  // পোস্ট এডিট করলে সাথে সাথে বদলায় না — অন্য পার্টনারের অনুমোদন লাগে
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_edit_requests (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES partner_transactions(id) ON DELETE CASCADE,
      requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
      old_description TEXT,
      old_amount NUMERIC,
      old_image_url TEXT,
      new_description TEXT,
      new_amount NUMERIC,
      new_image_url TEXT,
      status TEXT DEFAULT 'pending',
      resolved_by_user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP
    );
  `);

  // পোস্টে লাইক/লাভ রিয়েক্ট — প্রতি ইউজার প্রতি পোস্টে একটাই রিয়েক্ট রাখতে পারবে
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_transaction_reactions (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES partner_transactions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(transaction_id, user_id)
    );
  `);

  // প্রোডাক্ট লিস্ট (নাম + সেলাই মূল্য)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sewing_price NUMERIC NOT NULL DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // কারিগরের প্রোডাকশন এন্ট্রি (কে, কোন প্রোডাক্ট, কত পিস, কত টাকা)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_entries (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL,
      sewing_price NUMERIC NOT NULL,
      amount NUMERIC NOT NULL,
      entry_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ফ্যাক্টরির সাধারণ খরচ
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // স্টাফ/কারিগরকে দেওয়া সাপ্তাহিক এডভান্স/পেমেন্ট
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_payments (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      payment_date DATE DEFAULT CURRENT_DATE,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ওভারটাইম সেশন — শুরু ও শেষের সময়, ঘণ্টা ও টাকা হিসাব
  await pool.query(`
    CREATE TABLE IF NOT EXISTS overtime_sessions (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      start_time TIMESTAMP NOT NULL DEFAULT NOW(),
      end_time TIMESTAMP,
      hours NUMERIC,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // পাইকার (হোলসেলার) লিস্ট
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wholesalers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // পাইকার-ভিত্তিক প্রোডাক্টের রেট
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wholesaler_product_rates (
      id SERIAL PRIMARY KEY,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // পাইকারি হিসাব — হিসাব যোগ / রিটার্ন / পেমেন্ট, সব এক লগে
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wholesaler_ledger (
      id SERIAL PRIMARY KEY,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL, -- 'add' | 'return' | 'payment'
      product_name TEXT,
      quantity NUMERIC,
      price_per_unit NUMERIC,
      amount NUMERIC NOT NULL,
      description TEXT,
      event_time TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('সব টেবিল রেডি ✅');
}
initDb().catch((err) => console.error('DB init error:', err.message));

// Health check route
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== লগইন / ইউজার ম্যানেজমেন্ট ====================

// লগইন — ফোন নাম্বার + পাসওয়ার্ড দিয়ে
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ status: 'error', message: 'ফোন নাম্বার এবং পাসওয়ার্ড দিতে হবে' });
    }
    const result = await pool.query(`SELECT * FROM users WHERE phone = $1 AND active = true`, [phone]);
    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'ফোন নাম্বার বা পাসওয়ার্ড ভুল' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ status: 'error', message: 'ফোন নাম্বার বা পাসওয়ার্ড ভুল' });
    }
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role, name: user.name, is_partner: user.is_partner },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      status: 'ok',
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        is_partner: user.is_partner,
        photo_url: user.photo_url
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// নিজের প্রোফাইল আপডেট করুন — নাম, ছবি, পাসওয়ার্ড (যেকোনো লগইন করা ইউজার নিজের জন্য করতে পারবে)
app.put('/api/auth/me', verifyAuth, async (req, res) => {
  try {
    const { name, photo_url, current_password, new_password } = req.body;

    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ status: 'error', message: 'বর্তমান পাসওয়ার্ড দিতে হবে' });
      }
      const existing = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
      const match = await bcrypt.compare(current_password, existing.rows[0].password_hash);
      if (!match) {
        return res.status(400).json({ status: 'error', message: 'বর্তমান পাসওয়ার্ড ভুল' });
      }
      const newHash = await bcrypt.hash(new_password, 10);
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, req.user.id]);
    }

    const result = await pool.query(
      `UPDATE users SET
        name = COALESCE($1, name),
        photo_url = COALESCE($2, photo_url)
       WHERE id = $3
       RETURNING id, name, phone, role, is_partner, photo_url`,
      [name || null, photo_url || null, req.user.id]
    );

    res.json({ status: 'ok', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// JWT ভেরিফাই করে + শুধু এডমিনকে এগোতে দেয়
function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ status: 'error', message: 'লগইন করা নেই' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'শুধু এডমিন এই কাজ করতে পারবে' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'টোকেন সঠিক নয় বা মেয়াদ শেষ' });
  }
}

// JWT ভেরিফাই করে — যেকোনো লগইন করা ইউজার (এডমিন/মডারেটর উভয়ই) এগোতে পারবে
function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ status: 'error', message: 'লগইন করা নেই' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'টোকেন সঠিক নয় বা মেয়াদ শেষ' });
  }
}

// এই মিডলওয়্যারে লগইন থাকা বাধ্যতামূলক না — টোকেন থাকলে req.user বসিয়ে দেয়, না থাকলেও রিকোয়েস্ট চলতে থাকে।
// ফ্যাক্টরি খরচ/স্টাফ পেমেন্টের মতো রুটে ব্যবহার হয়, যাতে পার্টনার লগইন করা থাকলে তার হিসাবের সাথে অটো-লিংক করা যায়।
function verifyAuthOptional(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      req.user = null;
    }
  }
  next();
}

// একজন পার্টনারের হিসাবে নতুন এন্ট্রি যোগ করে + অন্য পার্টনারদের নোটিফাই করে —
// পার্টনার পেজ, ফ্যাক্টরি খরচ, স্টাফ পেমেন্ট — সব জায়গা থেকে এই একই ফাংশন ব্যবহার হবে (অটো-লিংকের জন্য)
async function createPartnerTransaction({ userId, type, description, amount, addedByUserId, imageUrl }) {
  const result = await pool.query(
    `INSERT INTO partner_transactions (user_id, type, description, amount, added_by_user_id, image_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, type, description, amount, addedByUserId, imageUrl || null]
  );
  const adder = await pool.query(`SELECT name FROM users WHERE id = $1`, [addedByUserId]);
  const adderName = adder.rows[0]?.name || 'কেউ একজন';
  const label = type === 'expense' ? 'খরচ' : 'ক্যাশ';
  const otherPartners = await pool.query(
    `SELECT id FROM users WHERE is_partner = true AND active = true AND id != $1`,
    [addedByUserId]
  );
  for (const p of otherPartners.rows) {
    await pool.query(
      `INSERT INTO partner_notifications (user_id, message) VALUES ($1, $2)`,
      [p.id, `${adderName} নতুন ${label} যোগ করেছে: ${description} (৳${amount})`]
    );
  }
  return result.rows[0];
}

// নতুন এডমিন/মডারেটর যোগ করুন — শুধু লগইন করা এডমিনই পারবে
app.post('/api/auth/register', verifyAdmin, async (req, res) => {
  try {
    const { name, phone, password, role, is_partner } = req.body;
    if (!name || !phone || !password) {
      return res.status(400).json({ status: 'error', message: 'নাম, ফোন এবং পাসওয়ার্ড দিতে হবে' });
    }
    const existing = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'এই ফোন নাম্বার দিয়ে আগে থেকেই একটা অ্যাকাউন্ট আছে' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, phone, password_hash, role, is_partner) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, role, is_partner, created_at`,
      [name, phone, hash, role === 'admin' ? 'admin' : 'moderator', !!is_partner]
    );
    res.json({ status: 'ok', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব ইউজারের লিস্ট — শুধু এডমিন দেখতে পারবে
app.get('/api/auth/users', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, role, is_partner, photo_url, active, created_at FROM users WHERE active = true ORDER BY created_at DESC`
    );
    res.json({ status: 'ok', users: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন ইউজারকে নিষ্ক্রিয় করুন — শুধু এডমিন পারবে
app.delete('/api/auth/users/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE users SET active = false WHERE id = $1`, [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// আগে থেকে থাকা ইউজারকে এডিট করুন (যেমন: পার্টনার হিসেবে যোগ করা) — শুধু এডমিন পারবে
app.put('/api/auth/users/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, is_partner } = req.body;
    const result = await pool.query(
      `UPDATE users SET
        name = COALESCE($1, name),
        role = COALESCE($2, role),
        is_partner = COALESCE($3, is_partner)
       WHERE id = $4
       RETURNING id, name, phone, role, is_partner, active, created_at`,
      [name || null, role || null, is_partner === undefined ? null : is_partner, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'ইউজার পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব পার্টনার হিসাব (এন্ট্রি + নোটিফিকেশন) মুছে ফেলুন — টেস্ট/ডেমো ডেটা পরিষ্কার করার জন্য
app.delete('/api/partners/clear-all', verifyAdmin, async (req, res) => {
  try {
    const txnResult = await pool.query(`DELETE FROM partner_transactions`);
    await pool.query(`DELETE FROM partner_notifications`);
    res.json({ status: 'ok', deleted: txnResult.rowCount });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== পার্টনার হিসাব ====================

// সব পার্টনারের নাম-লিস্ট
app.get('/api/partners', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, photo_url FROM users WHERE is_partner = true AND active = true ORDER BY name ASC`
    );
    res.json({ status: 'ok', partners: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন পার্টনারের সব এন্ট্রি (যেকোনো লগইন করা ইউজার দেখতে পারবে)
// একগুচ্ছ ট্রানজেকশনের সাথে রিয়েক্ট সামারি (কে কী রিয়েক্ট দিয়েছে, ভিউয়ারের নিজের রিয়েক্ট) জুড়ে দেয়
async function attachReactions(transactions, viewerUserId) {
  if (transactions.length === 0) return transactions;
  const ids = transactions.map((t) => t.id);
  const result = await pool.query(
    `SELECT r.transaction_id, r.reaction_type, r.user_id, u.name AS user_name
     FROM partner_transaction_reactions r
     JOIN users u ON u.id = r.user_id
     WHERE r.transaction_id = ANY($1)`,
    [ids]
  );
  const byTxn = {};
  for (const r of result.rows) {
    if (!byTxn[r.transaction_id]) byTxn[r.transaction_id] = [];
    byTxn[r.transaction_id].push(r);
  }
  return transactions.map((t) => {
    const reactions = byTxn[t.id] || [];
    const counts = {};
    for (const r of reactions) counts[r.reaction_type] = (counts[r.reaction_type] || 0) + 1;
    const mine = viewerUserId ? reactions.find((r) => r.user_id === viewerUserId) : null;
    return {
      ...t,
      reaction_counts: counts,
      my_reaction: mine ? mine.reaction_type : null,
      reactors: reactions.map((r) => ({ user_name: r.user_name, reaction_type: r.reaction_type }))
    };
  });
}

app.get('/api/partners/:userId/transactions', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT pt.*, u.name AS added_by_name
       FROM partner_transactions pt
       JOIN users u ON u.id = pt.added_by_user_id
       WHERE pt.user_id = $1
       ORDER BY pt.event_time DESC, pt.created_at DESC`,
      [userId]
    );
    const withReactions = await attachReactions(result.rows, req.user.id);
    res.json({ status: 'ok', transactions: withReactions });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন পার্টনারের সামারি (মোট ক্যাশ, মোট খরচ, বর্তমান ব্যালেন্স)
app.get('/api/partners/:userId/summary', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount ELSE 0 END), 0) AS total_cash_in,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
       FROM partner_transactions WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    const totalCashIn = parseFloat(row.total_cash_in);
    const totalExpense = parseFloat(row.total_expense);
    res.json({
      status: 'ok',
      summary: { total_cash_in: totalCashIn, total_expense: totalExpense, balance: totalCashIn - totalExpense }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// নতুন এন্ট্রি — শুধু নিজের লেজারেই যোগ করা যায় (user_id সবসময় লগইন করা ইউজারের নিজের আইডি)
app.post('/api/partners/transactions', verifyAuth, async (req, res) => {
  try {
    const { type, description, amount, image_url } = req.body;
    if (!type || !description || !amount) {
      return res.status(400).json({ status: 'error', message: 'ধরন, বিবরণ এবং টাকার পরিমাণ দিতে হবে' });
    }
    if (type !== 'expense' && type !== 'cash_in') {
      return res.status(400).json({ status: 'error', message: 'ধরন ভুল' });
    }
    const transaction = await createPartnerTransaction({
      userId: req.user.id,
      type,
      description,
      amount,
      addedByUserId: req.user.id,
      imageUrl: image_url
    });
    res.json({ status: 'ok', transaction });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// এন্ট্রি এডিট করুন — শুধু যে যোগ করেছে সেই এডিট করতে পারবে, ডিলিট কখনো করা যাবে না
// এন্ট্রি এডিট করার অনুরোধ পাঠান — সাথে সাথে বদলায় না, অন্য পার্টনারের অনুমোদন লাগবে
app.put('/api/partners/transactions/:id', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { description, amount, image_url } = req.body;
    const existing = await pool.query(`SELECT * FROM partner_transactions WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'এন্ট্রি পাওয়া যায়নি' });
    }
    const old = existing.rows[0];
    if (old.added_by_user_id !== req.user.id) {
      return res.status(403).json({ status: 'error', message: 'শুধু যিনি এই এন্ট্রি যোগ করেছেন তিনিই এডিট করতে পারবেন' });
    }

    const newDescription = description || old.description;
    const newAmount = amount || old.amount;
    const newImageUrl = image_url !== undefined ? image_url : old.image_url;

    const editReqResult = await pool.query(
      `INSERT INTO partner_edit_requests
        (transaction_id, requested_by_user_id, old_description, old_amount, old_image_url, new_description, new_amount, new_image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, req.user.id, old.description, old.amount, old.image_url, newDescription, newAmount, newImageUrl]
    );
    const editRequestId = editReqResult.rows[0].id;

    // অন্য পার্টনারদের কাছে অনুমোদনের জন্য বিশেষ নোটিফিকেশন পাঠানো
    const otherPartners = await pool.query(
      `SELECT id FROM users WHERE is_partner = true AND active = true AND id != $1`,
      [req.user.id]
    );
    for (const p of otherPartners.rows) {
      await pool.query(
        `INSERT INTO partner_notifications (user_id, message, type, edit_request_id) VALUES ($1, $2, 'edit_approval', $3)`,
        [p.id, `${req.user.name} একটা পোস্ট এডিট করতে চাচ্ছেন — অনুমোদন প্রয়োজন`, editRequestId]
      );
    }

    res.json({ status: 'ok', pending: true, message: 'এডিট অনুরোধ পাঠানো হয়েছে, অন্য পার্টনারের অনুমোদনের অপেক্ষায় আছে' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// এডিট অনুরোধ অনুমোদন করুন — যিনি এডিট করেছেন তিনি নিজেরটা অনুমোদন করতে পারবেন না
app.post('/api/partners/edit-requests/:id/approve', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const erResult = await pool.query(`SELECT * FROM partner_edit_requests WHERE id = $1`, [id]);
    if (erResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'অনুরোধ পাওয়া যায়নি' });
    }
    const request = erResult.rows[0];
    if (request.status !== 'pending') {
      return res.json({ status: 'ok', already_resolved: true });
    }
    if (request.requested_by_user_id === req.user.id) {
      return res.status(403).json({ status: 'error', message: 'নিজের এডিট নিজে অনুমোদন করা যাবে না' });
    }

    await pool.query(
      `UPDATE partner_transactions SET description = $1, amount = $2, image_url = $3 WHERE id = $4`,
      [request.new_description, request.new_amount, request.new_image_url, request.transaction_id]
    );
    await pool.query(
      `UPDATE partner_edit_requests SET status = 'approved', resolved_by_user_id = $1, resolved_at = NOW() WHERE id = $2`,
      [req.user.id, id]
    );
    await pool.query(`UPDATE partner_notifications SET is_read = true, read_at = NOW() WHERE edit_request_id = $1`, [id]);
    await pool.query(
      `INSERT INTO partner_notifications (user_id, message, type, edit_request_id) VALUES ($1, $2, 'edit_approval', $3)`,
      [request.requested_by_user_id, 'আপনার এডিট এপ্রুভ করা হয়েছে ✅', id]
    );

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// এডিট অনুরোধ রিজেক্ট করুন — পোস্ট অপরিবর্তিত থাকবে
app.post('/api/partners/edit-requests/:id/reject', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const erResult = await pool.query(`SELECT * FROM partner_edit_requests WHERE id = $1`, [id]);
    if (erResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'অনুরোধ পাওয়া যায়নি' });
    }
    const request = erResult.rows[0];
    if (request.status !== 'pending') {
      return res.json({ status: 'ok', already_resolved: true });
    }
    if (request.requested_by_user_id === req.user.id) {
      return res.status(403).json({ status: 'error', message: 'নিজের এডিট নিজে রিজেক্ট করা যাবে না' });
    }

    await pool.query(
      `UPDATE partner_edit_requests SET status = 'rejected', resolved_by_user_id = $1, resolved_at = NOW() WHERE id = $2`,
      [req.user.id, id]
    );
    await pool.query(`UPDATE partner_notifications SET is_read = true, read_at = NOW() WHERE edit_request_id = $1`, [id]);
    await pool.query(
      `INSERT INTO partner_notifications (user_id, message, type, edit_request_id) VALUES ($1, $2, 'edit_approval', $3)`,
      [request.requested_by_user_id, 'আপনার এডিট রিজেক্ট করা হয়েছে ❌', id]
    );

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব পার্টনার/এডমিনের খরচ একসাথে (মূল "খরচের বিস্তারিত" রিপোর্টে দেখানোর জন্য)
app.get('/api/partners/expenses-all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pt.id, pt.description, pt.amount, pt.event_time, u.name AS added_by_name
       FROM partner_transactions pt
       JOIN users u ON u.id = pt.added_by_user_id
       WHERE pt.type = 'expense'
       ORDER BY pt.event_time DESC
       LIMIT 200`
    );
    res.json({ status: 'ok', expenses: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব পার্টনারের সব এন্ট্রি (খরচ + ক্যাশ) একসাথে — পোস্ট লগ/ফিড পেজের জন্য (এডমিন/মডারেটরও দেখতে পারবে)
app.get('/api/partners/all-transactions', verifyAuthOptional, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pt.*, u.name AS added_by_name, u.photo_url AS added_by_photo
       FROM partner_transactions pt
       JOIN users u ON u.id = pt.added_by_user_id
       ORDER BY pt.event_time ASC, pt.created_at ASC
       LIMIT 500`
    );
    const withReactions = await attachReactions(result.rows, req.user ? req.user.id : null);
    res.json({ status: 'ok', transactions: withReactions });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// পোস্টে লাইক/লাভ রিয়েক্ট দিন (আগে দেওয়া থাকলে বদলে যাবে) — যেকোনো লগইন করা ইউজার দিতে পারবে
app.post('/api/partners/transactions/:id/react', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reaction_type } = req.body;
    if (!['like', 'love'].includes(reaction_type)) {
      return res.status(400).json({ status: 'error', message: 'রিয়েক্ট ধরন ভুল' });
    }
    await pool.query(
      `INSERT INTO partner_transaction_reactions (transaction_id, user_id, reaction_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (transaction_id, user_id) DO UPDATE SET reaction_type = EXCLUDED.reaction_type`,
      [id, req.user.id, reaction_type]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// নিজের রিয়েক্ট সরিয়ে ফেলুন
app.delete('/api/partners/transactions/:id/react', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `DELETE FROM partner_transaction_reactions WHERE transaction_id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== নোটিফিকেশন ====================

// নোটিফিকেশনের সাথে এডিট-রিকোয়েস্টের বিস্তারিত জুড়ে দেয় (edit_approval টাইপের জন্য)
async function enrichNotifications(rows) {
  const notifications = [];
  for (const n of rows) {
    if (n.type === 'edit_approval' && n.edit_request_id) {
      const erResult = await pool.query(
        `SELECT er.*, u.name AS requested_by_name, pt.description AS current_description, pt.amount AS current_amount, pt.image_url AS current_image_url, pt.type AS txn_type
         FROM partner_edit_requests er
         JOIN users u ON u.id = er.requested_by_user_id
         JOIN partner_transactions pt ON pt.id = er.transaction_id
         WHERE er.id = $1`,
        [n.edit_request_id]
      );
      notifications.push({ ...n, edit_request: erResult.rows[0] || null });
    } else {
      notifications.push(n);
    }
  }
  return notifications;
}

app.get('/api/notifications', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM partner_notifications WHERE user_id = $1 AND is_read = false ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const notifications = await enrichNotifications(result.rows);
    res.json({ status: 'ok', notifications });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// নোটিফিকেশন হিস্ট্রি — রিড করা নোটিফিকেশন এখানে ২৪ ঘণ্টা থাকে, তারপর পার্মানেন্ট ডিলিট হয়ে যায়
app.get('/api/notifications/history', verifyAuth, async (req, res) => {
  try {
    // ২৪ ঘণ্টার বেশি পুরনো রিড নোটিফিকেশন পার্মানেন্টলি মুছে ফেলা (lazy cleanup)
    await pool.query(
      `DELETE FROM partner_notifications WHERE is_read = true AND read_at IS NOT NULL AND read_at < NOW() - INTERVAL '30 days'`
    );
    const result = await pool.query(
      `SELECT * FROM partner_notifications WHERE user_id = $1 AND is_read = true AND read_at >= NOW() - INTERVAL '30 days'
       ORDER BY read_at DESC LIMIT 100`,
      [req.user.id]
    );
    const notifications = await enrichNotifications(result.rows);
    res.json({ status: 'ok', notifications });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/notifications/unread-count', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM partner_notifications WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    res.json({ status: 'ok', count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা নির্দিষ্ট নোটিফিকেশন রিড করুন (হিস্ট্রিতে চলে যাবে, ২৪ ঘণ্টা পর পার্মানেন্ট ডিলিট হবে)
app.post('/api/notifications/:id/read', verifyAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE partner_notifications SET is_read = true, read_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/notifications/mark-read', verifyAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE partner_notifications SET is_read = true, read_at = NOW() WHERE user_id = $1`, [req.user.id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// নতুন স্টাফ/কারিগর যোগ করুন
app.post('/api/staff', async (req, res) => {
  try {
    const { name, phone, designation, rate_type, rate_amount, joining_date, machine_user_id } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'নাম দেওয়া বাধ্যতামূলক' });
    }
    const result = await pool.query(
      `INSERT INTO staff (name, phone, designation, rate_type, rate_amount, joining_date, machine_user_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7)
       RETURNING *`,
      [name, phone || null, designation || null, rate_type || 'piece', rate_amount || 0, joining_date || null, machine_user_id || null]
    );
    res.json({ status: 'ok', staff: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব স্টাফ/কারিগরের লিস্ট দেখুন
app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM staff WHERE active = true ORDER BY created_at DESC`
    );
    res.json({ status: 'ok', staff: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফ/কারিগরের তথ্য আপডেট করুন
app.put('/api/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, designation, rate_type, rate_amount, machine_user_id } = req.body;
    const result = await pool.query(
      `UPDATE staff SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        designation = COALESCE($3, designation),
        rate_type = COALESCE($4, rate_type),
        rate_amount = COALESCE($5, rate_amount),
        machine_user_id = COALESCE($6, machine_user_id)
       WHERE id = $7
       RETURNING *`,
      [name, phone, designation, rate_type, rate_amount, machine_user_id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'স্টাফ পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', staff: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফ/কারিগরকে মুছে ফেলুন (আসলে active=false করা হয়, ডেটা থেকেই যায়)
app.delete('/api/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE staff SET active = false WHERE id = $1`, [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== উপস্থিতি (Attendance) ====================

// আজকে একজন স্টাফের ঘটনাগুলো বের করে সাহায্যকারী ফাংশন
async function getTodayEvents(staffId) {
  const result = await pool.query(
    `SELECT * FROM attendance_events
     WHERE staff_id = $1 AND (event_time + interval '6 hours')::date = (now() + interval '6 hours')::date
     ORDER BY event_time ASC`,
    [staffId]
  );
  return result.rows;
}

// পরবর্তী ইভেন্ট কী হবে সেটা ঠিক করে (present বাটনের টগল লজিক)
function nextPresentEventType(todayEvents) {
  if (todayEvents.length === 0) return 'check_in';
  const last = todayEvents[todayEvents.length - 1].event_type;
  if (last === 'check_in') return 'check_out';
  if (last === 'break_start') return 'break_end';
  if (last === 'break_end') return 'check_out';
  if (last === 'check_out') return 'check_in'; // নতুন সেশন (বিরল)
  return 'check_in';
}

// মাসিক বেতনের কারিগরের সঠিক মজুরি হিসাব — শুক্রবার সাপ্তাহিক বন্ধ (পূর্ণ বেতনসহ),
// উপস্থিত দিনের বেতন যোগ, লেট মিনিটের বেতন কাটা, অনুপস্থিত দিনের বেতন কাটা
// একজন স্টাফের দৈনিক রেট, মিনিট-রেট, ঘণ্টা-রেট বের করে (ডিউটি শিডিউল + মাসিক বেতন থেকে) — সবখানে একই হিসাব ব্যবহারের জন্য
function computeRates(staff, duty) {
  let workMinutes = 480;
  if (duty) {
    const toMinutes = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const dutyStart = toMinutes(duty.duty_start);
    const dutyEnd = toMinutes(duty.duty_end);
    const lunchStart = toMinutes(duty.lunch_start);
    const lunchEnd = toMinutes(duty.lunch_end);
    workMinutes = (dutyEnd - dutyStart) - Math.max(0, lunchEnd - lunchStart);
    if (workMinutes <= 0) workMinutes = 480;
  }
  const dailyRate = parseFloat(staff.rate_amount || 0) / 30;
  const perMinuteRate = dailyRate / workMinutes;
  return { dailyRate, perMinuteRate, hourlyRate: perMinuteRate * 60 };
}

async function computeSalaryBreakdown(staffId, days) {
  const staffResult = await pool.query(`SELECT * FROM staff WHERE id = $1`, [staffId]);
  if (staffResult.rows.length === 0) return null;
  const staff = staffResult.rows[0];

  const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
  const duty = dutyResult.rows[0] || null;

  const { dailyRate, perMinuteRate } = computeRates(staff, duty);

  const eventsResult = await pool.query(
    `SELECT * FROM attendance_events
     WHERE staff_id = $1 AND event_time >= (now() + interval '6 hours')::date - ($2 || ' days')::interval - interval '6 hours'
     ORDER BY event_time ASC`,
    [staffId, days]
  );
  const byDate = {};
  for (const ev of eventsResult.rows) {
    const d = bdDateStr(ev.event_time);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  }

  const joining = new Date(staff.joining_date);
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  const startDate = joining > rangeStart ? joining : rangeStart;

  const breakdown = [];
  let totalEarned = 0;

  for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const dateStr = bdDateStr(d);
    const dayOfWeek = d.getDay(); // ৫ = শুক্রবার

    if (dayOfWeek === 5) {
      breakdown.push({ date: dateStr, status: 'holiday', late_minutes: 0, day_earned: +dailyRate.toFixed(2) });
      totalEarned += dailyRate;
      continue;
    }

    const events = byDate[dateStr] || [];
    const checkIn = events.find((e) => e.event_type === 'check_in');

    if (!checkIn) {
      breakdown.push({ date: dateStr, status: 'absent', late_minutes: 0, day_earned: 0 });
      continue;
    }

    let lateMinutes = 0;
    if (duty) {
      const dutyStartToday = timeOnDate(dateStr, duty.duty_start);
      const rawLateMin = Math.round((new Date(checkIn.event_time) - dutyStartToday) / 60000);
      lateMinutes = Math.max(0, rawLateMin - LATE_GRACE_MINUTES); // ১৫ মিনিট গ্রেস পিরিয়ড বাদ দিয়ে
    }

    const dayEarned = Math.max(0, dailyRate - lateMinutes * perMinuteRate);
    totalEarned += dayEarned;
    breakdown.push({ date: dateStr, status: 'present', late_minutes: lateMinutes, day_earned: +dayEarned.toFixed(2) });
  }

  breakdown.reverse(); // সাম্প্রতিক তারিখ আগে

  const paymentsResult = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total_paid FROM staff_payments WHERE staff_id = $1`,
    [staffId]
  );
  const totalPaid = parseFloat(paymentsResult.rows[0].total_paid);

  // শেষ হওয়া ওভারটাইম সেশনগুলো — টাকা বেতনে যোগ হবে, ক্যাশ মেমোতেও আলাদা করে দেখানো হবে
  const overtimeResult = await pool.query(
    `SELECT * FROM overtime_sessions WHERE staff_id = $1 AND end_time IS NOT NULL ORDER BY end_time DESC`,
    [staffId]
  );
  const overtime = overtimeResult.rows.map((o) => ({
    date: bdDateStr(o.end_time),
    start_time: o.start_time,
    end_time: o.end_time,
    hours: parseFloat(o.hours),
    amount: parseFloat(o.amount)
  }));
  const totalOvertimeAmount = overtime.reduce((sum, o) => sum + o.amount, 0);
  totalEarned += totalOvertimeAmount;

  return {
    staff_id: staff.id,
    name: staff.name,
    daily_rate: +dailyRate.toFixed(2),
    total_salary_earned: +totalEarned.toFixed(2),
    total_paid: totalPaid,
    total_due: +(totalEarned - totalPaid).toFixed(2),
    breakdown,
    overtime,
    total_overtime_amount: +totalOvertimeAmount.toFixed(2)
  };
}

// "উপস্থিত যুক্ত করুন" — check_in / break_end (resume) / check_out অটো টগল হয়
app.post('/api/attendance/present', async (req, res) => {
  try {
    const { staff_id, event_time, source } = req.body;
    if (!staff_id) {
      return res.status(400).json({ status: 'error', message: 'staff_id দরকার' });
    }
    // ম্যানুয়ালি দেওয়া সময়টা বাংলাদেশ স্থানীয় সময় ধরে সঠিক UTC-তে রূপান্তর করা হচ্ছে
    const correctedEventTime = event_time
      ? new Date(new Date(event_time).getTime() - TIMEZONE_CORRECTION_MS)
      : null;
    const todayEvents = await getTodayEvents(staff_id);
    const eventType = nextPresentEventType(todayEvents);
    const result = await pool.query(
      `INSERT INTO attendance_events (staff_id, event_type, event_time, source)
       VALUES ($1, $2, COALESCE($3, NOW()), $4)
       RETURNING *`,
      [staff_id, eventType, correctedEventTime, source || 'manual']
    );
    res.json({ status: 'ok', event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// "বিরতি" — শুধু তখনই বৈধ যখন স্টাফ বর্তমানে উপস্থিত (check_in বা break_end এর পরে)
app.post('/api/attendance/break', async (req, res) => {
  try {
    const { staff_id, event_time, source } = req.body;
    if (!staff_id) {
      return res.status(400).json({ status: 'error', message: 'staff_id দরকার' });
    }
    // ম্যানুয়ালি দেওয়া সময়টা বাংলাদেশ স্থানীয় সময় ধরে সঠিক UTC-তে রূপান্তর করা হচ্ছে
    const correctedEventTime = event_time
      ? new Date(new Date(event_time).getTime() - TIMEZONE_CORRECTION_MS)
      : null;
    const todayEvents = await getTodayEvents(staff_id);
    const last = todayEvents.length ? todayEvents[todayEvents.length - 1].event_type : null;
    if (last !== 'check_in' && last !== 'break_end') {
      return res.status(400).json({ status: 'error', message: 'স্টাফ এখন উপস্থিত অবস্থায় নেই, তাই বিরতি দেওয়া যাবে না' });
    }
    const result = await pool.query(
      `INSERT INTO attendance_events (staff_id, event_type, event_time, source)
       VALUES ($1, 'break_start', COALESCE($2, NOW()), $3)
       RETURNING *`,
      [staff_id, correctedEventTime, source || 'manual']
    );
    res.json({ status: 'ok', event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// আজকের সব স্টাফের বর্তমান স্ট্যাটাস (উপস্থিত / বিরতিতে / চলে গেছে / মার্ক করা হয়নি)
// আজকের সব উপস্থিতির রেকর্ড মুছে ফেলুন — এরপর থেকে নতুন ফিঙ্গার/এন্ট্রি দিয়ে আবার শুরু হবে
app.delete('/api/attendance/clear-today', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM attendance_events WHERE (event_time + interval '6 hours')::date = (now() + interval '6 hours')::date`);
    res.json({ status: 'ok', deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব স্টাফ পেমেন্ট মুছে ফেলুন (টেস্ট/ডেমো ডেটা পরিষ্কার করার জন্য)
app.delete('/api/staff-payments/clear-all', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM staff_payments`);
    res.json({ status: 'ok', deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/attendance/today', async (req, res) => {
  try {
    const staffResult = await pool.query(`SELECT * FROM staff WHERE active = true ORDER BY name ASC`);
    const eventsResult = await pool.query(
      `SELECT * FROM attendance_events WHERE (event_time + interval '6 hours')::date = (now() + interval '6 hours')::date ORDER BY event_time ASC`
    );
    const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    const duty = dutyResult.rows[0] || null;

    const eventsByStaff = {};
    for (const ev of eventsResult.rows) {
      if (!eventsByStaff[ev.staff_id]) eventsByStaff[ev.staff_id] = [];
      eventsByStaff[ev.staff_id].push(ev);
    }

    const list = staffResult.rows.map((s) => {
      const events = eventsByStaff[s.id] || [];
      const last = events.length ? events[events.length - 1] : null;
      let status = 'not_marked';
      if (last) {
        if (last.event_type === 'check_in' || last.event_type === 'break_end') status = 'present';
        else if (last.event_type === 'break_start') status = 'on_break';
        else if (last.event_type === 'check_out') status = 'checked_out';
      }

      const checkIn = events.find((e) => e.event_type === 'check_in');
      const breakStart = events.find((e) => e.event_type === 'break_start');
      const breakEnd = events.find((e) => e.event_type === 'break_end');
      const checkOut = [...events].reverse().find((e) => e.event_type === 'check_out');

      let lateMinutes = 0;
      if (checkIn && duty) {
        const today = bdDateStr(new Date());
        const dutyStartToday = timeOnDate(today, duty.duty_start);
        const rawLateMin = Math.round((new Date(checkIn.event_time) - dutyStartToday) / 60000);
        lateMinutes = Math.max(0, rawLateMin - LATE_GRACE_MINUTES); // ১৫ মিনিট গ্রেস পিরিয়ড বাদ দিয়ে
      }

      return {
        staff_id: s.id,
        name: s.name,
        designation: s.designation,
        phone: s.phone,
        status,
        last_event_time: last ? last.event_time : null,
        check_in: checkIn ? checkIn.event_time : null,
        break_start: breakStart ? breakStart.event_time : null,
        break_end: breakEnd ? breakEnd.event_time : null,
        check_out: checkOut ? checkOut.event_time : null,
        late_minutes: lateMinutes,
        events
      };
    });

    res.json({ status: 'ok', staff: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফের গত ৩০ দিনের সামারি (উপস্থিত ঘণ্টা, ব্রেক ঘণ্টা, লেট, অনুপস্থিত দিন)
app.get('/api/attendance/summary/:staffId', async (req, res) => {
  try {
    const { staffId } = req.params;
    const days = parseInt(req.query.days) || 30;

    const staffResult = await pool.query(`SELECT * FROM staff WHERE id = $1`, [staffId]);
    if (staffResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'স্টাফ পাওয়া যায়নি' });
    }
    const staff = staffResult.rows[0];

    const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    const duty = dutyResult.rows[0] || null;

    const eventsResult = await pool.query(
      `SELECT * FROM attendance_events
       WHERE staff_id = $1 AND event_time >= (now() + interval '6 hours')::date - ($2 || ' days')::interval - interval '6 hours'
       ORDER BY event_time ASC`,
      [staffId, days]
    );

    // তারিখ অনুযায়ী গ্রুপ করা
    const byDate = {};
    for (const ev of eventsResult.rows) {
      const d = bdDateStr(ev.event_time);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(ev);
    }

    let totalPresentMs = 0;
    let totalBreakMs = 0;
    let totalLateMs = 0;
    let presentDays = 0;

    for (const date of Object.keys(byDate)) {
      const events = byDate[date];
      const checkIn = events.find((e) => e.event_type === 'check_in');
      const checkOut = [...events].reverse().find((e) => e.event_type === 'check_out');
      const breakStart = events.find((e) => e.event_type === 'break_start');
      const breakEnd = events.find((e) => e.event_type === 'break_end');

      if (checkIn) presentDays++;

      if (breakStart && breakEnd) {
        totalBreakMs += new Date(breakEnd.event_time) - new Date(breakStart.event_time);
      }

      if (checkIn && checkOut) {
        let workedMs = new Date(checkOut.event_time) - new Date(checkIn.event_time);
        if (breakStart && breakEnd) {
          workedMs -= (new Date(breakEnd.event_time) - new Date(breakStart.event_time));
        }
        totalPresentMs += Math.max(0, workedMs);
      }

      if (checkIn && duty) {
        const dutyStartToday = timeOnDate(date, duty.duty_start);
        const rawLateMin = Math.round((new Date(checkIn.event_time) - dutyStartToday) / 60000);
        const gracedLateMin = Math.max(0, rawLateMin - LATE_GRACE_MINUTES); // ১৫ মিনিট গ্রেস পিরিয়ড বাদ দিয়ে
        totalLateMs += gracedLateMin * 60000;
      }
    }

    // যোগদানের তারিখ থেকে হিসাব করে মোট কর্মদিবস বের করা (সর্বোচ্চ `days` দিন)
    const joining = new Date(staff.joining_date);
    const today = new Date();
    const daysSinceJoining = Math.min(days, Math.max(1, Math.ceil((today - joining) / (1000 * 60 * 60 * 24)) + 1));
    const absentDays = Math.max(0, daysSinceJoining - presentDays);

    // একই সময়সীমার মধ্যে হওয়া মোট ওভারটাইম ঘণ্টা
    const overtimeResult = await pool.query(
      `SELECT COALESCE(SUM(hours),0) AS total_overtime_hours
       FROM overtime_sessions
       WHERE staff_id = $1 AND end_time IS NOT NULL
       AND end_time >= (now() + interval '6 hours')::date - ($2 || ' days')::interval - interval '6 hours'`,
      [staffId, days]
    );
    const totalOvertimeHours = parseFloat(overtimeResult.rows[0].total_overtime_hours);

    res.json({
      status: 'ok',
      summary: {
        staff_id: staff.id,
        name: staff.name,
        present_days: presentDays,
        absent_days: absentDays,
        present_hours: +(totalPresentMs / 3600000).toFixed(1),
        break_hours: +(totalBreakMs / 3600000).toFixed(1),
        late_hours: +(totalLateMs / 3600000).toFixed(1),
        overtime_hours: +totalOvertimeHours.toFixed(1)
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফের দিন-ভিত্তিক উপস্থিতির বিস্তারিত লিস্ট (ক'টায় ঢুকল, ক'টায় বের হলো, লেট কত মিনিট, কোন দিন অনুপস্থিত)
app.get('/api/attendance/daily/:staffId', async (req, res) => {
  try {
    const { staffId } = req.params;
    const days = parseInt(req.query.days) || 30;

    const staffResult = await pool.query(`SELECT * FROM staff WHERE id = $1`, [staffId]);
    if (staffResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'স্টাফ পাওয়া যায়নি' });
    }
    const staff = staffResult.rows[0];

    const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    const duty = dutyResult.rows[0] || null;

    const eventsResult = await pool.query(
      `SELECT * FROM attendance_events
       WHERE staff_id = $1 AND event_time >= (now() + interval '6 hours')::date - ($2 || ' days')::interval - interval '6 hours'
       ORDER BY event_time ASC`,
      [staffId, days]
    );

    const byDate = {};
    for (const ev of eventsResult.rows) {
      const d = bdDateStr(ev.event_time);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(ev);
    }

    // যোগদানের তারিখ বা `days` দিন আগে — যেটা পরে, সেখান থেকে আজ পর্যন্ত প্রতিটা দিন তৈরি করা
    const joining = new Date(staff.joining_date);
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    const startDate = joining > rangeStart ? joining : rangeStart;

    const result = [];
    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const dateStr = bdDateStr(d);
      const events = byDate[dateStr] || [];
      if (events.length === 0) {
        result.push({ date: dateStr, status: 'absent' });
        continue;
      }
      const checkIn = events.find((e) => e.event_type === 'check_in');
      const checkOut = [...events].reverse().find((e) => e.event_type === 'check_out');
      const breakStart = events.find((e) => e.event_type === 'break_start');
      const breakEnd = events.find((e) => e.event_type === 'break_end');

      let lateMinutes = 0;
      if (checkIn && duty) {
        const dutyStartToday = timeOnDate(dateStr, duty.duty_start);
        const rawLateMin = Math.round((new Date(checkIn.event_time) - dutyStartToday) / 60000);
        lateMinutes = Math.max(0, rawLateMin - LATE_GRACE_MINUTES); // ১৫ মিনিট গ্রেস পিরিয়ড বাদ দিয়ে
      }

      result.push({
        date: dateStr,
        status: 'present',
        check_in: checkIn ? checkIn.event_time : null,
        check_out: checkOut ? checkOut.event_time : null,
        break_start: breakStart ? breakStart.event_time : null,
        break_end: breakEnd ? breakEnd.event_time : null,
        late_minutes: lateMinutes
      });
    }

    result.reverse(); // সাম্প্রতিক তারিখ আগে
    res.json({ status: 'ok', days: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/duty-schedule', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    res.json({ status: 'ok', schedule: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/duty-schedule', async (req, res) => {
  try {
    const { duty_start, lunch_start, lunch_end, duty_end } = req.body;
    const result = await pool.query(
      `INSERT INTO duty_schedule (id, duty_start, lunch_start, lunch_end, duty_end, updated_at)
       VALUES (1, $1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         duty_start = EXCLUDED.duty_start,
         lunch_start = EXCLUDED.lunch_start,
         lunch_end = EXCLUDED.lunch_end,
         duty_end = EXCLUDED.duty_end,
         updated_at = NOW()
       RETURNING *`,
      [duty_start, lunch_start, lunch_end, duty_end]
    );
    res.json({ status: 'ok', schedule: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== সেটিংস (Settings) ====================

app.get('/api/settings/sync-interval', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'machine_sync_interval_seconds'`);
    const seconds = result.rows.length ? parseInt(result.rows[0].value) : 30;
    res.json({ status: 'ok', sync_interval_seconds: seconds });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/settings/sync-interval', async (req, res) => {
  try {
    let { seconds } = req.body;
    seconds = parseInt(seconds);
    if (!seconds || isNaN(seconds)) {
      return res.status(400).json({ status: 'error', message: 'সঠিক সেকেন্ড সংখ্যা দিন' });
    }
    // নিরাপত্তার জন্য সর্বনিম্ন ১০ সেকেন্ড — এর কম হলে মেশিন অস্থির হয়ে পড়তে পারে
    if (seconds < 10) seconds = 10;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('machine_sync_interval_seconds', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(seconds)]
    );
    res.json({ status: 'ok', sync_interval_seconds: seconds });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== ফিঙ্গারপ্রিন্ট মেশিন (Machines) ====================

app.get('/api/machines', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM machines WHERE active = true ORDER BY created_at DESC`);
    res.json({ status: 'ok', machines: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/machines', async (req, res) => {
  try {
    const { name, ip_address, port } = req.body;
    if (!name || !ip_address) {
      return res.status(400).json({ status: 'error', message: 'নাম এবং IP অ্যাড্রেস দরকার' });
    }
    const result = await pool.query(
      `INSERT INTO machines (name, ip_address, port) VALUES ($1, $2, $3) RETURNING *`,
      [name, ip_address, port || 4370]
    );
    res.json({ status: 'ok', machine: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/machines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE machines SET active = false WHERE id = $1`, [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// মেশিনের IP/পোর্ট আপডেট করুন (যেমন লোকাল IP থেকে পাবলিক IP-তে বদলাতে)
app.put('/api/machines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, ip_address, port } = req.body;
    const result = await pool.query(
      `UPDATE machines SET
        name = COALESCE($1, name),
        ip_address = COALESCE($2, ip_address),
        port = COALESCE($3, port)
       WHERE id = $4
       RETURNING *`,
      [name, ip_address, port, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'মেশিন পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', machine: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// মেশিন থেকে সিঙ্ক প্রোগ্রাম এই রুটে ব্যাচ আকারে attendance log পাঠাবে
// body: { machine_id, logs: [{ staff_id বা employee_no, event_type, event_time }, ...] }
app.post('/api/attendance/machine-sync', async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ status: 'error', message: 'logs অ্যারে দরকার' });
    }
    let inserted = 0;
    for (const log of logs) {
      if (!log.staff_id || !log.event_type || !log.event_time) continue;
      await pool.query(
        `INSERT INTO attendance_events (staff_id, event_type, event_time, source)
         VALUES ($1, $2, $3, 'machine')`,
        [log.staff_id, log.event_type, log.event_time]
      );
      inserted++;
    }
    res.json({ status: 'ok', inserted });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== প্রোডাক্ট (Products) ====================

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM products WHERE active = true ORDER BY created_at DESC`);
    res.json({ status: 'ok', products: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, sewing_price } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'প্রোডাক্টের নাম দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO products (name, sewing_price) VALUES ($1, $2) RETURNING *`,
      [name, sewing_price || 0]
    );
    res.json({ status: 'ok', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sewing_price, apply_to_existing } = req.body;
    const result = await pool.query(
      `UPDATE products SET
        name = COALESCE($1, name),
        sewing_price = COALESCE($2, sewing_price)
       WHERE id = $3
       RETURNING *`,
      [name, sewing_price, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }
    // "আগের হিসাবেও এই দাম যোগ করুন" — টিক দেওয়া থাকলে পুরনো সব এন্ট্রি নতুন দামে রিক্যালকুলেট হবে
    if (apply_to_existing && sewing_price !== undefined) {
      await pool.query(
        `UPDATE production_entries SET sewing_price = $1, amount = quantity * $1 WHERE product_id = $2`,
        [sewing_price, id]
      );
    }
    res.json({ status: 'ok', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const used = await pool.query(`SELECT COUNT(*) FROM production_entries WHERE product_id = $1`, [id]);
    if (parseInt(used.rows[0].count) > 0) {
      return res.status(400).json({
        status: 'error',
        message: 'এই প্রোডাক্ট দিয়ে ইতিমধ্যে কারিগরের হিসাব যোগ হয়ে গেছে, তাই ডিলিট করা যাবে না'
      });
    }
    await pool.query(`UPDATE products SET active = false WHERE id = $1`, [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== কারিগরের প্রোডাকশন এন্ট্রি ====================

// নতুন প্রোডাকশন এন্ট্রি (কে, কোন প্রোডাক্ট, কত পিস) — অটো ক্যালকুলেশন
app.post('/api/production', async (req, res) => {
  try {
    const { staff_id, product_id, quantity, entry_date } = req.body;
    if (!staff_id || !product_id || !quantity) {
      return res.status(400).json({ status: 'error', message: 'staff_id, product_id, quantity দরকার' });
    }
    const productResult = await pool.query(`SELECT * FROM products WHERE id = $1`, [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }
    const sewingPrice = parseFloat(productResult.rows[0].sewing_price);
    const amount = sewingPrice * parseFloat(quantity);

    const result = await pool.query(
      `INSERT INTO production_entries (staff_id, product_id, quantity, sewing_price, amount, entry_date)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE))
       RETURNING *`,
      [staff_id, product_id, quantity, sewingPrice, amount, entry_date || null]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন কারিগরের সব প্রোডাকশন এন্ট্রি (প্রোডাক্টের নামসহ)
app.get('/api/production/staff/:staffId', async (req, res) => {
  try {
    const { staffId } = req.params;
    const result = await pool.query(
      `SELECT pe.*, p.name AS product_name
       FROM production_entries pe
       JOIN products p ON p.id = pe.product_id
       WHERE pe.staff_id = $1
       ORDER BY pe.entry_date DESC, pe.created_at DESC`,
      [staffId]
    );
    res.json({ status: 'ok', entries: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন কারিগরের মোট প্রোডাকশন সামারি (মোট পিস, মোট টাকা)
app.get('/api/production/staff/:staffId/summary', async (req, res) => {
  try {
    const { staffId } = req.params;
    const result = await pool.query(
      `SELECT COALESCE(SUM(quantity),0) AS total_quantity, COALESCE(SUM(amount),0) AS total_amount
       FROM production_entries WHERE staff_id = $1`,
      [staffId]
    );
    res.json({ status: 'ok', summary: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব কারিগরের প্রোডাকশন সামারি একসাথে (স্টাফ লিস্টে দেখানোর জন্য, বারবার কল করা এড়াতে)
app.get('/api/production/summary-all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT staff_id, COALESCE(SUM(quantity),0) AS total_quantity, COALESCE(SUM(amount),0) AS total_amount
       FROM production_entries GROUP BY staff_id`
    );
    res.json({ status: 'ok', summary: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা প্রোডাকশন এন্ট্রি এডিট করুন (পিস সংখ্যা বা প্রোডাক্ট বদলানো)
app.put('/api/production/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, product_id } = req.body;
    const existingResult = await pool.query(`SELECT * FROM production_entries WHERE id = $1`, [id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'এন্ট্রি পাওয়া যায়নি' });
    }
    const existing = existingResult.rows[0];
    let sewingPrice = parseFloat(existing.sewing_price);
    let productId = existing.product_id;

    if (product_id && product_id !== existing.product_id) {
      const p = await pool.query(`SELECT sewing_price FROM products WHERE id = $1`, [product_id]);
      if (p.rows.length === 0) {
        return res.status(404).json({ status: 'error', message: 'প্রোডাক্ট পাওয়া যায়নি' });
      }
      sewingPrice = parseFloat(p.rows[0].sewing_price);
      productId = product_id;
    }

    const qty = quantity !== undefined ? parseFloat(quantity) : parseFloat(existing.quantity);
    const amount = qty * sewingPrice;

    const result = await pool.query(
      `UPDATE production_entries SET quantity = $1, product_id = $2, sewing_price = $3, amount = $4
       WHERE id = $5 RETURNING *`,
      [qty, productId, sewingPrice, amount, id]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// প্রতিটা স্টাফের সর্বশেষ প্রোডাকশন এন্ট্রি — শুধু নির্দিষ্ট সময়ের (ডিফল্ট ৩ ঘণ্টা) মধ্যে যোগ হলে দেখাবে
app.get('/api/production/recent-all', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 3;
    const result = await pool.query(
      `SELECT DISTINCT ON (pe.staff_id) pe.*, p.name AS product_name
       FROM production_entries pe
       JOIN products p ON p.id = pe.product_id
       WHERE pe.created_at >= NOW() - ($1 || ' hours')::interval
       ORDER BY pe.staff_id, pe.created_at DESC`,
      [hours]
    );
    res.json({ status: 'ok', recent: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== ফ্যাক্টরি খরচ (Expenses) ====================

app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM expenses ORDER BY expense_date DESC, created_at DESC LIMIT 100`);
    res.json({ status: 'ok', expenses: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/expenses', verifyAuthOptional, async (req, res) => {
  try {
    const { description, amount, expense_date } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ status: 'error', message: 'বিবরণ এবং টাকার পরিমাণ দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO expenses (description, amount, expense_date) VALUES ($1, $2, COALESCE($3, CURRENT_DATE)) RETURNING *`,
      [description, amount, expense_date || null]
    );

    // যিনি লগইন করে এই খরচ যোগ করলেন তিনি পার্টনার হলে, এটা তার নিজের হিসাব থেকেও বাদ যাবে
    if (req.user && req.user.is_partner) {
      await createPartnerTransaction({
        userId: req.user.id,
        type: 'expense',
        description: `ফ্যাক্টরি খরচ: ${description}`,
        amount,
        addedByUserId: req.user.id
      });
    }

    res.json({ status: 'ok', expense: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== স্টাফ/কারিগরের সাপ্তাহিক পেমেন্ট (Advance) ====================

app.post('/api/staff-payments', verifyAuthOptional, async (req, res) => {
  try {
    const { staff_id, amount, payment_date, note } = req.body;
    if (!staff_id || !amount) {
      return res.status(400).json({ status: 'error', message: 'staff_id এবং টাকার পরিমাণ দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO staff_payments (staff_id, amount, payment_date, note)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4)
       RETURNING *`,
      [staff_id, amount, payment_date || null, note || null]
    );

    // যিনি লগইন করে এই পেমেন্ট দিলেন তিনি পার্টনার হলে, এটাও তার নিজের হিসাব থেকে বাদ যাবে
    if (req.user && req.user.is_partner) {
      const staffResult = await pool.query(`SELECT name FROM staff WHERE id = $1`, [staff_id]);
      const staffName = staffResult.rows[0]?.name || 'স্টাফ';
      await createPartnerTransaction({
        userId: req.user.id,
        type: 'expense',
        description: `${staffName}-কে পেমেন্ট`,
        amount,
        addedByUserId: req.user.id
      });
    }

    res.json({ status: 'ok', payment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সবার পেমেন্ট একসাথে (স্টাফের নামসহ) — সম্পূর্ণ খরচের রিপোর্টের জন্য
app.get('/api/staff-payments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sp.*, s.name AS staff_name
       FROM staff_payments sp
       JOIN staff s ON s.id = sp.staff_id
       ORDER BY sp.payment_date DESC, sp.created_at DESC
       LIMIT 200`
    );
    res.json({ status: 'ok', payments: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফের সব পেমেন্ট হিস্ট্রি
app.get('/api/staff-payments/staff/:staffId', async (req, res) => {
  try {
    const { staffId } = req.params;
    const result = await pool.query(
      `SELECT * FROM staff_payments WHERE staff_id = $1 ORDER BY payment_date DESC, created_at DESC`,
      [staffId]
    );
    res.json({ status: 'ok', payments: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা পেমেন্ট এডিট করুন (টাকার পরিমাণ বদলানো)
app.put('/api/staff-payments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const result = await pool.query(
      `UPDATE staff_payments SET amount = COALESCE($1, amount) WHERE id = $2 RETURNING *`,
      [amount, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'পেমেন্ট পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', payment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// প্রতিটা স্টাফের সর্বশেষ পেমেন্ট — শুধু নির্দিষ্ট সময়ের (ডিফল্ট ৩ ঘণ্টা) মধ্যে দেওয়া হলে দেখাবে
app.get('/api/staff-payments/recent-all', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 3;
    const result = await pool.query(
      `SELECT DISTINCT ON (staff_id) *
       FROM staff_payments
       WHERE created_at >= NOW() - ($1 || ' hours')::interval
       ORDER BY staff_id, created_at DESC`,
      [hours]
    );
    res.json({ status: 'ok', recent: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন স্টাফের মোট পেমেন্ট সামারি
app.get('/api/staff-payments/staff/:staffId/summary', async (req, res) => {
  try {
    const { staffId } = req.params;
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total_paid, COUNT(*) AS payment_count
       FROM staff_payments WHERE staff_id = $1`,
      [staffId]
    );
    res.json({ status: 'ok', summary: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব স্টাফের পেমেন্ট সামারি একসাথে (মোট ব্যালেন্স হিসাব করার জন্য)
app.get('/api/staff-payments/summary-all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT staff_id, COALESCE(SUM(amount),0) AS total_paid
       FROM staff_payments GROUP BY staff_id`
    );
    res.json({ status: 'ok', summary: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== মাসিক বেতনের কারিগরের মজুরি হিসাব ====================

// একজন মাসিক বেতনের কারিগরের সম্পূর্ণ বিস্তারিত মজুরি হিসাব (ক্যাশ মেমোর জন্য)
app.get('/api/salary/staff/:staffId/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await computeSalaryBreakdown(req.params.staffId, days);
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'স্টাফ পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', salary: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সব মাসিক বেতনের কারিগরের মজুরি সামারি একসাথে (মোট ব্যালেন্স হিসাবের জন্য)
app.get('/api/salary/summary-all', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const staffResult = await pool.query(
      `SELECT id FROM staff WHERE active = true AND rate_type = 'monthly'`
    );
    const summaries = [];
    for (const row of staffResult.rows) {
      const s = await computeSalaryBreakdown(row.id, days);
      if (s) {
        summaries.push({
          staff_id: s.staff_id,
          total_salary_earned: s.total_salary_earned,
          total_paid: s.total_paid,
          total_due: s.total_due
        });
      }
    }
    res.json({ status: 'ok', summary: summaries });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== ওভারটাইম ====================

// এই মুহূর্তে যাদের ওভারটাইম চলছে (এখনো শেষ হয়নি)
app.get('/api/overtime/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT os.*, s.name AS staff_name
       FROM overtime_sessions os
       JOIN staff s ON s.id = os.staff_id
       WHERE os.end_time IS NULL
       ORDER BY os.start_time ASC`
    );
    res.json({ status: 'ok', active: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// আগের সব শেষ হওয়া ওভারটাইমের লগ/হিস্ট্রি
app.get('/api/overtime/log', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT os.*, s.name AS staff_name
       FROM overtime_sessions os
       JOIN staff s ON s.id = os.staff_id
       WHERE os.end_time IS NOT NULL
       ORDER BY os.end_time DESC
       LIMIT 100`
    );
    res.json({ status: 'ok', log: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== পাইকার (Wholesaler) ====================

app.get('/api/wholesalers', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM wholesalers ORDER BY created_at DESC`);
    res.json({ status: 'ok', wholesalers: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/wholesalers', async (req, res) => {
  try {
    const { name, address, phone } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'পাইকারের নাম দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO wholesalers (name, address, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name, address || null, phone || null]
    );
    res.json({ status: 'ok', wholesaler: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন পাইকারের প্রোডাক্ট রেট লিস্ট
app.get('/api/wholesalers/:id/rates', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM wholesaler_product_rates WHERE wholesaler_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    res.json({ status: 'ok', rates: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন পাইকারের জন্য নতুন প্রোডাক্ট রেট যোগ করুন
app.post('/api/wholesalers/:id/rates', async (req, res) => {
  try {
    const { id } = req.params;
    const { product_name, price } = req.body;
    if (!product_name || !price) {
      return res.status(400).json({ status: 'error', message: 'প্রোডাক্টের নাম এবং দাম দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO wholesaler_product_rates (wholesaler_id, product_name, price) VALUES ($1, $2, $3) RETURNING *`,
      [id, product_name, price]
    );
    res.json({ status: 'ok', rate: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা প্রোডাক্ট রেট এডিট করুন
app.put('/api/wholesalers/rates/:rateId', async (req, res) => {
  try {
    const { rateId } = req.params;
    const { product_name, price } = req.body;
    const result = await pool.query(
      `UPDATE wholesaler_product_rates SET
        product_name = COALESCE($1, product_name),
        price = COALESCE($2, price)
       WHERE id = $3
       RETURNING *`,
      [product_name || null, price || null, rateId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'রেট পাওয়া যায়নি' });
    }
    res.json({ status: 'ok', rate: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== পাইকারি হিসাব (লেজার) ====================

// একজন পাইকারের সব এন্ট্রি (হিসাব যোগ + রিটার্ন + পেমেন্ট) — লগ আকারে
app.get('/api/wholesalers/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM wholesaler_ledger WHERE wholesaler_id = $1 ORDER BY event_time DESC, created_at DESC`,
      [id]
    );
    res.json({ status: 'ok', ledger: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একজন পাইকারের সামারি — মোট মূল্য, মোট পরিশোধ, বর্তমান দেনা
app.get('/api/wholesalers/:id/summary', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT entry_type, COALESCE(SUM(amount), 0) AS total FROM wholesaler_ledger WHERE wholesaler_id = $1 GROUP BY entry_type`,
      [id]
    );
    let addTotal = 0, returnTotal = 0, paidTotal = 0;
    for (const row of result.rows) {
      if (row.entry_type === 'add') addTotal = parseFloat(row.total);
      if (row.entry_type === 'return') returnTotal = parseFloat(row.total);
      if (row.entry_type === 'payment') paidTotal = parseFloat(row.total);
    }
    const totalValue = addTotal - returnTotal;
    const currentDue = totalValue - paidTotal;
    res.json({
      status: 'ok',
      summary: {
        total_value: +totalValue.toFixed(2),
        total_paid: +paidTotal.toFixed(2),
        current_due: +currentDue.toFixed(2)
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// হিসাব যোগ করুন — নির্দিষ্ট প্রোডাক্ট থেকে পিস সংখ্যা দিয়ে, মোট মূল্যে যোগ হবে
app.post('/api/wholesalers/:id/ledger/add', async (req, res) => {
  try {
    const { id } = req.params;
    const { product_name, quantity } = req.body;
    if (!product_name || !quantity) {
      return res.status(400).json({ status: 'error', message: 'প্রোডাক্ট এবং পিস সংখ্যা দিতে হবে' });
    }
    const rateResult = await pool.query(
      `SELECT price FROM wholesaler_product_rates WHERE wholesaler_id = $1 AND product_name = $2 ORDER BY created_at DESC LIMIT 1`,
      [id, product_name]
    );
    if (rateResult.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'এই প্রোডাক্টের রেট পাওয়া যায়নি' });
    }
    const price = parseFloat(rateResult.rows[0].price);
    const amount = price * parseFloat(quantity);
    const result = await pool.query(
      `INSERT INTO wholesaler_ledger (wholesaler_id, entry_type, product_name, quantity, price_per_unit, amount)
       VALUES ($1, 'add', $2, $3, $4, $5) RETURNING *`,
      [id, product_name, quantity, price, amount]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// রিটার্ন যোগ করুন — মোট মূল্য থেকে বাদ যাবে
app.post('/api/wholesalers/:id/ledger/return', async (req, res) => {
  try {
    const { id } = req.params;
    const { product_name, quantity } = req.body;
    if (!product_name || !quantity) {
      return res.status(400).json({ status: 'error', message: 'প্রোডাক্ট এবং পিস সংখ্যা দিতে হবে' });
    }
    const rateResult = await pool.query(
      `SELECT price FROM wholesaler_product_rates WHERE wholesaler_id = $1 AND product_name = $2 ORDER BY created_at DESC LIMIT 1`,
      [id, product_name]
    );
    if (rateResult.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'এই প্রোডাক্টের রেট পাওয়া যায়নি' });
    }
    const price = parseFloat(rateResult.rows[0].price);
    const amount = price * parseFloat(quantity);
    const result = await pool.query(
      `INSERT INTO wholesaler_ledger (wholesaler_id, entry_type, product_name, quantity, price_per_unit, amount)
       VALUES ($1, 'return', $2, $3, $4, $5) RETURNING *`,
      [id, product_name, quantity, price, amount]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// পেমেন্ট করুন — মোট পরিশোধে যোগ হবে
app.post('/api/wholesalers/:id/ledger/payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { description, amount } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ status: 'error', message: 'বিবরণ এবং টাকার পরিমাণ দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO wholesaler_ledger (wholesaler_id, entry_type, description, amount)
       VALUES ($1, 'payment', $2, $3) RETURNING *`,
      [id, description, amount]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা লেজার এন্ট্রি এডিট করুন
app.put('/api/wholesalers/ledger/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const existing = await pool.query(`SELECT * FROM wholesaler_ledger WHERE id = $1`, [entryId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'এন্ট্রি পাওয়া যায়নি' });
    }
    const entry = existing.rows[0];

    if (entry.entry_type === 'payment') {
      const { description, amount } = req.body;
      const result = await pool.query(
        `UPDATE wholesaler_ledger SET
          description = COALESCE($1, description),
          amount = COALESCE($2, amount)
         WHERE id = $3 RETURNING *`,
        [description || null, amount || null, entryId]
      );
      return res.json({ status: 'ok', entry: result.rows[0] });
    }

    // add/return টাইপের জন্য — পিস সংখ্যা বদলালে দাম দিয়ে গুণ করে নতুন amount বসবে
    const { quantity } = req.body;
    const newQuantity = quantity !== undefined ? parseFloat(quantity) : parseFloat(entry.quantity);
    const newAmount = newQuantity * parseFloat(entry.price_per_unit);
    const result = await pool.query(
      `UPDATE wholesaler_ledger SET quantity = $1, amount = $2 WHERE id = $3 RETURNING *`,
      [newQuantity, newAmount, entryId]
    );
    res.json({ status: 'ok', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// একটা লেজার এন্ট্রি ডিলিট করুন
app.delete('/api/wholesalers/ledger/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    await pool.query(`DELETE FROM wholesaler_ledger WHERE id = $1`, [entryId]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// সিলেক্ট করা স্টাফদের জন্য ওভারটাইম শুরু করুন
app.post('/api/overtime/start', async (req, res) => {
  try {
    const { staff_ids } = req.body;
    if (!Array.isArray(staff_ids) || staff_ids.length === 0) {
      return res.status(400).json({ status: 'error', message: 'অন্তত একজন স্টাফ সিলেক্ট করতে হবে' });
    }
    let started = 0;
    for (const staffId of staff_ids) {
      // আগে থেকে চলমান সেশন থাকলে আবার নতুন করে শুরু করা হবে না
      const existing = await pool.query(
        `SELECT id FROM overtime_sessions WHERE staff_id = $1 AND end_time IS NULL`,
        [staffId]
      );
      if (existing.rows.length === 0) {
        await pool.query(`INSERT INTO overtime_sessions (staff_id, start_time) VALUES ($1, NOW())`, [staffId]);
        started++;
      }
    }
    res.json({ status: 'ok', started });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// চলমান সব ওভারটাইম একসাথে শেষ করুন — ঘণ্টা ও টাকা হিসাব করে বেতনে যোগ হয়ে যাবে
app.post('/api/overtime/end', async (req, res) => {
  try {
    const activeResult = await pool.query(`SELECT * FROM overtime_sessions WHERE end_time IS NULL`);
    const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    const duty = dutyResult.rows[0] || null;

    const ended = [];
    for (const session of activeResult.rows) {
      const staffResult = await pool.query(`SELECT * FROM staff WHERE id = $1`, [session.staff_id]);
      if (staffResult.rows.length === 0) continue;
      const staff = staffResult.rows[0];
      const { hourlyRate } = computeRates(staff, duty);

      const endTime = new Date();
      const hours = (endTime - new Date(session.start_time)) / (1000 * 60 * 60);
      const amount = hours * hourlyRate;

      await pool.query(
        `UPDATE overtime_sessions SET end_time = $1, hours = $2, amount = $3 WHERE id = $4`,
        [endTime, hours.toFixed(2), amount.toFixed(2), session.id]
      );
      ended.push({ staff_id: session.staff_id, staff_name: staff.name, hours: +hours.toFixed(2), amount: +amount.toFixed(2) });
    }

    res.json({ status: 'ok', ended });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== মোট ব্যালেন্সের মাসভিত্তিক ট্রেন্ড ====================

// একটা নির্দিষ্ট মাসে (শুরু থেকে শেষ পর্যন্ত) নেট কত টাকা পাওনা বেড়েছে (আয় − পেমেন্ট) হিসাব করে
async function computeMonthlyNet(monthStart, monthEndExclusive) {
  const prodResult = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM production_entries WHERE entry_date >= $1 AND entry_date < $2`,
    [monthStart, monthEndExclusive]
  );
  const productionEarned = parseFloat(prodResult.rows[0].total);

  const staffResult = await pool.query(
    `SELECT id, rate_amount, joining_date FROM staff WHERE active = true AND rate_type = 'monthly'`
  );
  let salaryEarned = 0;
  const today = new Date();
  const rangeEnd = monthEndExclusive < today ? monthEndExclusive : today; // ভবিষ্যতের দিন গণনা করা হবে না
  for (const s of staffResult.rows) {
    const joining = new Date(s.joining_date);
    const effectiveStart = joining > monthStart ? joining : monthStart;
    if (effectiveStart >= rangeEnd) continue;
    const daysElapsed = Math.max(0, Math.ceil((rangeEnd - effectiveStart) / (1000 * 60 * 60 * 24)));
    const dailyRate = parseFloat(s.rate_amount || 0) / 30;
    salaryEarned += dailyRate * daysElapsed;
  }

  const payResult = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM staff_payments WHERE payment_date >= $1 AND payment_date < $2`,
    [monthStart, monthEndExclusive]
  );
  const paid = parseFloat(payResult.rows[0].total);

  return (productionEarned + salaryEarned) - paid;
}

app.get('/api/balance/trend', async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const thisMonthNet = await computeMonthlyNet(thisMonthStart, nextMonthStart);
    const lastMonthNet = await computeMonthlyNet(lastMonthStart, thisMonthStart);

    let percentChange = 0;
    if (lastMonthNet !== 0) {
      percentChange = ((thisMonthNet - lastMonthNet) / Math.abs(lastMonthNet)) * 100;
    } else if (thisMonthNet !== 0) {
      percentChange = 100;
    }

    res.json({
      status: 'ok',
      this_month_net: +thisMonthNet.toFixed(2),
      last_month_net: +lastMonthNet.toFixed(2),
      percent_change: +percentChange.toFixed(1),
      direction: thisMonthNet >= lastMonthNet ? 'up' : 'down'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Factory Backend চলছে ✅');
});

// ==================== ফিঙ্গারপ্রিন্ট মেশিন সিঙ্ক (Cloud থেকে সরাসরি, Port Forwarding দিয়ে) ====================
// এই ব্যাকএন্ডই সরাসরি মেশিনের পাবলিক IP:পোর্টে কানেক্ট করে ডেটা টেনে আনে, কোনো পিসির দরকার নেই

const PUNCH_COOLDOWN_MS = 60 * 60 * 1000; // একবার পাঞ্চ দেওয়ার পর ১ ঘণ্টার মধ্যে নতুন পাঞ্চ গণনা করা হয় না
const ZONE_TOLERANCE_MIN = 20; // লাঞ্চ শুরু/শেষ, ডিউটি শেষ — এসবের কত মিনিট আগে-পরে গ্রহণযোগ্য

// একটা নির্দিষ্ট তারিখে HH:MM (বাংলাদেশ সময়) সময়টাকে সঠিক UTC Date অবজেক্টে রূপান্তর করে।
// সার্ভার UTC-তে চলে বলে "YYYY-MM-DDTHH:MM" আক্ষরিকভাবে UTC ধরে নেয়, তাই ৬ ঘণ্টা বিয়োগ করে ঠিক করা হচ্ছে।
function timeOnDate(dateStr, hm) {
  return new Date(new Date(`${dateStr}T${hm}`).getTime() - TIMEZONE_CORRECTION_MS);
}

// একজন কারিগরের একদিনের পুরনো (ইতিমধ্যে রেকর্ড হওয়া) + নতুন পাঞ্চ মিলিয়ে,
// সময়ের জোন + অবস্থা (state machine) অনুযায়ী সঠিক event_type ঠিক করে এবং নতুনগুলো ডাটাবেজে বসায়
async function classifyAndInsertPunches(staffId, dateStr, newPunchTimes, duty) {
  // এই দিনে আগে থেকে যা রেকর্ড হয়ে আছে তা টেনে আনা (continuity বজায় রাখতে — সিঙ্ক তো বারবার ছোট ছোট ব্যাচে চলে)
  const existingResult = await pool.query(
    `SELECT * FROM attendance_events WHERE staff_id = $1 AND (event_time + interval '6 hours')::date = $2::date ORDER BY event_time ASC`,
    [staffId, dateStr]
  );
  const existingEvents = existingResult.rows;
  const lastExisting = existingEvents.length ? existingEvents[existingEvents.length - 1] : null;

  let state = 'none'; // none | checked_in | on_break | checked_out
  if (lastExisting) {
    if (lastExisting.event_type === 'check_in' || lastExisting.event_type === 'break_end') state = 'checked_in';
    else if (lastExisting.event_type === 'break_start') state = 'on_break';
    else if (lastExisting.event_type === 'check_out') state = 'checked_out';
  }
  let lastAcceptedTime = lastExisting ? new Date(lastExisting.event_time) : null;

  // জোনগুলো (এই তারিখের জন্য)
  let breakStartZone = null, breakEndZone = null, checkOutZoneStart = null;
  const endOfDay = timeOnDate(dateStr, '23:59:59');
  if (duty) {
    const lunchStart = timeOnDate(dateStr, duty.lunch_start);
    const lunchEnd = timeOnDate(dateStr, duty.lunch_end);
    const dutyEnd = timeOnDate(dateStr, duty.duty_end);
    breakStartZone = [
      new Date(lunchStart.getTime() - ZONE_TOLERANCE_MIN * 60000),
      new Date(lunchStart.getTime() + ZONE_TOLERANCE_MIN * 60000)
    ];
    breakEndZone = [
      new Date(lunchEnd.getTime() - ZONE_TOLERANCE_MIN * 60000),
      new Date(lunchEnd.getTime() + ZONE_TOLERANCE_MIN * 60000)
    ];
    checkOutZoneStart = new Date(dutyEnd.getTime() - ZONE_TOLERANCE_MIN * 60000);
  }

  const sortedNew = [...newPunchTimes].sort((a, b) => new Date(a) - new Date(b));
  let inserted = 0;

  for (const punchTime of sortedNew) {
    const t = new Date(punchTime);

    // ১ ঘণ্টা কুলডাউন — আগের গ্রহণযোগ্য পাঞ্চের ১ ঘণ্টার মধ্যে হলে উপেক্ষা করা হবে
    if (lastAcceptedTime && (t - lastAcceptedTime) < PUNCH_COOLDOWN_MS) {
      continue;
    }

    let eventType = null;

    if (state === 'none') {
      // দিনের প্রথম (গ্রহণযোগ্য) পাঞ্চ সবসময় "উপস্থিতি"
      eventType = 'check_in';
      state = 'checked_in';
    } else if (state === 'checked_out') {
      // ডিউটি শেষের পরে (কুলডাউন পার হয়ে) নতুন পাঞ্চ = নতুন সেশন শুরু
      eventType = 'check_in';
      state = 'checked_in';
    } else if (state === 'checked_in') {
      if (!duty) {
        eventType = 'check_out'; // ডিউটি টাইম সেট করা না থাকলে সহজ ফলব্যাক
        state = 'checked_out';
      } else if (t >= breakStartZone[0] && t <= breakStartZone[1]) {
        eventType = 'break_start';
        state = 'on_break';
      } else if (t >= checkOutZoneStart && t <= endOfDay) {
        eventType = 'check_out';
        state = 'checked_out';
      }
      // নাহলে: কোনো জোনেই স্পষ্টভাবে পড়েনি — অ্যানোমালি, স্ট্যাটাস বদলাবে না
    } else if (state === 'on_break') {
      if (!duty) {
        eventType = 'check_out';
        state = 'checked_out';
      } else if (t >= breakEndZone[0] && t <= breakEndZone[1]) {
        eventType = 'break_end';
        state = 'checked_in';
      } else if (t >= checkOutZoneStart && t <= endOfDay) {
        eventType = 'check_out'; // ব্রেক থেকে ফেরার পাঞ্চ মিস করে সরাসরি বের হয়ে যাওয়া
        state = 'checked_out';
      }
      // নাহলে: অ্যানোমালি, স্ট্যাটাস বদলাবে না
    }

    if (eventType) {
      await pool.query(
        `INSERT INTO attendance_events (staff_id, event_type, event_time, source) VALUES ($1, $2, $3, 'machine')`,
        [staffId, eventType, punchTime]
      );
      inserted++;
      lastAcceptedTime = t;
    }
    // eventType না থাকলে (অ্যানোমালি) — এই পাঞ্চটা রেকর্ড করা হলো না, lastAcceptedTime-ও আপডেট হলো না
  }

  return inserted;
}

async function syncOneMachine(machine) {
  const zkInstance = new ZKLib(machine.ip_address, machine.port, 10000, 4000);
  try {
    console.log(`[মেশিন সিঙ্ক] ${machine.name} (${machine.ip_address}:${machine.port})-এর সাথে কানেক্ট করছি...`);
    await zkInstance.createSocket();

    const attendances = await zkInstance.getAttendances();
    const rawLogs = attendances.data || [];

    const newLogs = machine.last_synced_at
      ? rawLogs.filter((l) => new Date(l.recordTime) > new Date(machine.last_synced_at))
      : rawLogs;

    if (newLogs.length === 0) {
      await zkInstance.disconnect();
      console.log(`[মেশিন সিঙ্ক] ${machine.name}: নতুন কোনো লগ নেই`);
      return;
    }

    // ইউজার আইডি → staff_id ম্যাপিং
    const staffResult = await pool.query(`SELECT id, machine_user_id FROM staff WHERE machine_user_id IS NOT NULL`);
    const userMapping = {};
    for (const s of staffResult.rows) userMapping[String(s.machine_user_id)] = s.id;

    // ডিউটি শিডিউল (জোন হিসাব করার জন্য)
    const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
    const duty = dutyResult.rows[0] || null;

    // ইউজার + তারিখ অনুযায়ী গ্রুপ করা
    // গুরুত্বপূর্ণ: মেশিনের ঘড়ি বাংলাদেশ সময়ে (UTC+৬) সেট করা, কিন্তু আমাদের সার্ভার UTC-তে চলে।
    // node-zklib যে recordTime দেয় সেটা ভুলবশত UTC হিসেবে ধরা হয়ে যায়, তাই এখানে ৬ ঘণ্টা বিয়োগ করে
    // সঠিক UTC সময়ে রূপান্তর করা হচ্ছে (এতে অ্যাপে সঠিক বাংলাদেশ সময় দেখাবে)।
    const grouped = {};
    for (const log of newLogs) {
      const correctedTime = new Date(new Date(log.recordTime).getTime() - TIMEZONE_CORRECTION_MS);
      const day = bdDateStr(correctedTime);
      const key = `${log.deviceUserId}_${day}`;
      if (!grouped[key]) grouped[key] = { deviceUserId: log.deviceUserId, day, punches: [] };
      grouped[key].punches.push(correctedTime.toISOString());
    }

    let inserted = 0;
    for (const key of Object.keys(grouped)) {
      const { deviceUserId, day, punches } = grouped[key];
      const staffId = userMapping[String(deviceUserId)];
      if (!staffId) continue;
      inserted += await classifyAndInsertPunches(staffId, day, punches, duty);
    }

    const latestTime = newLogs.reduce(
      (max, l) => (new Date(l.recordTime) > new Date(max) ? l.recordTime : max),
      newLogs[0].recordTime
    );
    await pool.query(`UPDATE machines SET last_synced_at = $1 WHERE id = $2`, [latestTime, machine.id]);

    await zkInstance.disconnect();
    console.log(`[মেশিন সিঙ্ক] ${machine.name}: ${inserted}টা ইভেন্ট যোগ হলো ✅`);
  } catch (err) {
    console.error(`[মেশিন সিঙ্ক] ${machine.name}-এর সাথে সমস্যা হয়েছে:`, err.message);
  }
}

async function runAllMachineSync() {
  try {
    const result = await pool.query(`SELECT * FROM machines WHERE active = true`);
    for (const machine of result.rows) {
      await syncOneMachine(machine);
    }
  } catch (err) {
    console.error('মেশিন সিঙ্ক চালাতে সমস্যা হয়েছে:', err.message);
  }
}

// অ্যাপে সেট করা ইন্টারভাল অনুযায়ী বারবার সিঙ্ক করে — সেটিংস বদলালে সাথে সাথেই কাজ করবে,
// আলাদা করে রিডিপ্লয় করা লাগবে না
async function scheduleNextSync() {
  await runAllMachineSync();
  let seconds = 30;
  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'machine_sync_interval_seconds'`);
    if (result.rows.length) seconds = Math.max(10, parseInt(result.rows[0].value) || 30);
  } catch (err) {
    console.error('সিঙ্ক ইন্টারভাল পড়তে সমস্যা হয়েছে, ডিফল্ট ৩০ সেকেন্ড ব্যবহার হচ্ছে:', err.message);
  }
  setTimeout(scheduleNextSync, seconds * 1000);
}

// সার্ভার চালু হওয়ার ৩০ সেকেন্ড পর প্রথমবার সিঙ্ক শুরু হবে
setTimeout(scheduleNextSync, 30000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
