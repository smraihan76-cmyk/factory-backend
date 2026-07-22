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
      created_at TIMESTAMP DEFAULT NOW()
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
      return {
        staff_id: s.id,
        name: s.name,
        designation: s.designation,
        phone: s.phone,
        status,
        last_event_time: last ? last.event_time : null,
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
        const lateMs = new Date(checkIn.event_time) - dutyStartToday;
        if (lateMs > 0) totalLateMs += lateMs;
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
        const lateMs = new Date(checkIn.event_time) - dutyStartToday;
        if (lateMs > 0) lateMinutes = Math.round(lateMs / 60000);
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

app.get('/', (req, res) => {
  res.send('Factory Backend চলছে ✅');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
