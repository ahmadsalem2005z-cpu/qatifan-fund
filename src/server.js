import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { paySubscription } from './services/paySubscription.js';
import { loginMember, loginAdmin, verifyToken, isAdmin } from './services/auth.js';
import { recordExpense } from './services/recordExpense.js';
import { reconcileBank } from './services/reconcileBank.js';
import { scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
import { query } from './config/database.js';
import { scheduleReminderCron } from './jobs/sendAutomatedReminders.js';
import { logger } from './utils/logger.js';
import upload from './config/cloudinary.js';

const app = express();

// ── CORS Configuration ─────────────────────────────────────
const allowedOrigins = [
  'https://qatifan-member.vercel.app', 
  'https://qatifan-admin.vercel.app',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());

// ── Auth Routes ────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginMember(username, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginAdmin(username, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'رقم الجوال مطلوب' });
    
    const otp = '1234'; // رمز افتراضي
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); 
    
    await query(
      `INSERT INTO verification_otps (phone_number, otp_code, expires_at) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (phone_number) 
       DO UPDATE SET otp_code = $2, expires_at = $3, is_verified = false`,
      [phone_number, otp, expiresAt]
    );
    
    res.json({ message: 'تم إرسال رمز التحقق بنجاح (1234)' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر إرسال رمز التحقق' });
  }
});

app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, dob, marital_status, otp } = req.body;
    
    if (!full_name || !phone_number || !password || !dob) {
      return res.status(400).json({ error: 'الحقول الأساسية مطلوبة' });
    }

    const otpCheck = await query(
      `SELECT * FROM verification_otps WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`,
      [phone_number, otp]
    );
    
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: 'رمز التحقق غير صحيح أو انتهت صلاحيته' });

    const memberCheck = await query(`SELECT id FROM members WHERE phone_number = $1`, [phone_number]);
    if (memberCheck.rows.length > 0) return res.status(400).json({ error: 'رقم الجوال مسجل مسبقاً' });

    const hash = await bcrypt.hash(password, 10);
    
    await query(
      `INSERT INTO members (full_name, phone_number, email, password_hash, dob, marital_status, role) 
       VALUES ($1, $2, $3, $4, $5, $6, 'member')`,
      [full_name, phone_number, email || null, hash, dob, marital_status || 'Single']
    );

    await query(`DELETE FROM verification_otps WHERE phone_number = $1`, [phone_number]);
    res.json({ message: 'تم إنشاء الحساب بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الحساب' });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  try {
    const { phone_number, otp, new_password } = req.body;
    if (!phone_number || !otp || !new_password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

    const otpCheck = await query(
      `SELECT * FROM verification_otps WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`,
      [phone_number, otp]
    );
    
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: 'رمز التحقق غير صحيح أو انتهت صلاحيته' });

    const hash = await bcrypt.hash(new_password, 10);
    const result = await query(`UPDATE members SET password_hash = $1 WHERE phone_number = $2`, [hash, phone_number]);
    
    if (result.rowCount === 0) return res.status(404).json({ error: 'رقم الجوال غير مسجل في النظام' });

    await query(`DELETE FROM verification_otps WHERE phone_number = $1`, [phone_number]);
    res.json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر إعادة تعيين كلمة المرور' });
  }
});

// ── Member & Shared Routes ──────────────────────────────────────────

