import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { loginMember, loginAdmin, verifyToken } from './services/auth.js';
import { query } from './config/database.js';
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
    const incomeResult = await query(`SELECT SUM(amount) as total_income FROM subscriptions WHERE status = 'paid'`);
    const expensesSumResult = await query(`SELECT SUM(amount) as total FROM expenses`);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;
    const totalExpenses = parseFloat(expensesSumResult.rows[0].total) || 0;
    
    const recentExpensesResult = await query(`SELECT category AS cat, label, amount, expense_date AS date FROM expenses ORDER BY expense_date DESC LIMIT 5`);
    const recentExpenses = recentExpensesResult.rows.map(e => ({
      icon: e.cat === "wedding" ? "💍" : e.cat === "condolence" ? "🕊️" : "🚨",
      label: e.label, amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric' })
    }));

    res.json({ balance: totalIncome - totalExpenses, activeMembers: parseInt(membersResult.rows[0].count), totalExpenses, recentExpenses });
  } catch (error) { res.status(500).json({ error: "تعذر حساب ملخص الصندوق" }); }
});

// استقبال إيصال دفع (اشتراك أو سلفة)
app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    const { month, year, type } = req.body; // أضفنا type: 'subscription' أو 'debt'
    await query(`INSERT INTO pending_receipts (member_id, receipt_url, for_month, for_year, type) VALUES ($1, $2, $3, $4, $5)`, 
                [req.member.memberId, req.file.path, month || null, year || null, type || 'subscription']);
    res.status(200).json({ message: 'تم الرفع' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// اعتماد الدفعة (ذكي)
app.post('/api/admin/approve-receipt/:id', async (req, res) => {
  try {
    const receiptRes = await query(`SELECT member_id, type, for_month, for_year FROM pending_receipts WHERE id = $1`, [req.params.id]);
    const { member_id, type, for_month, for_year } = receiptRes.rows[0];

    // إذا كانت دفعة سلفة، قلل الذمة مباشرة
    if (type === 'debt') {
        // افترضنا أن الإيصال يحدد المبلغ (سنضيف عمود amount مستقبلاً في pending_receipts)
        await query(`UPDATE members SET total_debt = GREATEST(total_debt - 50, 0) WHERE id = $1`, [member_id]);
    } else {
        // اشتراك شهري عادي
        await query(`INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status) VALUES ($1, $2, $3, 5, 'paid')`, [member_id, for_year, for_month]);
    }
    
    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'تم الاعتماد' });
  } catch (error) { res.status(500).json({ error: 'تعذر الاعتماد' }); }
});

// ── بقية المسارات ──
app.post('/api/admin/expenses', async (req, res) => {
  try { await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [req.body.category, req.body.label, req.body.amount]); res.json({ message: 'تم التسجيل' }); } 
  catch (error) { res.status(500).json({ error: 'تعذر التسجيل' }); }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  const result = await query(`SELECT m.*, json_agg(s ORDER BY s.subscription_year, s.subscription_month) as subscriptions FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [req.member.memberId]);
  res.json(result.rows[0]);
});

app.listen(process.env.PORT || 3000, () => logger.info(`Server running`));