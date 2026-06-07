import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { loginMember, loginAdmin, verifyToken } from './services/auth.js';
import { query } from './config/database.js';
import { scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
import { logger } from './utils/logger.js';
import upload from './config/cloudinary.js';

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ['https://qatifan-member.vercel.app', 'https://qatifan-admin.vercel.app', 'http://localhost:5173'].includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());

// ── Middleware للتحقق من صلاحيات المدير ──
const isAdmin = (req, res, next) => {
  if (req.member && req.member.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'صلاحيات مرفوضة: هذا الإجراء مخصص لمدير النظام فقط' });
  }
};

// ── Auth Routes ────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginMember(username, password);
    res.json(result);
  } catch (error) { res.status(401).json({ error: error.message }); }
});

app.post(['/auth/admin/login', '/auth/admin-login'], async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginAdmin(username, password);
    res.json(result);
  } catch (error) { res.status(401).json({ error: error.message }); }
});

// طلب رمز OTP
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'رقم الجوال مطلوب' });
    const otp = '1234'; 
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); 
    await query(`INSERT INTO otp_verifications (phone_number, otp_code, expires_at) VALUES ($1, $2, $3) ON CONFLICT (phone_number) DO UPDATE SET otp_code = $2, expires_at = $3, is_verified = false`, [phone_number, otp, expiresAt]);
    res.json({ message: 'تم إرسال رمز التحقق بنجاح (1234)' });
  } catch (error) { res.status(500).json({ error: 'تعذر إرسال رمز التحقق' }); }
});

// إنشاء حساب عضو جديد
app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, password, dob, marital_status, otp } = req.body;
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });
    const hash = await bcrypt.hash(password, 10);
    await query(`INSERT INTO members (full_name, phone_number, password_hash, dob, marital_status, role, membership_status) VALUES ($1, $2, $3, $4, $5, 'member', 'active')`, [full_name, phone_number, hash, dob, marital_status]);
    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ message: 'تم إنشاء الحساب بنجاح' });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// ── Member Routes ──────────────────────────────────────────
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const membersCount = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const income = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions WHERE status = 'paid'`);
    const expenses = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses`);
    const recent = await query(`SELECT label, amount, expense_date as date, category as cat FROM expenses ORDER BY expense_date DESC LIMIT 5`);
    res.json({ balance: parseFloat(income.rows[0].total) - parseFloat(expenses.rows[0].total), activeMembers: parseInt(membersCount.rows[0].count), totalExpenses: parseFloat(expenses.rows[0].total), recentExpenses: recent.rows });
  } catch (error) { res.status(500).json({ error: 'تعذر جلب البيانات' }); }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [req.member.memberId]);
  res.json(result.rows[0]);
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  await query(`INSERT INTO pending_receipts (member_id, receipt_url, status) VALUES ($1, $2, 'pending')`, [req.member.memberId, req.file.path]);
  res.json({ message: 'تم الرفع' });
});

// ── Admin Routes ──
app.get('/api/admin/pending-receipts', verifyToken, isAdmin, async (req, res) => {
  const result = await query(`SELECT pr.*, m.full_name AS "memberName" FROM pending_receipts pr JOIN members m ON pr.member_id = m.id WHERE pr.status = 'pending'`);
  res.json(result.rows.map(r => ({ ...r, amount: 5, date: new Date(r.created_at).toLocaleDateString('ar-JO') })));
});

app.post('/api/admin/approve-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  const receipt = await query(`SELECT member_id FROM pending_receipts WHERE id = $1`, [req.params.id]);
  await query(`INSERT INTO subscriptions (member_id, amount, status, payment_date) VALUES ($1, 5, 'paid', CURRENT_TIMESTAMP)`, [receipt.rows[0].member_id]);
  await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [req.params.id]);
  res.json({ message: 'تم الاعتماد' });
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron();
});