app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const balanceRes = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM pool_transactions`);
    const membersCount = await query(`SELECT COUNT(*) as count FROM members WHERE is_active = true`);
    const currentYear = new Date().getFullYear();
    const expensesRes = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM fund_expenses WHERE extract(year from expense_date) = $1`,
      [currentYear]
    );

    const currentMonth = new Date().getMonth() + 1;
    const expectedCount = await query(`SELECT COUNT(*) as count FROM members WHERE is_active = true`);
    const paidCount = await query(
      `SELECT COUNT(DISTINCT member_id) as count FROM subscriptions 
       WHERE extract(month from payment_date) = $1 AND extract(year from payment_date) = $2`,
      [currentMonth, currentYear]
    );

    const activeMembers = parseInt(membersCount.rows[0].count) || 0;
    const expCount = parseInt(expectedCount.rows[0].count) || 0;
    const pCount = parseInt(paidCount.rows[0].count) || 0;
    const paidPct = expCount > 0 ? Math.round((pCount / expCount) * 100) : 0;

    const recentExpenses = await query(
      `SELECT expense_reason as label, amount, expense_date as date, category as cat 
       FROM fund_expenses ORDER BY expense_date DESC LIMIT 5`
    );

    const catIcons = { wedding: '💍', condolence: '🕊️', loan: '💰', help: '🤝' };
    const formattedExpenses = recentExpenses.rows.map(e => ({
      label: e.label,
      amount: e.amount,
      date: new Date(e.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' }),
      cat: e.cat,
      icon: catIcons[e.cat] || '📢'
    }));

    res.json({
      balance: balanceRes.rows[0].total,
      activeMembers,
      totalExpenses: expensesRes.rows[0].total,
      paidPct,
      paidCount: pCount,
      expectedCount: expCount,
      recentExpenses: formattedExpenses
    });
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب ملخص الصندوق' });
  }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  try {
    const memberId = req.user.id;
    const memberRes = await query(`SELECT total_debt, last_paid_date FROM members WHERE id = $1`, [memberId]);
    if (memberRes.rows.length === 0) return res.status(404).json({ error: 'العضو غير موجود' });

    const subsRes = await query(
      `SELECT amount, payment_date FROM subscriptions WHERE member_id = $1 ORDER BY payment_date DESC`,
      [memberId]
    );

    res.json({
      total_debt: memberRes.rows[0].total_debt,
      last_paid_date: memberRes.rows[0].last_paid_date,
      subscriptions: subsRes.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب بيانات الحساب' });
  }
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يجب رفع ملف الإيصال' });
    const memberId = req.user.id;
    const imageUrl = req.file.path;

    await query(
      `INSERT INTO receipt_submissions (member_id, image_url, status, amount) VALUES ($1, $2, 'pending', 2.00)`,
      [memberId, imageUrl]
    );
    res.json({ message: 'تم رفع الإيصال بنجاح وهو بانتظار موافقة المدير' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر رفع الإيصال' });
  }
});

app.post('/api/requests', verifyToken, async (req, res) => {
  try {
    const memberId = req.user.id;
    const { type, amount, reason, timing, repay } = req.body;
    if (!type || !amount || !reason) return res.status(400).json({ error: 'الحقول الأساسية مطلوبة' });

    await query(
      `INSERT INTO financial_requests (member_id, type, amount, reason, timing, repay_months, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [memberId, type, amount, reason, timing || null, repay ? parseInt(repay) : null]
    );
    res.json({ message: 'تم إرسال الطلب بنجاح وبانتظار المراجعة' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر تقديم الطلب مالياً' });
  }
});

app.post('/api/member/settings', verifyToken, async (req, res) => {
  try {
    const memberId = req.user.id;
    const { whatsapp_enabled, email_enabled, reminder_frequency } = req.body;
    await query(
      `UPDATE members SET whatsapp_enabled = $1, email_enabled = $2, reminder_frequency = $3 WHERE id = $4`,
      [whatsapp_enabled, email_enabled, reminder_frequency || 'weekly', memberId]
    );
    res.json({ message: 'تم حفظ التفضيلات بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر حفظ تفضيلات التنبيهات' });
  }
});

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await query(`SELECT id, title, body, type, created_at FROM announcements ORDER BY created_at DESC`);
    const formatted = result.rows.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body,
      type: a.type,
      date: new Date(a.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' })
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإعلانات' });
  }
});

// ── Admin Only Routes (الأدوار والصلاحيات الصارمة) ─────────────────

// ✅ المسار الذي كان مفقوداً وتمت إضافته ليعمل تقرير الأعضاء
app.get('/api/admin/reports/members', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT m.full_name, m.phone_number, m.total_debt, m.last_paid_date,
             COALESCE(SUM(s.amount), 0) as total_paid
      FROM members m
      LEFT JOIN subscriptions s ON m.id = s.member_id AND s.status = 'paid'
      GROUP BY m.id
      ORDER BY m.full_name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'تعذر جلب تقرير الأعضاء' });
  }
});

app.get('/api/admin/pending-receipts', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.id, m.full_name, r.image_url, r.amount, r.created_at 
       FROM receipt_submissions r
       JOIN members m ON r.member_id = m.id
       WHERE r.status = 'pending' ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإيصالات المعلقة' });
  }
});

app.post('/api/admin/approve-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const receipt = await query(`SELECT * FROM receipt_submissions WHERE id = $1`, [id]);
    if (receipt.rows.length === 0) return res.status(404).json({ error: 'الإيصال غير موجود' });

    const { member_id, amount } = receipt.rows[0];
    await paySubscription(member_id, amount);
    await query(`UPDATE receipt_submissions SET status = 'approved' WHERE id = $1`, [id]);

    res.json({ message: 'تم اعتماد الدفعة المالية وتحديث ذمة العضو بنجاح' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'حدث خطأ أثناء اعتماد الإيصال' });
  }
});

app.post('/api/admin/reject-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(`UPDATE receipt_submissions SET status = 'rejected' WHERE id = $1`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'الإيصال غير موجود' });
    res.json({ message: 'تم رفض الإيصال بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر رفض الإيصال' });
  }
});

app.post('/api/admin/expenses', verifyToken, isAdmin, async (req, res) => {
  try {
    const { amount, reason, category } = req.body;
    if (!amount || !reason || !category) return res.status(400).json({ error: 'جميع حقول المصروفات مطلوبة' });

    await recordExpense(amount, reason, category);
    res.json({ message: 'تم تسجيل الحركة المالية للمصروفات بنجاح في الصندوق' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'تعذر تسجيل المصروفات' });
  }
});

app.get('/api/admin/requests', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.id, m.full_name, r.type, r.amount, r.reason, r.status, r.created_at 
       FROM financial_requests r
       JOIN members m ON r.member_id = m.id
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الطلبات المالية' });
  }
});

app.post('/api/admin/requests/:id/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

    const result = await query(`UPDATE financial_requests SET status = $1 WHERE id = $2`, [status, id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json({ message: `تم تحديث حالة الطلب المالي إلى ${status}` });
  } catch (error) {
    res.status(500).json({ error: 'تعذر تحديث حالة الطلب' });
  }
});

app.post('/api/admin/reconcile', verifyToken, isAdmin, async (req, res) => {
  try {
    const { bankTransactions } = req.body;
    if (!bankTransactions || !Array.isArray(bankTransactions)) {
      return res.status(400).json({ error: 'بيانات الحركات البنكية غير صحيحة' });
    }
    const report = await reconcileBank(bankTransactions);
    res.json({ message: 'اكتملت عملية المطابقة بنجاح', report });
  } catch (error) {
    res.status(500).json({ error: 'حدث خطأ أثناء المطابقة البنكية' });
  }
});

app.post('/api/admin/announcements', verifyToken, isAdmin, async (req, res) => {
  try {
    const { title, body, type } = req.body;
    if (!title || !body || !type) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    
    await query(
      `INSERT INTO announcements (title, body, type) VALUES ($1, $2, $3)`,
      [title, body, type]
    );
    res.json({ message: 'تم نشر الإعلان بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر نشر الإعلان' });
  }
});

// ── مسار مؤقت لإصلاح كلمات المرور ──
app.get('/api/fix-passwords', async (req, res) => {
  try {
    const hash = await bcrypt.hash('123456', 10);
    await query(`UPDATE members SET password_hash = $1`, [hash]);
    res.json({ message: 'تم إعادة تعيين كلمات المرور افتراضياً بنجاح لحسابات الاختبار' });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في التهيئة الافتراضية' });
  }
});

// ── Start Server & Cron Jobs ───────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`⚡ [Server]: Running cleanly on port ${PORT}`);
  if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron();
  if(typeof scheduleReminderCron === 'function') scheduleReminderCron();
});