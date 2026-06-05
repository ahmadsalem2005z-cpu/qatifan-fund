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

// ── Auth Routes ──
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginMember(username, password);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginAdmin(username, password);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Fund Routes ──
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const membersResult = await query(`SELECT COUNT(*) as count FROM members WHERE membership_status = 'active'`);
    const activeMembers = parseInt(membersResult.rows[0].count) || 0;
    const incomeResult = await query(`SELECT SUM(amount) as total_income FROM subscriptions WHERE status = 'paid'`);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;
    const currentDate = new Date();
    const paidThisMonthResult = await query(`SELECT COUNT(*) as paid_count FROM subscriptions WHERE subscription_month = $1 AND subscription_year = $2 AND status = 'paid'`, [currentDate.getMonth() + 1, currentDate.getFullYear()]);
    const paidCount = parseInt(paidThisMonthResult.rows[0].paid_count) || 0;
    const paidPct = activeMembers > 0 ? Math.round((paidCount / activeMembers) * 100) : 0;
    const expensesSumResult = await query(`SELECT SUM(amount) as total FROM expenses`);
    const totalExpenses = parseFloat(expensesSumResult.rows[0].total) || 0;
    const recentExpensesResult = await query(`SELECT category AS cat, label, amount, expense_date AS date FROM expenses ORDER BY expense_date DESC LIMIT 5`);
    const recentExpenses = recentExpensesResult.rows.map(e => ({
      icon: e.cat === "wedding" ? "💍" : e.cat === "condolence" ? "🕊️" : "🚨", label: e.label, amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric' }), cat: e.cat
    }));
    res.json({ balance: totalIncome - totalExpenses, activeMembers, totalExpenses, paidPct, paidCount, expectedCount: activeMembers, recentExpenses });
  } catch (error) { res.status(500).json({ error: "تعذر حساب ملخص الصندوق" }); }
});

// استقبال الشهر والسنة مع الصورة
app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم العثور على صورة لرفعها' });
    const { month, year } = req.body;
    const receiptUrl = req.file.path; 
    const memberId = req.member.memberId; 
    await query(`INSERT INTO pending_receipts (member_id, receipt_url, for_month, for_year) VALUES ($1, $2, $3, $4)`, [memberId, receiptUrl, month || null, year || null]);
    res.status(200).json({ message: 'تم الرفع بنجاح', url: receiptUrl });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ داخلي' }); }
});

// عرض الشهر والسنة للمدير
app.get('/api/admin/pending-receipts', async (req, res) => {
  try {
    const result = await query(`
      SELECT pr.id, pr.receipt_url AS image, pr.created_at AS date, pr.for_month, pr.for_year,
             m.full_name AS "memberName", m.monthly_subscription_amount AS amount
      FROM pending_receipts pr
      JOIN members m ON pr.member_id = m.id
      WHERE pr.status = 'pending' ORDER BY pr.created_at DESC
    `);
    const monthNames = ["", "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    const formattedReceipts = result.rows.map(r => ({
      ...r, date: new Date(r.date).toLocaleDateString('ar-JO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      months: (r.for_month && r.for_year) ? `دفعة ${monthNames[r.for_month]} ${r.for_year}` : "دفعة غير محددة التاريخ"
    }));
    res.json(formattedReceipts);
  } catch (error) { res.status(500).json({ error: 'تعذر جلب الإيصالات' }); }
});

