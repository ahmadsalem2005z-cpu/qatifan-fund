import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { loginMember, loginAdmin, verifyToken, isAdmin } from './services/auth.js';
import { scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
import { query } from './config/database.js';
import { logger } from './utils/logger.js';
import upload from './config/cloudinary.js';

const app = express();

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

// ── Auth Routes ──
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginMember(username, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginAdmin(username, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

    const otp = Math.floor(1000 + Math.random() * 9000).toString(); 
    const expiresAt = new Date(Date.now() + 10 * 60000);

    await query(`
      INSERT INTO otp_verifications (phone_number, otp_code, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone_number) DO UPDATE SET otp_code = $2, expires_at = $3
    `, [phone_number, otp, expiresAt]);

    res.json({ message: "تم إرسال رمز التحقق بنجاح" });
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ أثناء طلب رمز التحقق" });
  }
});

app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, dob, marital_status, otp } = req.body;
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي الصلاحية" });

    const hashedPassword = await bcrypt.hash(password, 10);
    await query(`
      INSERT INTO members (full_name, phone_number, email, password_hash, dob, marital_status, role, username)
      VALUES ($1, $2, $3, $4, $5, $6, 'member', $2)
    `, [full_name, phone_number, email, hashedPassword, dob, marital_status]);

    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ success: true, message: "تم إنشاء الحساب بنجاح" });
  } catch (err) {
    res.status(500).json({ error: "رقم الجوال أو الإيميل مسجل مسبقاً" });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  try {
    const { phone_number, otp, new_password } = req.body;
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي الصلاحية" });

    const hashedPassword = await bcrypt.hash(new_password, 10);
    const updateRes = await query(`UPDATE members SET password_hash = $1 WHERE phone_number = $2`, [hashedPassword, phone_number]);
    if (updateRes.rowCount === 0) return res.status(404).json({ error: "رقم الجوال غير مسجل" });

    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ success: true, message: "تم تغيير كلمة المرور بنجاح" });
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ داخلي" });
  }
});

// ── Member Routes ──
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const membersResult = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const activeMembers = parseInt(membersResult.rows[0].count) || 0;

    const incomeResult = await query(`SELECT SUM(amount) as total_income FROM subscriptions WHERE status = 'paid'`);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;

    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    const paidThisMonthResult = await query(`
      SELECT COUNT(*) as paid_count
      FROM subscriptions
      WHERE subscription_month = $1 AND subscription_year = $2 AND status = 'paid'
    `, [currentMonth, currentYear]);

    const paidCount = parseInt(paidThisMonthResult.rows[0].paid_count) || 0;
    const expectedCount = activeMembers;
    const paidPct = expectedCount > 0 ? Math.round((paidCount / expectedCount) * 100) : 0;

    const expensesSumResult = await query(`SELECT SUM(amount) as total FROM expenses`);
    const totalExpenses = parseFloat(expensesSumResult.rows[0].total) || 0;

    // الميزة الجديدة: جمع كل الديون المستحقة على الأعضاء
    const totalDebtResult = await query(`SELECT SUM(total_debt) as total_unpaid_debt FROM members WHERE membership_status = 'active'`);
    const totalUnpaidDebt = parseFloat(totalDebtResult.rows[0].total_unpaid_debt) || 0;

    const balance = totalIncome - totalExpenses;

    const recentExpensesResult = await query(`
      SELECT category AS cat, label, amount, expense_date AS date
      FROM expenses
      ORDER BY expense_date DESC LIMIT 5
    `);

    const recentExpenses = recentExpensesResult.rows.map(e => ({
      icon: e.cat === "wedding" ? "💍" : e.cat === "condolence" ? "🕊️" : "🚨",
      label: e.label,
      amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' }),
      cat: e.cat
    }));

    res.json({ balance, activeMembers, totalExpenses, paidPct, paidCount, expectedCount, recentExpenses, totalUnpaidDebt });
  } catch (error) {
    res.status(500).json({ error: "تعذر حساب ملخص الصندوق" });
  }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  try {
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId) || null;
    const result = await query(`
      SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions
      FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id
      WHERE m.id = $1 GROUP BY m.id
    `, [memberId]);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب بيانات الحساب' });
  }
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم العثور على صورة' });
    const receiptUrl = req.file.path;
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    const month = req.body.month || null;
    const year = req.body.year || null;

    await query(`INSERT INTO pending_receipts (member_id, receipt_url, for_month, for_year, status) VALUES ($1, $2, $3, $4, 'pending')`, [memberId, receiptUrl, month, year]);
    res.status(200).json({ message: 'تم الرفع بنجاح', url: receiptUrl });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ داخلي أثناء الرفع' });
  }
});

