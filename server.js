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
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
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
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role, name: user.name }, JWT_SECRET, {
      expiresIn: '30d'
    });
    res.json({
      status: 'ok',
      token,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role }
    });
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

// নতুন এডমিন/মডারেটর যোগ করুন — শুধু লগইন করা এডমিনই পারবে
app.post('/api/auth/register', verifyAdmin, async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;
    if (!name || !phone || !password) {
      return res.status(400).json({ status: 'error', message: 'নাম, ফোন এবং পাসওয়ার্ড দিতে হবে' });
    }
    const existing = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'এই ফোন নাম্বার দিয়ে আগে থেকেই একটা অ্যাকাউন্ট আছে' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, phone, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, phone, role, created_at`,
      [name, phone, hash, role === 'admin' ? 'admin' : 'moderator']
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
      `SELECT id, name, phone, role, active, created_at FROM users ORDER BY created_at DESC`
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
     WHERE staff_id = $1 AND event_time::date = CURRENT_DATE
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
async function computeSalaryBreakdown(staffId, days) {
  const staffResult = await pool.query(`SELECT * FROM staff WHERE id = $1`, [staffId]);
  if (staffResult.rows.length === 0) return null;
  const staff = staffResult.rows[0];

  const dutyResult = await pool.query(`SELECT * FROM duty_schedule WHERE id = 1`);
  const duty = dutyResult.rows[0] || null;

  // ডিউটি টাইম থেকে দৈনিক কর্মঘণ্টা (মিনিটে) বের করা, না থাকলে ডিফল্ট ৮ ঘণ্টা
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

  // মাস = ৩০ দিন ধরে দৈনিক রেট এবং মিনিট-রেট বের করা (প্রচলিত হিসাব পদ্ধতি)
  const dailyRate = parseFloat(staff.rate_amount || 0) / 30;
  const perMinuteRate = dailyRate / workMinutes;

  const eventsResult = await pool.query(
    `SELECT * FROM attendance_events
     WHERE staff_id = $1 AND event_time >= CURRENT_DATE - ($2 || ' days')::interval
     ORDER BY event_time ASC`,
    [staffId, days]
  );
  const byDate = {};
  for (const ev of eventsResult.rows) {
    const d = ev.event_time.toISOString().slice(0, 10);
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
    const dateStr = d.toISOString().slice(0, 10);
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
      const dutyStartToday = new Date(`${dateStr}T${duty.duty_start}`);
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

  return {
    staff_id: staff.id,
    name: staff.name,
    daily_rate: +dailyRate.toFixed(2),
    total_salary_earned: +totalEarned.toFixed(2),
    total_paid: totalPaid,
    total_due: +(totalEarned - totalPaid).toFixed(2),
    breakdown
  };
}

// "উপস্থিত যুক্ত করুন" — check_in / break_end (resume) / check_out অটো টগল হয়
app.post('/api/attendance/present', async (req, res) => {
  try {
    const { staff_id, event_time, source } = req.body;
    if (!staff_id) {
      return res.status(400).json({ status: 'error', message: 'staff_id দরকার' });
    }
    const todayEvents = await getTodayEvents(staff_id);
    const eventType = nextPresentEventType(todayEvents);
    const result = await pool.query(
      `INSERT INTO attendance_events (staff_id, event_type, event_time, source)
       VALUES ($1, $2, COALESCE($3, NOW()), $4)
       RETURNING *`,
      [staff_id, eventType, event_time || null, source || 'manual']
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
    const todayEvents = await getTodayEvents(staff_id);
    const last = todayEvents.length ? todayEvents[todayEvents.length - 1].event_type : null;
    if (last !== 'check_in' && last !== 'break_end') {
      return res.status(400).json({ status: 'error', message: 'স্টাফ এখন উপস্থিত অবস্থায় নেই, তাই বিরতি দেওয়া যাবে না' });
    }
    const result = await pool.query(
      `INSERT INTO attendance_events (staff_id, event_type, event_time, source)
       VALUES ($1, 'break_start', COALESCE($2, NOW()), $3)
       RETURNING *`,
      [staff_id, event_time || null, source || 'manual']
    );
    res.json({ status: 'ok', event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// আজকের সব স্টাফের বর্তমান স্ট্যাটাস (উপস্থিত / বিরতিতে / চলে গেছে / মার্ক করা হয়নি)
app.get('/api/attendance/today', async (req, res) => {
  try {
    const staffResult = await pool.query(`SELECT * FROM staff WHERE active = true ORDER BY name ASC`);
    const eventsResult = await pool.query(
      `SELECT * FROM attendance_events WHERE event_time::date = CURRENT_DATE ORDER BY event_time ASC`
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
        const today = new Date().toISOString().slice(0, 10);
        const dutyStartToday = new Date(`${today}T${duty.duty_start}`);
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
       WHERE staff_id = $1 AND event_time >= CURRENT_DATE - ($2 || ' days')::interval
       ORDER BY event_time ASC`,
      [staffId, days]
    );

    // তারিখ অনুযায়ী গ্রুপ করা
    const byDate = {};
    for (const ev of eventsResult.rows) {
      const d = ev.event_time.toISOString().slice(0, 10);
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
        const dutyStartToday = new Date(`${date}T${duty.duty_start}`);
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

    res.json({
      status: 'ok',
      summary: {
        staff_id: staff.id,
        name: staff.name,
        present_days: presentDays,
        absent_days: absentDays,
        present_hours: +(totalPresentMs / 3600000).toFixed(1),
        break_hours: +(totalBreakMs / 3600000).toFixed(1),
        late_hours: +(totalLateMs / 3600000).toFixed(1)
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
       WHERE staff_id = $1 AND event_time >= CURRENT_DATE - ($2 || ' days')::interval
       ORDER BY event_time ASC`,
      [staffId, days]
    );

    const byDate = {};
    for (const ev of eventsResult.rows) {
      const d = ev.event_time.toISOString().slice(0, 10);
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
      const dateStr = d.toISOString().slice(0, 10);
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
        const dutyStartToday = new Date(`${dateStr}T${duty.duty_start}`);
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
    const { name, sewing_price } = req.body;
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
    res.json({ status: 'ok', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
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

// ==================== ফ্যাক্টরি খরচ (Expenses) ====================

app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM expenses ORDER BY expense_date DESC, created_at DESC LIMIT 100`);
    res.json({ status: 'ok', expenses: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { description, amount, expense_date } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ status: 'error', message: 'বিবরণ এবং টাকার পরিমাণ দিতে হবে' });
    }
    const result = await pool.query(
      `INSERT INTO expenses (description, amount, expense_date) VALUES ($1, $2, COALESCE($3, CURRENT_DATE)) RETURNING *`,
      [description, amount, expense_date || null]
    );
    res.json({ status: 'ok', expense: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== স্টাফ/কারিগরের সাপ্তাহিক পেমেন্ট (Advance) ====================

app.post('/api/staff-payments', async (req, res) => {
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
    res.json({ status: 'ok', payment: result.rows[0] });
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

app.get('/', (req, res) => {
  res.send('Factory Backend চলছে ✅');
});

// ==================== ফিঙ্গারপ্রিন্ট মেশিন সিঙ্ক (Cloud থেকে সরাসরি, Port Forwarding দিয়ে) ====================
// এই ব্যাকএন্ডই সরাসরি মেশিনের পাবলিক IP:পোর্টে কানেক্ট করে ডেটা টেনে আনে, কোনো পিসির দরকার নেই

const PUNCH_COOLDOWN_MS = 60 * 60 * 1000; // একবার পাঞ্চ দেওয়ার পর ১ ঘণ্টার মধ্যে নতুন পাঞ্চ গণনা করা হয় না
const ZONE_TOLERANCE_MIN = 20; // লাঞ্চ শুরু/শেষ, ডিউটি শেষ — এসবের কত মিনিট আগে-পরে গ্রহণযোগ্য

// একটা নির্দিষ্ট তারিখে HH:MM সময়টাকে Date অবজেক্টে রূপান্তর করে
function timeOnDate(dateStr, hm) {
  return new Date(`${dateStr}T${hm}`);
}

// একজন কারিগরের একদিনের পুরনো (ইতিমধ্যে রেকর্ড হওয়া) + নতুন পাঞ্চ মিলিয়ে,
// সময়ের জোন + অবস্থা (state machine) অনুযায়ী সঠিক event_type ঠিক করে এবং নতুনগুলো ডাটাবেজে বসায়
async function classifyAndInsertPunches(staffId, dateStr, newPunchTimes, duty) {
  // এই দিনে আগে থেকে যা রেকর্ড হয়ে আছে তা টেনে আনা (continuity বজায় রাখতে — সিঙ্ক তো বারবার ছোট ছোট ব্যাচে চলে)
  const existingResult = await pool.query(
    `SELECT * FROM attendance_events WHERE staff_id = $1 AND event_time::date = $2::date ORDER BY event_time ASC`,
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
  const endOfDay = new Date(`${dateStr}T23:59:59`);
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
    const grouped = {};
    for (const log of newLogs) {
      const day = new Date(log.recordTime).toISOString().slice(0, 10);
      const key = `${log.deviceUserId}_${day}`;
      if (!grouped[key]) grouped[key] = { deviceUserId: log.deviceUserId, day, punches: [] };
      grouped[key].punches.push(log.recordTime);
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
