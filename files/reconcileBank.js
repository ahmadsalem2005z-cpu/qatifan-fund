/**
 * services/reconcileBank.js
 *
 * ════════════════════════════════════════════════════════════
 *  الوظيفة: مطابقة الرصيد الدفتري (النظام) مع الرصيد البنكي الفعلي
 *
 *  الخوارزمية:
 *  1. حساب الرصيد الدفتري من fund_transactions
 *  2. مقارنته بالرصيد البنكي المُدخَل
 *  3. حساب الفروقات وتصنيفها
 *  4. حفظ نتيجة المطابقة في جدول مخصص
 *  5. إرسال تقرير للمسؤولين
 * ════════════════════════════════════════════════════════════
 */

import { withTransaction, query } from '../config/database.js';
import { sendNotification }        from './notificationService.js';
import { logger }                  from '../utils/logger.js';

// حد الفارق المقبول قبل اعتباره خطأ (بالريال)
const ACCEPTABLE_VARIANCE = parseFloat(process.env.RECONCILE_TOLERANCE || '1.00');

// ══════════════════════════════════════════════════════════════
//  الدالة الرئيسية
// ══════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {number}  params.actualBankBalance   - الرصيد البنكي الفعلي (من كشف الحساب)
 * @param {string}  params.reconciledBy        - UUID المسؤول الذي أجرى المطابقة
 * @param {string}  [params.periodStart]       - بداية الفترة (YYYY-MM-DD)
 * @param {string}  [params.periodEnd]         - نهاية الفترة (YYYY-MM-DD)
 * @param {string}  [params.notes]
 *
 * @returns {Promise<ReconciliationReport>}
 */
export async function reconcileBank({
  actualBankBalance,
  reconciledBy,
  periodStart = null,
  periodEnd   = null,
  notes       = null,
}) {
  // ── التحقق من المدخلات ─────────────────────────────────────
  if (actualBankBalance === undefined || actualBankBalance === null)
    throw new Error('الرصيد البنكي الفعلي مطلوب');
  if (actualBankBalance < 0)
    throw new Error('الرصيد البنكي لا يمكن أن يكون سالباً');
  if (!reconciledBy)
    throw new Error('reconciledBy مطلوب');

  logger.info('بدء عملية المطابقة البنكية', {
    actualBankBalance,
    reconciledBy,
    periodStart,
    periodEnd,
  });

  // ── 1. حساب الرصيد الدفتري الكامل ───────────────────────
  const bookBalanceResult = await query(`
    SELECT
      COALESCE(SUM(CASE WHEN transaction_type = 'deposit'    THEN amount ELSE 0 END), 0) AS total_deposits,
      COALESCE(SUM(CASE WHEN transaction_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS total_withdrawals,
      COALESCE(SUM(CASE WHEN transaction_type = 'deposit'    THEN amount
                        WHEN transaction_type = 'withdrawal' THEN -amount END), 0)        AS book_balance,
      COUNT(*) AS transaction_count
    FROM fund_transactions
    ${periodStart && periodEnd
      ? `WHERE transaction_date BETWEEN '${periodStart}' AND '${periodEnd}'`
      : ''}
  `);

  const bookData        = bookBalanceResult.rows[0];
  const bookBalance     = Number(bookData.book_balance);
  const totalDeposits   = Number(bookData.total_deposits);
  const totalWithdrawals= Number(bookData.total_withdrawals);
  const txCount         = Number(bookData.transaction_count);

  // ── 2. حساب الفارق ───────────────────────────────────────
  const variance        = actualBankBalance - bookBalance;
  const absVariance     = Math.abs(variance);
  const isBalanced      = absVariance <= ACCEPTABLE_VARIANCE;
  const status          = isBalanced ? 'balanced' : (variance > 0 ? 'surplus' : 'deficit');

  // ── 3. تحليل آخر 5 معاملات (للمراجعة إن وُجد فارق) ──────
  const recentTxResult = await query(`
    SELECT
      t.id,
      t.transaction_type,
      t.amount,
      t.transaction_date,
      t.reference_number,
      t.description,
      t.balance_after,
      m.full_name AS member_name
    FROM  fund_transactions t
    LEFT JOIN members m ON m.id = t.member_id
    ORDER BY t.transaction_date DESC, t.created_at DESC
    LIMIT 10
  `);

  // ── 4. حساب إجمالي الذمم المستحقة (للصورة الكاملة) ──────
  const pendingDebtResult = await query(`
    SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS total_pending_debt
    FROM   subscriptions
    WHERE  status IN ('pending', 'overdue')
  `);
  const totalPendingDebt = Number(pendingDebtResult.rows[0].total_pending_debt);

  // ── 5. بناء تقرير المطابقة ────────────────────────────────
  const report = {
    reconciledAt:     new Date().toISOString(),
    reconciledBy,
    periodStart,
    periodEnd,

    // الأرقام الأساسية
    bookBalance,
    actualBankBalance,
    variance,
    absVariance,

    // ملخص الحركات
    totalDeposits,
    totalWithdrawals,
    transactionCount: txCount,

    // التشخيص
    status,              // 'balanced' | 'surplus' | 'deficit'
    isBalanced,
    toleranceUsed: ACCEPTABLE_VARIANCE,

    // ذمم مستحقة (غير محصّلة بعد)
    totalPendingDebt,
    expectedBalanceIfCollected: bookBalance + totalPendingDebt,

    // آخر المعاملات للمراجعة
    recentTransactions: recentTxResult.rows,

    notes,
  };

  // ── 6. تسجيل نتيجة المطابقة في DB ───────────────────────
  await query(`
    INSERT INTO reconciliation_logs
      (reconciled_by, actual_bank_balance, book_balance,
       variance, status, period_start, period_end, notes, report_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT DO NOTHING
  `, [
    reconciledBy,
    actualBankBalance,
    bookBalance,
    variance,
    status,
    periodStart,
    periodEnd,
    notes,
    JSON.stringify(report),
  ]).catch(() => {
    // جدول reconciliation_logs قد لا يكون موجوداً بعد — لا يوقف العملية
    logger.warn('لم يتم حفظ نتيجة المطابقة في DB (الجدول غير موجود بعد)');
  });

  // ── 7. إرسال تقرير للمسؤول ────────────────────────────────
  const reconResult = await query(`
    SELECT full_name, phone_country_code || phone_number AS whatsapp, email
    FROM members WHERE id = $1
  `, [reconciledBy]);

  if (reconResult.rows.length > 0) {
    const admin = reconResult.rows[0];
    const msg   = buildReconciliationMessage(report);

    await sendNotification({
      memberId:          reconciledBy,
      channel:           'whatsapp',
      recipientAddress:  admin.whatsapp,
      messageBody:       msg,
      triggerType:       'bank_reconciliation',
      relatedEntityType: 'fund',
    }).catch(err =>
      logger.warn('فشل إرسال تقرير المطابقة', { error: err.message })
    );
  }

  // ── 8. تسجيل نتيجة التحذير إن وُجد فارق ─────────────────
  if (!isBalanced) {
    logger.warn('⚠️  فارق في المطابقة البنكية!', {
      bookBalance,
      actualBankBalance,
      variance,
      status,
    });
  } else {
    logger.info('✅ المطابقة البنكية ناجحة', { bookBalance, actualBankBalance });
  }

  return report;
}

