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

// طلب رمز OTP (تم تصحيح اسم الجدول إلى otp_verifications)
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'رقم الجوال مطلوب' });
    
    const otp = '1234'; 
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); 
    
    await query(
      `INSERT INTO otp_verifications (phone_number, otp_code, expires_at) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (phone_number) 
       DO UPDATE SET otp_code = $2, expires_at = $3, is_verified = false`,
      [phone_number, otp, expiresAt]
    );
    res.json({ message: 'تم إرسال رمز التحقق بنجاح (1234)' });
  } catch (error) { res.status(500).json({ error: 'تعذر إرسال رمز التحقق' }); }
});

// إنشاء حساب عضو جديد
app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, dob, marital_status, otp } = req.body;
    if (!full_name || !phone_number || !password || !dob) return res.status(400).json({ error: 'الحقول الأساسية مطلوبة' });

    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: 'رمز التحقق غير صحيح أو انتهت صلاحيته' });

    const memberCheck = await query(`SELECT id FROM members WHERE phone_number = $1`, [phone_number]);
    if (memberCheck.rows.length > 0) return res.status(400).json({ error: 'رقم الجوال مسجل مسبقاً' });

    const hash = await bcrypt.hash(password, 10);
    await query(
      `INSERT INTO members (full_name, phone_number, email, password_hash, dob, marital_status, role, membership_status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active')`,
      [full_name, phone_number, email || null, hash, dob, marital_status || 'Single']
    );

    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ message: 'تم إنشاء الحساب بنجاح' });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الحساب' }); }
});

// إعادة تعيين كلمة المرور
app.post('/auth/reset-password', async (req, res) => {
  try {
    const { phone_number, otp, new_password } = req.body;
    if (!phone_number || !otp || !new_password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: 'رمز التحقق غير صحيح أو انتهت صلاحيته' });

    const hash = await bcrypt.hash(new_password, 10);
    const result = await query(`UPDATE members SET password_hash = $1 WHERE phone_number = $2`, [hash, phone_number]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'رقم الجوال غير مسجل في النظام' });

    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (error) { res.status(500).json({ error: 'تعذر إعادة تعيين كلمة المرور' }); }
});

// ── Member Routes ──────────────────────────────────────────
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const membersCount = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const activeMembers = parseInt(membersCount.rows[0].count) || 0;
    
    const incomeResult = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions WHERE status = 'paid'`);
    const totalIncome = parseFloat(incomeResult.rows[0].total) || 0;
    
    const expensesRes = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses`);
    const totalExpenses = parseFloat(expensesRes.rows[0].total) || 0;

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const paidCountRes = await query(`SELECT COUNT(*) as count FROM subscriptions WHERE subscription_month = $1 AND subscription_year = $2 AND status = 'paid'`, [currentMonth, currentYear]);
    const paidCount = parseInt(paidCountRes.rows[0].count) || 0;
    const paidPct = activeMembers > 0 ? Math.round((paidCount / activeMembers) * 100) : 0;

    const recentExpensesRes = await query(`SELECT label, amount, expense_date as date, category as cat FROM expenses ORDER BY expense_date DESC LIMIT 5`);
    const catIcons = { wedding: '💍', condolence: '🕊️', loan: '💰', help: '🤝' };
    const recentExpenses = recentExpensesRes.rows.map(e => ({
      label: e.label, amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long' }),
      cat: e.cat, icon: catIcons[e.cat] || '📢'
    }));

    res.json({ balance: totalIncome - totalExpenses, activeMembers, totalExpenses, paidPct, paidCount, expectedCount: activeMembers, recentExpenses });
  } catch (error) { res.status(500).json({ error: 'تعذر جلب ملخص الصندوق' }); }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  try {
    const memberId = req.member.memberId;
    const result = await query(`SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [memberId]);
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'تعذر جلب بيانات الحساب' }); }
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يجب رفع ملف الإيصال' });
    const { month, year } = req.body;
    const memberId = req.member.memberId;
    const imageUrl = req.file.path;
    await query(`INSERT INTO pending_receipts (member_id, receipt_url, for_month, for_year, status) VALUES ($1, $2, $3, $4, 'pending')`, [memberId, imageUrl, month || null, year || null]);
    res.json({ message: 'تم رفع الإيصال بنجاح وهو بانتظار موافقة المدير' });
  } catch (error) { res.status(500).json({ error: 'تعذر رفع الإيصال' }); }
});

app.post('/api/requests', verifyToken, async (req, res) => {
  try {
    const memberId = req.member.memberId;
    const { type, amount, reason, timing, repay } = req.body;
    if (!type || !amount || !reason) return res.status(400).json({ error: 'الحقول الأساسية مطلوبة' });
    await query(`INSERT INTO requests (member_id, type, amount, reason, timing, repayment_plan, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`, [memberId, type, amount, reason, timing, repay]);
    res.json({ message: 'تم إرسال الطلب بنجاح وبانتظار المراجعة' });
  } catch (error) { res.status(500).json({ error: 'تعذر تقديم الطلب مالياً' }); }
});

app.post('/api/member/settings', verifyToken, async (req, res) => {
  try {
    const memberId = req.member.memberId;
    const { whatsapp_enabled, email_enabled, reminder_frequency } = req.body;
    // التأكد من إضافة الأعمدة إذا لم تكن موجودة لمنع أي خطأ مستقبلي
    await query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT true, ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT false, ADD COLUMN IF NOT EXISTS reminder_frequency VARCHAR(20) DEFAULT 'weekly'`);
    await query(`UPDATE members SET whatsapp_enabled = $1, email_enabled = $2, reminder_frequency = $3 WHERE id = $4`, [whatsapp_enabled, email_enabled, reminder_frequency || 'weekly', memberId]);
    res.json({ message: 'تم حفظ التفضيلات بنجاح' });
  } catch (error) { res.status(500).json({ error: 'تعذر حفظ تفضيلات التنبيهات' }); }
});

