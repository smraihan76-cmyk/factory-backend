const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// প্রথমবার সার্ভার চালু হলে staff টেবিল তৈরি হবে (যদি না থাকে)
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
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('staff টেবিল রেডি ✅');
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

// নতুন স্টাফ/কারিগর যোগ করুন
app.post('/api/staff', async (req, res) => {
  try {
    const { name, phone, designation, rate_type, rate_amount, joining_date } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'নাম দেওয়া বাধ্যতামূলক' });
    }
    const result = await pool.query(
      `INSERT INTO staff (name, phone, designation, rate_type, rate_amount, joining_date)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE))
       RETURNING *`,
      [name, phone || null, designation || null, rate_type || 'piece', rate_amount || 0, joining_date || null]
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
    const { name, phone, designation, rate_type, rate_amount } = req.body;
    const result = await pool.query(
      `UPDATE staff SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        designation = COALESCE($3, designation),
        rate_type = COALESCE($4, rate_type),
        rate_amount = COALESCE($5, rate_amount)
       WHERE id = $6
       RETURNING *`,
      [name, phone, designation, rate_type, rate_amount, id]
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

app.get('/', (req, res) => {
  res.send('Factory Backend চলছে ✅');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
