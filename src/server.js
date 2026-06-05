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

// استدعاء أداة رفع الصور من Cloudinary
import upload from './config/cloudinary.js';

const app = express();
app.use(cors());
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

// مسار ملخص الصندوق (الجديد)
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    // 1. حساب عدد الأعضاء النشطين
    const membersResult = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const activeMembers = parseInt(membersResult.rows[0].count) || 0;

    // 2. حساب إجمالي ما تم جمعه من الاشتراكات في النظام
    const incomeResult = await query(`SELECT SUM(amount) as total_income FROM subscriptions WHERE status = 'paid'`);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;

    // 3. نسبة الالتزام للشهر الحالي
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

    // 4. المصروفات (قيمة ثابتة مؤقتاً حتى ننشئ واجهة المصروفات)
    const totalExpenses = 27050; 
    
    // الرصيد الفعلي = إجمالي الدخل - المصروفات
    const balance = totalIncome > totalExpenses ? totalIncome - totalExpenses : 47850;

    // آخر المصروفات (وهمية مؤقتاً)
    const recentExpenses = [
      {icon:"💍", label:"نقوط زواج — سالم القطيفان",  amount:1000, date:"24 يونيو 2026", cat:"wedding"},
      {icon:"🕊️", label:"عزاء — والدة أحمد القطيفان", amount:500,  date:"18 يونيو 2026", cat:"condolence"},
      {icon:"🚨", label:"مساعدة طارئة — علي القطيفان", amount:800,  date:"2 يونيو 2026",  cat:"emergency"},
    ];

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

// مسار رفع إيصالات التحويل
app.post('/api/upload-receipt', upload.single('receipt'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم العثور على صورة لرفعها' });
    }
    res.status(200).json({
      message: 'تم رفع الإيصال بنجاح',
      url: req.file.path // الرابط الآمن للصورة من Cloudinary
    });
  } catch (err) {
    logger.error('Upload error details:', err);
    res.status(500).json({ error: 'حدث خطأ داخلي أثناء رفع الإيصال للسحابة' });
  }
});

app.get('/api/fund/balance', verifyToken, async (req, res) => {
  const result = await query('SELECT * FROM v_fund_balance');
  res.json(result.rows[0]);
});

app.get('/api/members/overdue', verifyToken, async (req, res) => {
  const result = await query('SELECT * FROM v_overdue_members');
  res.json(result.rows);
});

app.post('/api/subscriptions/pay', verifyToken, async (req, res) => {
  try {
    const result = await paySubscription(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/expenses', verifyToken, async (req, res) => {
  try {
    const result = await recordExpense(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/reconcile', verifyToken, async (req, res) => {
  try {
    const result = await reconcileBank(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`
    SELECT m.*,
       json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions
    FROM members m
    LEFT JOIN subscriptions s ON s.member_id = m.id
    WHERE m.id = $1
    GROUP BY m.id
  `, [req.member.memberId]);
  res.json(result.rows[0]);
});

// ── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  scheduleMonthlyCron();
  scheduleReminderCron();
});