// اعتماد الدفعة بناءً على الشهر والسنة المختارين
app.post('/api/admin/approve-receipt/:id', async (req, res) => {
  try {
    const receiptId = req.params.id;
    const receiptRes = await query(`SELECT member_id, for_month, for_year FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    
    const { member_id: memberId, for_month, for_year } = receiptRes.rows[0];
    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);

    const targetMonth = for_month || new Date().getMonth() + 1; 
    const targetYear = for_year || new Date().getFullYear();
    const DUES_AMOUNT = 5.00;

    const subRes = await query(`SELECT id FROM subscriptions WHERE member_id = $1 AND subscription_month = $2 AND subscription_year = $3`, [memberId, targetMonth, targetYear]);
    if (subRes.rows.length > 0) {
      await query(`UPDATE subscriptions SET status = 'paid', payment_date = CURRENT_TIMESTAMP, amount = $1 WHERE id = $2`, [DUES_AMOUNT, subRes.rows[0].id]);
    } else {
      await query(`INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date) VALUES ($1, $2, $3, $4, 'paid', CURRENT_TIMESTAMP)`, [memberId, targetYear, targetMonth, DUES_AMOUNT]);
    }
    await query(`UPDATE members SET total_debt = GREATEST(COALESCE(total_debt, 0) - $1, 0) WHERE id = $2`, [DUES_AMOUNT, memberId]);
    res.json({ message: 'تم الاعتماد بنجاح' });
  } catch (error) { res.status(500).json({ error: 'تعذر الاعتماد' }); }
});

app.post('/api/admin/reject-receipt/:id', async (req, res) => {
  try { await query(`UPDATE pending_receipts SET status = 'rejected' WHERE id = $1`, [req.params.id]); res.json({ message: 'تم الرفض' }); } 
  catch (error) { res.status(500).json({ error: 'تعذر الرفض' }); }
});

app.post('/api/admin/expenses', async (req, res) => {
  try { await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [req.body.category, req.body.label, req.body.amount]); res.json({ message: 'تم التسجيل' }); } 
  catch (error) { res.status(500).json({ error: 'تعذر التسجيل' }); }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [req.member.memberId]);
  res.json(result.rows[0]);
});

app.get('/api/admin/reports/members', async (req, res) => {
  try {
    const result = await query(`SELECT m.full_name, m.phone_number, m.total_debt, m.membership_status, COALESCE(SUM(s.amount), 0) as total_paid FROM members m LEFT JOIN subscriptions s ON m.id = s.member_id AND s.status = 'paid' GROUP BY m.id ORDER BY m.full_name`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'تعذر جلب التقرير' }); }
});

app.post('/api/requests', verifyToken, async (req, res) => {
  try { await query(`INSERT INTO requests (member_id, type, amount, reason, timing, repayment_plan) VALUES ($1, $2, $3, $4, $5, $6)`, [req.member.memberId, req.body.type, req.body.amount, req.body.reason, req.body.timing, req.body.repay]); res.status(201).json({ success: true }); } 
  catch (error) { res.status(500).json({ error: 'حدث خطأ' }); }
});

app.get('/api/admin/requests', async (req, res) => {
  try { const result = await query(`SELECT r.*, m.full_name, m.phone_number FROM requests r JOIN members m ON r.member_id = m.id ORDER BY r.created_at DESC`); res.json(result.rows); } 
  catch (error) { res.status(500).json({ error: 'تعذر الجلب' }); }
});

app.put('/api/admin/requests/:id', async (req, res) => {
  try {
    const requestData = await query(`SELECT * FROM requests WHERE id = $1`, [req.params.id]);
    if (requestData.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    const reqInfo = requestData.rows[0];
    await query(`UPDATE requests SET status = $1 WHERE id = $2`, [req.body.status, req.params.id]);
    if (req.body.status === 'approved' && reqInfo.status !== 'approved') {
      let expenseLabel = reqInfo.type === 'loan' ? `صرف سلفة للعضو` : reqInfo.type === 'help' ? `صرف مساعدة مالية` : reqInfo.type === 'condolence' ? `صرف مساعدة عزاء` : `صرف نقوط زواج`;
      await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [reqInfo.type, expenseLabel, reqInfo.amount]);
      if (reqInfo.type === 'loan') await query(`UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE id = $2`, [reqInfo.amount, reqInfo.member_id]);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'تعذر التحديث' }); }
});

app.get('/api/announcements', async (req, res) => {
  try { const result = await query(`SELECT * FROM announcements ORDER BY created_at DESC`); res.json(result.rows.map(a => ({...a, date: new Date(a.created_at).toLocaleDateString('ar-JO')}))); } 
  catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/announcements', async (req, res) => {
  try { await query(`INSERT INTO announcements (title, body, type) VALUES ($1, $2, $3)`, [req.body.title, req.body.body, req.body.type]); res.json({ message: 'نجاح' }); } 
  catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/fix-passwords', async (req, res) => {
  try { const hash = await bcrypt.hash('123456', 10); await query(`UPDATE members SET password_hash = $1`, [hash]); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3000, () => { logger.info(`Server running`); if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron(); });