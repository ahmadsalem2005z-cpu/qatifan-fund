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

const calculateDynamicSubscriptionDebt = (lastPaidDateStr) => {
  if (!lastPaidDateStr) return 0;
  const lastPaid = new Date(lastPaidDateStr);
  const today = new Date();
  let debt = 0;
  
  let currentYear = lastPaid.getFullYear();
  let currentMonth = lastPaid.getMonth();
  const endYear = today.getFullYear();
  const endMonth = today.getMonth();

  while (currentYear < endYear || (currentYear === endYear && currentMonth < endMonth)) {
    const fee = (currentYear <= 2015) ? 1.00 : 2.00;
    debt += fee;
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  }
  return debt;
};

app.get('/api/health', (req, res) => res.status(200).json({ message: 'السيرفر يعمل!' }));

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    res.json(await loginMember(username, password));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    res.json(await loginAdmin(username, password));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: "رقم الهاتف مطلوب" });
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); 
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await query(`INSERT INTO otp_verifications (phone_number, otp_code, expires_at) VALUES ($1, $2, $3) ON CONFLICT (phone_number) DO UPDATE SET otp_code = $2, expires_at = $3`, [phone_number, otp, expiresAt]);
    res.json({ message: "تم إرسال رمز التحقق" });
  } catch (err) { res.status(500).json({ error: "حدث خطأ" }); }
});

app.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, dob, marital_status, otp } = req.body;
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: "رمز التحقق غير صحيح" });

    const hashedPassword = await bcrypt.hash(password, 10);
    await query(`INSERT INTO members (full_name, phone_number, email, password_hash, dob, marital_status, role, username, family_branch) VALUES ($1, $2, $3, $4, $5, $6, 'member', $2, 'غير محدد')`, [full_name, phone_number, email, hashedPassword, dob, marital_status]);
    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ success: true, message: "تم إنشاء الحساب" });
  } catch (err) { res.status(500).json({ error: "الرقم مسجل مسبقاً" }); }
});

app.post('/auth/reset-password', async (req, res) => {
  try {
    const { phone_number, otp, new_password } = req.body;
    const otpCheck = await query(`SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()`, [phone_number, otp]);
    if (otpCheck.rows.length === 0) return res.status(400).json({ error: "رمز التحقق غير صحيح" });

    const hashedPassword = await bcrypt.hash(new_password, 10);
    const updateRes = await query(`UPDATE members SET password_hash = $1 WHERE phone_number = $2`, [hashedPassword, phone_number]);
    if (updateRes.rowCount === 0) return res.status(404).json({ error: "رقم الجوال غير مسجل" });

    await query(`DELETE FROM otp_verifications WHERE phone_number = $1`, [phone_number]);
    res.json({ success: true, message: "تم تغيير كلمة المرور" });
  } catch (err) { res.status(500).json({ error: "حدث خطأ" }); }
});

