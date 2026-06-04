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

// مسار رفع إيصالات التحويل (جديد)
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