app.post('/api/requests', verifyToken, async (req, res) => {
  try {
    const { type, amount, reason, timing, repay } = req.body;
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    await query(`
      INSERT INTO requests (member_id, type, amount, reason, timing, repayment_plan)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [memberId, type, amount, reason, timing, repay]);
    res.status(201).json({ success: true, message: 'تم استلام الطلب' });
  } catch (error) {
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الطلب' });
  }
});

app.get('/api/announcements', verifyToken, async (req, res) => {
  try {
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId) || null;
    const result = await query(`
      SELECT id, title, body, type, created_at 
      FROM announcements 
      WHERE member_id IS NULL OR member_id = $1
      ORDER BY created_at DESC
    `, [memberId]);
    const formatted = result.rows.map(a => ({
      id: a.id, title: a.title, body: a.body, type: a.type,
      date: new Date(a.created_at).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' })
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإعلانات', details: error.message });
  }
});

// ── Admin Only Routes ──
app.get('/api/admin/pending-receipts', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT pr.id, pr.receipt_url AS image_url, pr.created_at AS date, pr.for_month, pr.for_year,
             m.full_name, m.monthly_subscription_amount AS amount
      FROM pending_receipts pr
      JOIN members m ON pr.member_id = m.id
      WHERE pr.status = 'pending' ORDER BY pr.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإيصالات' });
  }
});

// الميزة المطلوبة: الحساب الديناميكي بناءً على المبلغ المدفوع
app.post('/api/admin/approve-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const receiptId = req.params.id;
    const { amount } = req.body; 
    
    // المبلغ الافتراضي 2 إذا لم يقم المدير بإدخاله
    const paidAmount = parseFloat(amount) || 2.00;
    
    // الديناميكية: كل 2 دينار = 1 شهر
    const monthsToAdvance = Math.floor(paidAmount / 2.00); 

    const receiptRes = await query(`SELECT member_id, for_month, for_year FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    
    const { member_id: memberId, for_month, for_year } = receiptRes.rows[0];
    
    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);
    
    // تحديث الدين: إنقاص المبلغ المدفوع من إجمالي الدين
    // تحديث تاريخ الدفع: إضافة الأشهر المحسوبة (monthsToAdvance) إلى آخر تاريخ دفع مسجل
    await query(`
      UPDATE members
      SET total_debt = GREATEST(COALESCE(total_debt, 0) - $1, 0),
          last_paid_date = COALESCE(last_paid_date, CURRENT_DATE) + interval '1 month' * $2
      WHERE id = $3
    `, [paidAmount, monthsToAdvance, memberId]);

    // تسجيل الدفعة في سجل المدفوعات التفصيلي
    const subYear = for_year || new Date().getFullYear();
    const subMonth = for_month || (new Date().getMonth() + 1);

    await query(`
      INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date)
      VALUES ($1, $2, $3, $4, 'paid', CURRENT_TIMESTAMP)
    `, [memberId, subYear, subMonth, paidAmount]);

    res.json({ message: 'تم الاعتماد بنجاح', advancedMonths: monthsToAdvance });
  } catch (error) {
    res.status(500).json({ error: 'تعذر الاعتماد' });
  }
});

app.post('/api/admin/reject-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`UPDATE pending_receipts SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'تم رفض الإيصال' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر الرفض' });
  }
});

app.post('/api/admin/expenses', verifyToken, isAdmin, async (req, res) => {
  try {
    const { category, reason, amount } = req.body;
    await query(
      `INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`,
      [category, reason, amount]
    );
    res.json({ message: 'تم تسجيل المصروف بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر تسجيل المصروف' });
  }
});

app.get('/api/admin/requests', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT r.*, m.full_name, m.phone_number
      FROM requests r JOIN members m ON r.member_id = m.id
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الطلبات' });
  }
});

app.post('/api/admin/requests/:id/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const requestId = req.params.id;

    const requestData = await query(`SELECT * FROM requests WHERE id = $1`, [requestId]);
    if (requestData.rows.length === 0) return res.status(404).json({ error: 'الطلب غير موجود' });
    
    const reqInfo = requestData.rows[0];
    await query(`UPDATE requests SET status = $1 WHERE id = $2`, [status, requestId]);

    if (status === 'approved' && reqInfo.status !== 'approved') {
      let expenseLabel = reqInfo.type === 'loan' ? 'صرف سلفة' : 'صرف مساعدة';
      await query(
        `INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`,
        [reqInfo.type, expenseLabel, reqInfo.amount]
      );
      if (reqInfo.type === 'loan') {
        await query(`UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE id = $2`, [reqInfo.amount, reqInfo.member_id]);
      }
    }
    res.json({ success: true, message: 'تم التحديث' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر التحديث' });
  }
});

app.post('/api/admin/announcements', verifyToken, isAdmin, async (req, res) => {
  try {
    const { title, body, type, member_id } = req.body;
    const targetMemberId = (typeof member_id === 'string' && member_id.trim() !== "") ? member_id.trim() : null;
    await query(
      `INSERT INTO announcements (title, body, type, member_id) VALUES ($1, $2, $3, $4)`, 
      [title, body, type, targetMemberId]
    );
    res.json({ message: 'تم نشر الإعلان' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر النشر', details: error.message });
  }
});

app.get('/api/admin/members/list', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT id, full_name FROM members ORDER BY full_name`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الأعضاء' });
  }
});

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
    res.status(500).json({ error: 'تعذر جلب التقرير' });
  }
});

app.get('/api/fix-passwords', async (req, res) => {
  try {
    const hash = await bcrypt.hash('123456', 10);
    await query(`UPDATE members SET password_hash = $1`, [hash]);
    res.json({ message: "تمت التهيئة وتشفير جميع كلمات المرور بنجاح" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const initializeDB = async () => {
  try {
    await query(`ALTER TABLE pending_receipts ADD COLUMN IF NOT EXISTS for_month INT, ADD COLUMN IF NOT EXISTS for_year INT`);
    await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS member_id UUID`);
    logger.info("Database schema validated successfully.");
  } catch (e) {
    logger.error("DB Init Error:", e);
  }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeDB();
  logger.info(`Server running on port ${PORT}`);
  if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron();
});