app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const activeMembersRes = await query(`SELECT id, COALESCE(total_debt, 0) as existing_debt, COALESCE(last_paid_date, created_at) as last_paid FROM members WHERE membership_status = 'active'`);
    const activeMembers = activeMembersRes.rows.length;
    
    const subIncomeResult = await query(`SELECT SUM(amount) as total FROM subscriptions WHERE status = 'paid'`);
    const donIncomeResult = await query(`SELECT SUM(amount) as total FROM donations`);
    const totalSubs = parseFloat(subIncomeResult.rows[0].total) || 0;
    const totalDons = parseFloat(donIncomeResult.rows[0].total) || 0;
    const totalIncome = totalSubs + totalDons;
    
    const expensesSumResult = await query(`SELECT SUM(amount) as total FROM expenses`);
    const totalExpenses = parseFloat(expensesSumResult.rows[0].total) || 0;
    const balance = totalIncome - totalExpenses;

    let realTotalUnpaidDebt = 0;
    let committedMembersCount = 0;

    for (const member of activeMembersRes.rows) {
      const subscriptionDebt = calculateDynamicSubscriptionDebt(member.last_paid);
      const otherDebt = parseFloat(member.existing_debt);
      const totalOwed = subscriptionDebt + otherDebt;
      realTotalUnpaidDebt += totalOwed;
      if (totalOwed <= 0) committedMembersCount++;
    }

    const expectedCount = activeMembers;
    const paidPct = expectedCount > 0 ? Math.round((committedMembersCount / expectedCount) * 100) : 0;
    
    const recentExpensesResult = await query(`SELECT category AS cat, label, amount, expense_date AS date FROM expenses ORDER BY expense_date DESC LIMIT 5`);
    const recentExpenses = recentExpensesResult.rows.map(e => ({
      icon: e.cat === "wedding" ? "💍" : e.cat === "condolence" ? "🕊️" : "🚨",
      label: e.label, amount: parseFloat(e.amount),
      date: new Date(e.date).toLocaleDateString('ar-JO', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' }),
      cat: e.cat
    }));

    const currentYear = new Date().getFullYear();
    const topDonorsYearResult = await query(`SELECT donor_name, SUM(amount) as total_donated FROM donations WHERE EXTRACT(YEAR FROM donation_date) = $1 GROUP BY donor_name ORDER BY total_donated DESC LIMIT 5`, [currentYear]);
    const topDonorsAllTimeResult = await query(`SELECT donor_name, SUM(amount) as total_donated FROM donations GROUP BY donor_name ORDER BY total_donated DESC LIMIT 5`);

    res.json({ 
      balance, totalSubs, totalDons, activeMembers, totalExpenses, 
      paidPct, paidCount: committedMembersCount, expectedCount, 
      recentExpenses, totalUnpaidDebt: realTotalUnpaidDebt, 
      topDonorsYear: topDonorsYearResult.rows.map(d => ({ name: d.donor_name, amount: parseFloat(d.total_donated) })), 
      topDonorsAllTime: topDonorsAllTimeResult.rows.map(d => ({ name: d.donor_name, amount: parseFloat(d.total_donated) }))
    });
  } catch (error) { res.status(500).json({ error: "تعذر حساب ملخص الصندوق" }); }
});