// ── Admin Only Routes ──────────────────────────────────────
app.get('/api/admin/pending-receipts', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT pr.id, m.full_name AS "memberName", pr.receipt_url AS image, pr.created_at AS date, pr.for_month, pr.for_year 
      FROM pending_receipts pr JOIN members m ON pr.member_id = m.id
      WHERE pr.status = 'pending' ORDER BY pr.created_at DESC
    `);
    const monthNames = ["", "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    const formatted = result.rows.map(r => ({ 
      ...r, 
      amount: 5, 
      months: (r.for_month && r.for_year) ? `اشتراك ${monthNames[r.for_month]} ${r.for_year}` : "دفعة مسددة", 
      date: new Date(r.date).toLocaleDateString('ar-JO') 
    }));
    res.json(formatted);
  } catch (error) { res.status(500).json({ error: 'تعذر جلب الإيصالات' }); }
});

// تم تعطيل خصم الـ 5 دنانير من الـ total_debt هنا لحل مشكلة تناقص السلفة!
app.post('/api/admin/approve-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const receipt = await query(`SELECT member_id, for_month, for_year FROM pending_receipts WHERE id = $1`, [id]);
    if (receipt.rows.length === 0) return res.status(404).json({ error: 'الإيصال غير موجود' });

    const { member_id: memberId, for_month, for_year } = receipt.rows[0];
    const targetMonth = for_month || new Date().getMonth() + 1; 
    const targetYear = for_year || new Date().getFullYear();
    const DUES_AMOUNT = 5.00;

    const subRes = await query(`SELECT id FROM subscriptions WHERE member_id = $1 AND subscription_month = $2 AND subscription_year = $3`, [memberId, targetMonth, targetYear]);
    if (subRes.rows.length > 0) {
      await query(`UPDATE subscriptions SET status = 'paid', payment_date = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2`, [DUES_AMOUNT, subRes.rows[0].id]);
    } else {
      await query(`INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date) VALUES ($1, $2, $3, $4, 'paid', CURRENT_TIMESTAMP)`, [memberId, targetYear, targetMonth, DUES_AMOUNT]);
    }

    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [id]);

    res.json({ message: 'تم الاعتماد بنجاح وتسجيل الاشتراك' });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ أثناء الاعتماد' }); }
});

app.post('/api/admin/reject-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`UPDATE pending_receipts SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'تم رفض الإيصال بنجاح' });
  } catch (error) { res.status(500).json({ error: 'تعذر الرفض' }); }
});

app.post('/api/admin/expenses', verifyToken, isAdmin, async (req, res) => {
  try {
    const { amount, reason, category } = req.body;
    await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [category, reason, amount]);
    res.json({ message: 'تم تسجيل المصروف بنجاح' });
  } catch (error) { res.status(500).json({ error: 'تعذر التسجيل' }); }
});

app.get('/api/admin/requests', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT r.*, m.full_name, m.phone_number FROM requests r JOIN members m ON r.member_id = m.id ORDER BY r.created_at DESC`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'تعذر جلب الطلبات' }); }
});

app.post('/api/admin/requests/:id/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const reqInfo = await query(`SELECT * FROM requests WHERE id = $1`, [id]);
    if (reqInfo.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    
    await query(`UPDATE requests SET status = $1 WHERE id = $2`, [status, id]);
    
    if (status === 'approved' && reqInfo.rows[0].status !== 'approved') {
      const r = reqInfo.rows[0];
      const label = r.type === 'loan' ? 'صرف سلفة للعضو' : r.type === 'help' ? 'صرف مساعدة مالية' : r.type === 'condolence' ? 'صرف مساعدة عزاء' : 'صرف نقوط زواج';
      await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [r.type, label, r.amount]);
      if (r.type === 'loan') {
        await query(`UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE id = $2`, [r.amount, r.member_id]);
      }
    }
    res.json({ message: `تم تحديث حالة الطلب` });
  } catch (error) { res.status(500).json({ error: 'تعذر تحديث حالة الطلب' }); }
});

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM announcements ORDER BY created_at DESC`);
    res.json(result.rows.map(a => ({...a, date: new Date(a.created_at).toLocaleDateString('ar-JO')})));
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/announcements', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`INSERT INTO announcements (title, body, type) VALUES ($1, $2, $3)`, [req.body.title, req.body.body, req.body.type]);
    res.json({ message: 'نجاح' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

// ── مسار مؤقت لإصلاح كلمات المرور ──
app.get('/api/fix-passwords', async (req, res) => {
  try {
    const hash = await bcrypt.hash('123456', 10);
    await query(`UPDATE members SET password_hash = $1`, [hash]);
    res.json({ message: 'تم إعادة تعيين كلمات المرور لـ 123456 بنجاح' });
  } catch (error) { res.status(500).json({ error: 'خطأ في التهيئة' }); }
});

// ── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`⚡ [Server]: Running cleanly on port ${PORT}`);
  if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron();
});