import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requestOTP, verifyOTP, verifyToken } from './services/auth.js';
import { paySubscription } from './services/paySubscription.js';
import { recordExpense } from './services/recordExpense.js';
import { reconcileBank } from './services/reconcileBank.js';
import { generateMonthlyDues } from './jobs/generateMonthlyDues.js';
import { query } from './config/database.js';
import { scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
import { scheduleReminderCron } from './jobs/sendAutomatedReminders.js';
import { logger } from './utils/logger.js';
import upload from './config/cloudinary.js';

const app = express();
// استبدل الروابط بالروابط الفعلية التي حصلت عليها من Vercel
const allowedOrigins = [
  'https://qatifan-member.vercel.app', 
  'https://qatifan-admin.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// ── Auth Routes ─────────────────────────────────────
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const result = await requestOTP(phoneNumber);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    const result = await verifyOTP(phoneNumber, otp);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Fund Routes ─────────────────────────────────────

// 1. مسار ملخص الصندوق (محدث ليقرأ المصروفات الحقيقية)
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

    // --- الجديد: قراءة المصروفات الحقيقية من قاعدة البيانات ---
    const expensesSumResult = await query(`SELECT SUM(amount) as total FROM expenses`);
    const totalExpenses = parseFloat(expensesSumResult.rows[0].total) || 0;

    // الرصيد الفعلي = الدخل - المصروفات
    const balance = totalIncome - totalExpenses;

    // جلب آخر 5 مصروفات وعرضها
    const recentExpensesResult = await query(`
      SELECT category AS cat, label, amount, expense_date AS date
      FROM expenses
      ORDER BY expense_date DESC LIMIT 5
    `);
    
    const recentExpenses = recentExpensesResult.rows.map(e => ({
      icon: e.cat === "wedding" ? "💍" : e.cat === "condolence" ? "🕊️" : "🚨",
      label: e.label,
      amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-SA', { day: 'numeric', month: 'long', year: 'numeric' }),
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

// 2. مسار رفع إيصالات التحويل
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

// 3. مسار جلب الإيصالات المعلقة
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
      ...r, date: new Date(r.date).toLocaleDateString('ar-SA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      months: "مراجعة الدفعة الشهريّة"
    }));
    res.json(formattedReceipts);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب الإيصالات' });
  }
});

// 4. مسار اعتماد الدفعة 
app.post('/api/admin/approve-receipt/:id', async (req, res) => {
  try {
    const receiptId = req.params.id;
    const receiptRes = await query(`SELECT member_id FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    const memberId = receiptRes.rows[0].member_id;

    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);

    const currentMonth = new Date().getMonth() + 1; 
    const currentYear = new Date().getFullYear();
    await query(`
      INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date)
      VALUES ($1, $2, $3, 150.00, 'paid', CURRENT_TIMESTAMP)
    `, [memberId, currentYear, currentMonth]);

    res.json({ message: 'تم الاعتماد بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'تعذر الاعتماد' });
  }
});

// 5. مسار إضافة مصروف جديد (للوحة المدير) - مسار جديد!
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

// 6. المسارات التشغيلية الأخرى
app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`
    SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions
    FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id
    WHERE m.id = $1 GROUP BY m.id
  `, [req.member.memberId]);
  res.json(result.rows[0]);
});

// ── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  // تم إيقاف الموظف الآلي مؤقتاً لتجنب توقف السيرفر
  // scheduleMonthlyCron();
  // scheduleReminderCron();
});