app.get('/api/member/account', verifyToken, async (req, res) => {
  try {
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    const result = await query(`SELECT m.*, json_agg(s ORDER BY s.subscription_year DESC, s.subscription_month DESC) as subscriptions FROM members m LEFT JOIN subscriptions s ON s.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [memberId]);
    if (result.rows.length > 0) {
      const member = result.rows[0];
      const subDebt = calculateDynamicSubscriptionDebt(member.last_paid_date || member.created_at);
      member.total_debt = parseFloat(member.total_debt || 0) + subDebt;
      res.json(member);
    } else res.status(404).json({error: 'Not found'});
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/member/statement', verifyToken, async (req, res) => {
  try {
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    const { startDate, endDate } = req.query;
    let queryStr = `SELECT * FROM subscriptions WHERE member_id = $1 AND status = 'paid'`;
    const params = [memberId]; let paramIdx = 2;
    if (startDate) { queryStr += ` AND payment_date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { queryStr += ` AND payment_date <= $${paramIdx++}`; params.push(endDate + ' 23:59:59'); }
    queryStr += ` ORDER BY payment_date ASC`;
    
    const subs = await query(queryStr, params);
    const memberData = await query(`SELECT full_name, phone_number, total_debt, last_paid_date, created_at, family_branch FROM members WHERE id = $1`, [memberId]);
    const member = memberData.rows[0];
    const subDebt = calculateDynamicSubscriptionDebt(member.last_paid_date || member.created_at);
    member.total_debt = parseFloat(member.total_debt || 0) + subDebt;

    res.json({ member, payments: subs.rows, total_paid_in_period: subs.rows.reduce((sum, s) => sum + parseFloat(s.amount), 0) });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/upload-receipt', verifyToken, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'صورة مفقودة' });
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    await query(`INSERT INTO pending_receipts (member_id, receipt_url, status) VALUES ($1, $2, 'pending')`, [memberId, req.file.path]);
    res.status(200).json({ message: 'تم الرفع' });
  } catch (err) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/requests', verifyToken, async (req, res) => {
  try {
    const { type, amount, reason, timing, repay } = req.body;
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    await query(`INSERT INTO requests (member_id, type, amount, reason, timing, repayment_plan) VALUES ($1, $2, $3, $4, $5, $6)`, [memberId, type, amount, reason, timing, repay]);
    res.status(201).json({ success: true });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/announcements', verifyToken, async (req, res) => {
  try {
    const memberId = (req.user && req.user.id) || (req.member && req.member.id) || (req.member && req.member.memberId);
    const result = await query(`SELECT id, title, body, type, created_at FROM announcements WHERE member_id IS NULL OR member_id = $1 ORDER BY created_at DESC`, [memberId]);
    res.json(result.rows.map(a => ({ ...a, date: new Date(a.created_at).toLocaleDateString('ar-JO') })));
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/pending-receipts', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT pr.id, pr.receipt_url AS image_url, pr.created_at AS date, m.full_name, m.monthly_subscription_amount AS amount FROM pending_receipts pr JOIN members m ON pr.member_id = m.id WHERE pr.status = 'pending' ORDER BY pr.created_at DESC`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/approve-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const receiptId = req.params.id;
    const paidAmount = parseFloat(req.body.amount) || 0;
    if (paidAmount <= 0) return res.status(400).json({error: 'مبلغ غير صحيح'});

    const receiptRes = await query(`SELECT member_id FROM pending_receipts WHERE id = $1`, [receiptId]);
    if (receiptRes.rows.length === 0) return res.status(404).json({error: 'الإيصال غير موجود'});
    const memberId = receiptRes.rows[0].member_id;

    const lastSubRes = await query(`SELECT subscription_year, subscription_month FROM subscriptions WHERE member_id = $1 ORDER BY subscription_year DESC, subscription_month DESC LIMIT 1`, [memberId]);
    let currentYear, currentMonth;

    if (lastSubRes.rows.length > 0) {
      currentMonth = parseInt(lastSubRes.rows[0].subscription_month, 10) + 1;
      currentYear = parseInt(lastSubRes.rows[0].subscription_year, 10);
      if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    } else {
      const memberRes = await query(`SELECT last_paid_date, created_at FROM members WHERE id = $1`, [memberId]);
      const dbLastPaid = memberRes.rows[0].last_paid_date;
      let baseDate = dbLastPaid ? new Date(dbLastPaid) : new Date(memberRes.rows[0].created_at || new Date());
      if (dbLastPaid) baseDate.setMonth(baseDate.getMonth() + 1); else baseDate.setDate(1); 
      currentYear = baseDate.getFullYear();
      currentMonth = baseDate.getMonth() + 1;
    }

    let remainingAmount = paidAmount;
    let monthsAdvanced = 0;
    const subscriptionsToInsert = [];

    while (remainingAmount > 0) {
      const monthlyFee = (currentYear <= 2015) ? 1.00 : 2.00;
      if (remainingAmount >= monthlyFee) {
        remainingAmount -= monthlyFee;
        monthsAdvanced++;
        subscriptionsToInsert.push({ year: currentYear, month: currentMonth, fee: monthlyFee });
        currentMonth++;
        if (currentMonth > 12) { currentMonth = 1; currentYear++; }
      } else break;
    }

    if (monthsAdvanced === 0) return res.status(400).json({ error: 'المبلغ المدفوع لا يكفي.' });

    const finalSub = subscriptionsToInsert[subscriptionsToInsert.length - 1];
    const formattedLastPaidDate = `${finalSub.year}-${String(finalSub.month).padStart(2, '0')}-01`;

    await query(`UPDATE pending_receipts SET status = 'approved' WHERE id = $1`, [receiptId]);
    await query(`UPDATE members SET last_paid_date = $1 WHERE id = $2`, [formattedLastPaidDate, memberId]);

    for (const sub of subscriptionsToInsert) {
      await query(`INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status, payment_date) VALUES ($1, $2, $3, $4, 'paid', CURRENT_TIMESTAMP)`, [memberId, sub.year, sub.month, sub.fee]);
    }

    const totalUsed = paidAmount - remainingAmount;
    await query(`INSERT INTO audit_logs (admin_id, member_id, action, amount, reason) VALUES ($1, $2, $3, $4, $5)`, ['Admin', memberId, 'اعتماد إيصال اشتراكات', totalUsed, `تغطية ${monthsAdvanced} أشهر (حتى ${finalSub.month}/${finalSub.year})`]);

    res.json({ message: 'تم الاعتماد بنجاح', advancedMonths: monthsAdvanced });
  } catch (error) { logger.error(error); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/reject-receipt/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`UPDATE pending_receipts SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'تم الرفض' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/expenses', verifyToken, isAdmin, async (req, res) => {
  try {
    const { category, label, amount } = req.body;
    await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [category, label || 'بدون وصف', amount]);
    res.json({ message: 'تم التسجيل' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/donations', verifyToken, isAdmin, async (req, res) => {
  try {
    const { member_id, donor_name, amount, note, publish_announcement } = req.body;
    let targetMemberId = (typeof member_id === 'string' && member_id.trim() !== "") ? member_id.trim() : null;
    let finalDonorName = donor_name || 'فاعل خير';

    if (targetMemberId && !donor_name) {
      const memRes = await query(`SELECT full_name FROM members WHERE id = $1`, [targetMemberId]);
      if(memRes.rows.length > 0) finalDonorName = memRes.rows[0].full_name;
    }
    
    await query(`INSERT INTO donations (member_id, donor_name, amount) VALUES ($1, $2, $3)`, [targetMemberId, finalDonorName, amount]);
    if (publish_announcement) {
        await query(`INSERT INTO announcements (title, body, type, member_id) VALUES ($1, $2, 'honor', null)`, ["شكر وتقدير 🌟", `نشكر "${finalDonorName}" على تبرعه بقيمة ${amount} د.أ.`]);
    }
    res.json({ message: 'تم التسجيل' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/reports/members', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT m.full_name, m.phone_number, m.family_branch, m.membership_status, m.total_debt, m.last_paid_date, m.created_at, COALESCE(SUM(s.amount), 0) as total_paid FROM members m LEFT JOIN subscriptions s ON m.id = s.member_id AND s.status = 'paid' GROUP BY m.id ORDER BY m.full_name`);
    res.json(result.rows.map(m => {
      m.total_debt = parseFloat(m.total_debt || 0) + calculateDynamicSubscriptionDebt(m.last_paid_date || m.created_at);
      return m;
    }));
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/reports/annual', verifyToken, isAdmin, async (req, res) => {
  try {
    const { year } = req.query; const targetYear = year || new Date().getFullYear();
    
    const subs = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM subscriptions WHERE status = 'paid' AND EXTRACT(YEAR FROM payment_date) = $1`, [targetYear]);
    const dons = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM donations WHERE EXTRACT(YEAR FROM donation_date) = $1`, [targetYear]);
    
    const totalSubs = parseFloat(subs.rows[0].total);
    const totalDons = parseFloat(dons.rows[0].total);
    const totalIncome = totalSubs + totalDons;

    const expenses = await query(`SELECT COALESCE(SUM(amount), 0) as total, category FROM expenses WHERE EXTRACT(YEAR FROM expense_date) = $1 GROUP BY category`, [targetYear]);
    const totalExp = expenses.rows.reduce((sum, row) => sum + parseFloat(row.total), 0);
    
    const membersData = await query(`SELECT COUNT(*) as active_members, COALESCE(SUM(total_debt), 0) as total_debt FROM members WHERE membership_status = 'active'`);
    
    res.json({ 
      year: targetYear, 
      total_income: totalIncome, 
      total_subscriptions: totalSubs,
      total_donations: totalDons,
      total_expenses: totalExp, 
      expenses_breakdown: expenses.rows, 
      active_members: parseInt(membersData.rows[0].active_members), 
      total_debt: parseFloat(membersData.rows[0].total_debt) 
    });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/members', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT id, full_name, phone_number, membership_status, total_debt, last_paid_date, created_at, family_branch FROM members ORDER BY full_name`);
    res.json(result.rows.map(m => {
      m.total_debt = parseFloat(m.total_debt || 0) + calculateDynamicSubscriptionDebt(m.last_paid_date || m.created_at);
      return m;
    }));
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/members/list', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT id, full_name FROM members ORDER BY full_name`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/members', verifyToken, isAdmin, async (req, res) => {
  try {
    const { full_name, phone_number, family_branch, total_debt, last_paid_date } = req.body;
    const hash = await bcrypt.hash('123456', 10);
    await query(`INSERT INTO members (full_name, phone_number, family_branch, total_debt, last_paid_date, password_hash, role, membership_status, username) VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active', $2)`, [full_name, phone_number, family_branch || 'غير محدد', total_debt || 0, last_paid_date || null, hash]);
    res.json({ message: 'تم إضافة العضو بنجاح' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/admin/members/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const { full_name, phone_number, family_branch, total_debt, last_paid_date, audit_reason } = req.body;
    const oldData = await query(`SELECT total_debt FROM members WHERE id=$1`, [req.params.id]);
    const diff = (parseFloat(total_debt) || 0) - (parseFloat(oldData.rows[0]?.total_debt) || 0);
    await query(`UPDATE members SET full_name=$1, phone_number=$2, family_branch=$3, total_debt=$4, last_paid_date=$5 WHERE id=$6`, [full_name, phone_number, family_branch, total_debt, last_paid_date || null, req.params.id]);
    if (diff !== 0) await query(`INSERT INTO audit_logs (admin_id, member_id, action, amount, reason) VALUES ($1, $2, $3, $4, $5)`, ['Admin', req.params.id, 'تعديل ذمة يدوي', diff, audit_reason || 'تعديل من لوحة الإدارة']);
    res.json({ message: 'تم تحديث البيانات' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.patch('/api/admin/members/:id/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await query(`UPDATE members SET membership_status = $1 WHERE id = $2`, [status, req.params.id]);
    res.json({ message: 'تم التحديث' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/members/bulk-dues', verifyToken, isAdmin, async (req, res) => {
  try {
    const { amount, branch, status, audit_reason } = req.body;
    let q = `UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE 1=1`;
    const params = [amount]; let idx = 2;
    if (branch && branch !== 'all') { q += ` AND family_branch = $${idx++}`; params.push(branch); }
    if (status && status !== 'all') { q += ` AND membership_status = $${idx++}`; params.push(status); }
    q += ` RETURNING id`;
    const result = await query(q, params);
    if (result.rows.length > 0) {
      await Promise.all(result.rows.map(row => query(`INSERT INTO audit_logs (admin_id, member_id, action, amount, reason) VALUES ($1, $2, $3, $4, $5)`, ['Admin', row.id, 'تطبيق ذمة جماعية', amount, audit_reason || 'رسوم أو اشتراكات جماعية'])));
    }
    res.json({ message: `تمت الإضافة بنجاح` });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/requests', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT r.*, m.full_name, m.phone_number FROM requests r JOIN members m ON r.member_id = m.id ORDER BY r.created_at DESC`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/requests/:id/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const requestId = req.params.id;
    const requestData = await query(`SELECT * FROM requests WHERE id = $1`, [requestId]);
    if (requestData.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    
    const reqInfo = requestData.rows[0];
    await query(`UPDATE requests SET status = $1 WHERE id = $2`, [status, requestId]);

    if (status === 'approved' && reqInfo.status !== 'approved') {
      let expenseLabel = reqInfo.type === 'loan' ? 'صرف سلفة' : 'صرف مساعدة';
      await query(`INSERT INTO expenses (category, label, amount) VALUES ($1, $2, $3)`, [reqInfo.type, expenseLabel, reqInfo.amount]);
      if (reqInfo.type === 'loan') {
        await query(`UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE id = $2`, [reqInfo.amount, reqInfo.member_id]);
        await query(`INSERT INTO audit_logs (admin_id, member_id, action, amount, reason) VALUES ($1, $2, $3, $4, $5)`, ['Admin', reqInfo.member_id, 'إضافة سلفة', reqInfo.amount, 'الموافقة على طلب سلفة من التطبيق']);
      } else {
        await query(`INSERT INTO audit_logs (admin_id, member_id, action, amount, reason) VALUES ($1, $2, $3, $4, $5)`, ['Admin', reqInfo.member_id, 'صرف مساعدة', -Math.abs(reqInfo.amount), `الموافقة على طلب: ${reqInfo.type}`]);
      }
    }
    res.json({ success: true, message: 'تم التحديث' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/announcements', verifyToken, isAdmin, async (req, res) => {
  try {
    const { title, body, type, member_id } = req.body;
    const targetMemberId = (typeof member_id === 'string' && member_id.trim() !== "") ? member_id.trim() : null;
    await query(`INSERT INTO announcements (title, body, type, member_id) VALUES ($1, $2, $3, $4)`, [title, body, type, targetMemberId]);
    res.json({ message: 'تم النشر' });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/audit-logs', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT a.*, COALESCE(m.full_name, 'الصندوق العام') as full_name FROM audit_logs a LEFT JOIN members m ON a.member_id = m.id ORDER BY a.created_at DESC LIMIT 200`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/notifications', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await query(`SELECT n.*, m.full_name FROM notification_queue n JOIN members m ON n.member_id = m.id WHERE n.status = 'pending' ORDER BY n.created_at DESC`);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'تعذر الجلب' }); }
});

app.post('/api/admin/notifications/generate', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM notification_queue WHERE status = 'pending'`);
    const membersRes = await query(`SELECT id, full_name, phone_number, COALESCE(total_debt, 0) as existing_debt, COALESCE(last_paid_date, created_at) as last_paid FROM members WHERE membership_status = 'active'`);
    let generatedCount = 0;
    for (const member of membersRes.rows) {
      const subscriptionDebt = calculateDynamicSubscriptionDebt(member.last_paid);
      const otherDebt = parseFloat(member.existing_debt);
      const totalOwed = subscriptionDebt + otherDebt;
      if (totalOwed > 0) {
        await query(`INSERT INTO notification_queue (member_id, phone_number, message_body) VALUES ($1, $2, $3)`, [member.id, member.phone_number, `مرحباً ${member.full_name}، نذكركم بوجود ذمم مستحقة بقيمة ${totalOwed} د.أ (اشتراكات: ${subscriptionDebt}، أخرى: ${otherDebt}).`]);
        generatedCount++;
      }
    }
    res.json({ success: true, message: `تم توليد ${generatedCount} رسالة` });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/notifications/:id/sent', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`UPDATE notification_queue SET status = 'sent', processed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/admin/notifications/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM notification_queue WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/admin/notifications', verifyToken, isAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM notification_queue WHERE status = 'pending'`);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'خطأ' }); }
});

const initializeDB = async () => {
  try {
    await query(`ALTER TABLE pending_receipts ADD COLUMN IF NOT EXISTS for_month INT, ADD COLUMN IF NOT EXISTS for_year INT`);
    await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS member_id UUID`);
    await query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS family_branch VARCHAR(100) DEFAULT 'غير محدد'`);
    await query(`CREATE TABLE IF NOT EXISTS audit_logs (id SERIAL PRIMARY KEY, admin_id VARCHAR(50) DEFAULT 'Admin', member_id UUID REFERENCES members(id) ON DELETE SET NULL, action VARCHAR(100), amount DECIMAL(10,2), reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await query(`CREATE TABLE IF NOT EXISTS notification_queue (id SERIAL PRIMARY KEY, member_id UUID REFERENCES members(id) ON DELETE CASCADE, phone_number VARCHAR(20) NOT NULL, message_body TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP)`);
    await query(`CREATE TABLE IF NOT EXISTS donations (id SERIAL PRIMARY KEY, member_id UUID REFERENCES members(id) ON DELETE SET NULL, donor_name VARCHAR(255), amount DECIMAL(10,2) NOT NULL, donation_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e) { logger.error("DB Init Error:", e); }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeDB();
  logger.info(`Server running on port ${PORT}`);
  if(typeof scheduleMonthlyCron === 'function') scheduleMonthlyCron();
});