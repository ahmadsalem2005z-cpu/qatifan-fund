import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { paySubscription } from './services/paySubscription.js';
import { loginMember, loginAdmin, verifyToken } from './services/auth.js';
import { recordExpense } from './services/recordExpense.js';
import { reconcileBank } from './services/reconcileBank.js';
import { generateMonthlyDues, scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
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

// ── Auth & Registration Routes ─────────────────────────────────────

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

// 1. طلب رمز OTP للتسجيل أو استعادة كلمة المرور
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // توليد 4 أرقام
    const expiresAt = new Date(Date.now() + 10 * 60000); // صالح لـ 10 دقائق

    await query(`
      INSERT INTO otp_verifications (phone_number, otp_code, expires_at) 
      VALUES ($1, $2, $3)
      ON CONFLICT (phone_number) DO UPDATE SET otp_code = $2, expires_at = $3
    `, [phone_number, otp, expiresAt]);

    // هنا يتم ربط خدمة إرسال الـ SMS لاحقاً (مثل UltraMsg أو WhatsApp API)
    console.log(`OTP for ${phone_number} is ${otp}`); 
    
    res.json({ message: "تم إرسال رمز التحقق بنجاح" });
  } catch (err) {
    res.status(500).json({ error: "حدث خطأ أثناء طلب رمز التحقق" });
  }
});

// 2. إتمام التسجيل بعد التحقق من OTP
app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, dob, marital_status, otp } = req.body;
    
    // التحقق من صحة الـ OTP
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) {
      return res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي الصلاحية" });
    }

    // تشفير كلمة المرور وإنشاء الحساب
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // الحل هنا: تمت إضافة حقل username وتم تمرير رقم الجوال ($2) كقيمة له
    await query(`
      INSERT INTO members (full_name, phone_number, email, password_hash, dob, marital_status, role, username) 
      VALUES ($1, $2, $3, $4, $5, $6, 'member', $2)
    `, [full_name, phone_number, email, hashedPassword, dob, marital_status]);
      
    // مسح الـ OTP بعد الاستخدام الناجح
    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    
    res.json({ success: true, message: "تم إنشاء الحساب بنجاح، بانتظار تفعيل الإدارة وتحديد الذمة الأولية." });
  } catch (err) {
    console.error("❌ خطأ في التسجيل:", err);
    res.status(500).json({ error: "رقم الجوال أو الإيميل مسجل مسبقاً في النظام أو هناك خطأ في البيانات" });
  }
});

// ── Fund Routes ─────────────────────────────────────

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

    res.json({
      balance,
      activeMembers,
      totalExpenses,
      paidPct,
      paidCount,
      expectedCount,
      recentExpenses
    });

  } catch (error) {
    logger.error("❌ خطأ في حساب ملخص الصندوق:", error);
    res.status(500).json({ error: "تعذر حساب ملخص الصندوق" });
  }
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم العثور على صورة لرفعها' });
    const receiptUrl = req.file.path; 
    const memberId = req.member.memberId; 
    await query(`INSERT INTO pending_receipts (member_id, receipt_url) VALUES ($1, $2)`, [memberId, receiptUrl]);
    res.status(200).json({ message: 'تم الرفع بنجاح', url: receiptUrl });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ داخلي' });
  }
});

app.get('/api/admin/pending-receipts', async (req, res) => {
  try {
    const result = await query(`
      SELECT pr.id, pr.receipt_url AS image, pr.created_at AS date, 
             m.full_name AS "memberName", m.monthly_subscription_amount AS amount
      FROM pending_receipts pr
      JOIN members m ON pr.member_id = m.id
      WHERE pr.status = 'pending' ORDER BY pr.created_at DESC
    `);
    const formattedReceipts = result.rows.map(r => ({
      ...r, date: new Date(r.date).toLocaleDateString('ar-JO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', numberingSystem: 'latn' }),
      months: "مراجعة الدفعة"
    }));
    res.json(formattedReceipts);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإيصالات' });
  }
});

