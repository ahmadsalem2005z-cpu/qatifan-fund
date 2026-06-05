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

// 1. مسار ملخص الصندوق
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    // حساب عدد الأعضاء النشطين
    const membersResult = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const activeMembers = parseInt(membersResult.rows[0].count) || 0;

    // حساب إجمالي ما تم جمعه من الاشتراكات في النظام
    const incomeResult = await query(`SELECT SUM(amount) as total_income FROM subscriptions WHERE status = 'paid'`);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;

    // نسبة الالتزام للشهر الحالي
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

    // المصروفات الثابتة مؤقتاً لحين بناء جدول المصروفات
    const totalExpenses = 27050; 
    const balance = totalIncome > totalExpenses ? totalIncome - totalExpenses : 47850;

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

// 2. مسار رفع إيصالات التحويل وتخزينها برقم العضو (محدث)
app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم العثور على صورة لرفعها' });
    }
    
    const receiptUrl = req.file.path; // الرابط المستضاف على Cloudinary
    const memberId = req.member.memberId; // معرف العضو المستخرج من التوكن

    // إدخال سجل الإيصال المعلق في قاعدة البيانات المجانية الجديدة
    await query(
      `INSERT INTO pending_receipts (member_id, receipt_url) VALUES ($1, $2)`, 
      [memberId, receiptUrl]
    );

    res.status(200).json({
      message: 'تم رفع الإيصال بنجاح وإرساله للمراجعة',
      url: receiptUrl
    });
  } catch (err) {
    logger.error('Upload database storage error:', err);
    res.status(500).json({ error: 'حدث خطأ داخلي أثناء حفظ الإيصال في قاعدة البيانات' });
  }
});

// 3. مسار جلب الإيصالات المعلقة (مخصص للوحة تحكم المدير)
app.get('/api/admin/pending-receipts', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        pr.id, 
        pr.receipt_url AS image, 
        pr.created_at AS date, 
        m.full_name AS "memberName",
        m.monthly_subscription_amount AS amount
      FROM pending_receipts pr
      JOIN members m ON pr.member_id = m.id
      WHERE pr.status = 'pending'
      ORDER BY pr.created_at DESC
    `);
    
    const formattedReceipts = result.rows.map(r => ({
      ...r,
      date: new Date(r.date).toLocaleDateString('ar-SA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      months: "مراجعة الدفعة الشهريّة"
    }));

    res.json(formattedReceipts);
  } catch (error) {
    logger.error('Error fetching admin receipts:', error);
    res.status(500).json({ error: 'تعذر جلب الإيصالات بانتظار الاعتماد' });
  }
});

// 4. مسار اعتماد الدفعة من قبل المدير (المسار الجديد الذي تم إضافته)
app.post('/api/admin/approve-receipt/:id', async (req, res) => {
  try {
    const receiptId = req.params.id;
    
    // 1. جلب بيانات الإيصال لمعرفة من هو العضو
    const receiptRes = await query(`SELECT member_id FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    const memberId = receiptRes.rows[0].member_id;

    // 2. تحديث حالة الإيصال إلى "معتمد"
    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);

    // 3. إضافة دفعة الشهر الحالي إلى سجل العضو ليصبح مسدداً
    const currentMonth = new Date().getMonth() + 1; 
    const currentYear = new Date().getFullYear();
    
    await query(`
      INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date)
      VALUES ($1, $2, $3, 150.00, 'paid', CURRENT_TIMESTAMP)
    `, [memberId, currentYear, currentMonth]);

    res.json({ message: 'تم اعتماد الدفعة وتحديث حساب العضو بنجاح' });
  } catch (error) {
    logger.error('Error approving receipt:', error);
    res.status(500).json({ error: 'تعذر اعتماد الإيصال' });
  }
});

// 5. المسارات التشغيلية الأخرى الصندوق
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
  // scheduleMonthlyCron();
  // scheduleReminderCron();
});