// ══════════════════════════════════════════════════════════════
//  الدالة المساعدة: عرض ملخص سريع للرصيد الدفتري فقط
// ══════════════════════════════════════════════════════════════
export async function getBookBalance() {
  const result = await query(`SELECT * FROM v_fund_balance`);
  return result.rows[0];
}

// ── بناء رسالة التقرير ──────────────────────────────────────
function buildReconciliationMessage(report) {
  const fmt = (n) => new Intl.NumberFormat('ar-SA', {
    style: 'currency', currency: 'SAR',
  }).format(n);

  const statusEmoji = {
    balanced: '✅',
    surplus:  '⬆️',
    deficit:  '⬇️',
  }[report.status] || '⚠️';

  const statusLabel = {
    balanced: 'متطابق',
    surplus:  'فائض في البنك',
    deficit:  'عجز في البنك',
  }[report.status] || 'غير محدد';

  return (
    `📊 *تقرير المطابقة البنكية*\n` +
    `التاريخ: ${new Date(report.reconciledAt).toLocaleDateString('ar-SA')}\n\n` +
    `${statusEmoji} الحالة: ${statusLabel}\n\n` +
    `📒 الرصيد الدفتري: ${fmt(report.bookBalance)}\n` +
    `🏦 الرصيد البنكي: ${fmt(report.actualBankBalance)}\n` +
    `📐 الفارق: ${fmt(report.variance)}\n\n` +
    `📈 إجمالي الإيداعات: ${fmt(report.totalDeposits)}\n` +
    `📉 إجمالي المصروفات: ${fmt(report.totalWithdrawals)}\n` +
    `🔢 عدد المعاملات: ${report.transactionCount}\n\n` +
    `💭 ذمم لم تُحصَّل بعد: ${fmt(report.totalPendingDebt)}\n` +
    (report.notes ? `\n📝 ملاحظات: ${report.notes}` : '')
  );
}

// ══════════════════════════════════════════════════════════════
//  SQL لإنشاء جدول المطابقة (يُشغَّل مرة واحدة)
// ══════════════════════════════════════════════════════════════
export const RECONCILIATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS reconciliation_logs (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reconciled_by        UUID NOT NULL REFERENCES members(id),
    reconciled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actual_bank_balance  NUMERIC(14,2) NOT NULL CHECK (actual_bank_balance >= 0),
    book_balance         NUMERIC(14,2) NOT NULL,
    variance             NUMERIC(14,2) NOT NULL,
    status               VARCHAR(20) NOT NULL CHECK (status IN ('balanced','surplus','deficit')),
    period_start         DATE,
    period_end           DATE,
    notes                TEXT,
    report_json          JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_recon_date ON reconciliation_logs (reconciled_at DESC);
`;