// ── مسار الاعتماد الجديد (المنطق المالي الديناميكي: 2 د.أ لكل شهر) ──
app.post('/api/admin/approve-receipt/:id', async (req, res) => {
  try {
    const receiptId = req.params.id;
    // استلام المبلغ الذي أدخله أو وافق عليه المدير للإيصال
    const { amount } = req.body; 
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'الرجاء تحديد المبلغ المعتمد لتحديث السجلات.' });
    }

    const receiptRes = await query(`SELECT member_id FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    const memberId = receiptRes.rows[0].member_id;

    // 1. تحديث حالة الإيصال إلى معتمد
    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);

    // 2. حساب عدد الأشهر المغطاة بناءً على تسعيرة 2 د.أ للشهر
    const MONTHLY_FEE = 2.00;
    const monthsToAdvance = Math.floor(amount / MONTHLY_FEE);

    // 3. تحديث بيانات العضو: إنقاص الذمة، وتقديم "تاريخ آخر دفعة" للأمام
    await query(`
      UPDATE members 
      SET 
        total_debt = GREATEST(COALESCE(total_debt, 0) - $1, 0),
        last_paid_date = COALESCE(last_paid_date, CURRENT_DATE) + interval '1 month' * $2
      WHERE id = $3
    `, [amount, monthsToAdvance, memberId]);

    // 4. إدراج الحركة في السجلات المالية (Subscriptions) لتوثيق الدخل
    await query(`
      INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date)
      VALUES ($1, EXTRACT(YEAR FROM CURRENT_DATE), EXTRACT(MONTH FROM CURRENT_DATE), $2, 'paid', CURRENT_TIMESTAMP)
    `, [memberId, amount]);

    res.json({ message: 'تم الاعتماد، وتم تحديث الذمة وتاريخ السداد بنجاح' });
  } catch (error) {
    console.error("خطأ في الاعتماد:", error);
    res.status(500).json({ error: 'تعذر الاعتماد' });
  }
});

app.post('/api/admin/reject-receipt/:id', async (req, res) => {
  try {
    const receiptId = req.params.id;
    await query(`UPDATE pending_receipts SET status = 'rejected' WHERE id = $1`, [receiptId]);
    res.json({ message: 'تم رفض الإيصال' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر رفض الإيصال' });
  }
});

app.post('/api/admin/expenses', async (req, res) => {
  try {
    const { category, label, amount } = req.body;
    await query(
      `INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`,
      [category, label, amount]
    );
    res.json({ message: 'تم تسجيل المصروف بنجاح' });
  } catch (error) {
    logger.error('Error adding expense:', error);
    res.status(500).json({ error: 'تعذر تسجيل المصروف' });
  }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`
    SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions
    FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id
    WHERE m.id = $1 GROUP BY m.id
  `, [req.member.memberId]);
  res.json(result.rows[0]);
});

app.get('/api/admin/reports/members', async (req, res) => {
  try {
    const result = await query(`
      SELECT m.full_name, m.phone_number, m.total_debt, m.last_paid_date, m.membership_status,
             COALESCE(SUM(s.amount), 0) as total_paid
      FROM members m
      LEFT JOIN subscriptions s ON m.id = s.member_id AND s.status = 'paid'
      GROUP BY m.id
      ORDER BY m.full_name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'تعذر جلب التقرير' });
  }
});

// ── Requests System Routes ────────────────────────────────────

app.post('/api/requests', verifyToken, async (req, res) => {
  const { type, amount, reason, timing, repay } = req.body;
  const memberId = req.member.memberId; 

  try {
    await query(`
      INSERT INTO requests (member_id, type, amount, reason, timing, repayment_plan)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [memberId, type, amount, reason, timing, repay]);

    res.status(201).json({ success: true, message: 'تم استلام الطلب بنجاح' });
  } catch (error) {
    console.error("خطأ في حفظ الطلب:", error);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الطلب' });
  }
});

app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await query(`
      SELECT r.*, m.full_name, m.phone_number 
      FROM requests r
      JOIN members m ON r.member_id = m.id
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الطلبات' });
  }
});

app.put('/api/admin/requests/:id', async (req, res) => {
  const { status } = req.body; 
  const requestId = req.params.id;

  try {
    const requestData = await query(`SELECT * FROM requests WHERE id = $1`, [requestId]);
    if (requestData.rows.length === 0) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    
    const reqInfo = requestData.rows[0];

    await query(`
      UPDATE requests 
      SET status = $1 
      WHERE id = $2
    `, [status, requestId]);

    if (status === 'approved' && reqInfo.status !== 'approved') {
      let expenseLabel = '';
      if (reqInfo.type === 'loan') expenseLabel = `صرف سلفة للعضو`;
      else if (reqInfo.type === 'help') expenseLabel = `صرف مساعدة مالية`;
      else if (reqInfo.type === 'condolence') expenseLabel = `صرف مساعدة عزاء`;
      else if (reqInfo.type === 'wedding') expenseLabel = `صرف نقوط زواج`;

      await query(
        `INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`,
        [reqInfo.type, expenseLabel, reqInfo.amount]
      );

      if (reqInfo.type === 'loan') {
        await query(
          `UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE id = $2`,
          [reqInfo.amount, reqInfo.member_id]
        );
      }
    }

    res.json({ success: true, message: `تم تحديث حالة الطلب والحسابات المالية بنجاح` });
  } catch (error) {
    console.error("Error updating request:", error);
    res.status(500).json({ error: 'تعذر تحديث حالة الطلب' });
  }
});

// ── Announcements Routes ────────────────────────────────────

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await query(`SELECT id, title, body, type, created_at FROM announcements ORDER BY created_at DESC`);
    const formatted = result.rows.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body,
      type: a.type,
      date: new Date(a.created_at).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' })
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإعلانات' });
  }
});

app.post('/api/admin/announcements', async (req, res) => {
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

app.get('/api/fix-passwords', async (req, res) => {
  try {
    const hash = await bcrypt.hash('123456', 10);
    await query(`UPDATE members SET password_hash = $1`, [hash]);
    res.json({ success: true, message: "تمت تهيئة جميع كلمات المرور لتصبح 123456 بنجاح!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  
  if(typeof scheduleMonthlyCron === 'function') {
      scheduleMonthlyCron();
  }
});