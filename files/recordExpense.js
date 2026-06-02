/**
 * services/recordExpense.js
 *
 * ════════════════════════════════════════════════════════════
 *  الوظيفة: تسجيل مصروف من الصندوق مع التحقق من السيولة
 *
 *  العمليات (جميعها داخل Transaction واحدة):
 *  1. التحقق من صحة المدخلات ووجود المستفيد
 *  2. حساب رصيد الصندوق الحالي والتحقق من كفاية السيولة
 *  3. إدراج سجل في جدول expenses
 *  4. إدراج حركة سحب في fund_transactions
 *  5. ربط المصروف بالمعاملة المالية
 *  6. إشعار المسؤول والمستفيد (إن كان عضواً)
 * ════════════════════════════════════════════════════════════
 */

import { withTransaction, query } from '../config/database.js';
import { sendNotification }        from './notificationService.js';
import { logger }                  from '../utils/logger.js';

// نسبة الاحتياطي: لا يُصرف إذا انخفض الرصيد دون هذه النسبة
const RESERVE_RATIO = parseFloat(process.env.FUND_RESERVE_RATIO || '0.10'); // 10%

// ══════════════════════════════════════════════════════════════
//  الدالة الرئيسية
// ══════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {'condolence'|'wedding'|'emergency'|'admin'|'other'} params.category
 * @param {number}  params.amount                - المبلغ المصروف (> 0)
 * @param {string}  params.description           - وصف إلزامي
 * @param {string}  params.approvedBy            - UUID المسؤول الموافق
 * @param {string}  [params.beneficiaryMemberId] - UUID العضو المستفيد (اختياري)
 * @param {string}  [params.beneficiaryName]     - اسم المستفيد الخارجي (اختياري)
 * @param {string}  [params.documentUrl]         - رابط الإيصال/الوثيقة
 * @param {boolean} [params.forceIfLowBalance]   - تجاوز تحذير الاحتياطي (بإذن صريح)
 *
 * @returns {Promise<{
 *   expenseId:      string,
 *   transactionId:  string,
 *   newFundBalance: number,
 *   category:       string,
 *   amount:         number
 * }>}
 */
export async function recordExpense({
  category,
  amount,
  description,
  approvedBy,
  beneficiaryMemberId = null,
  beneficiaryName     = null,
  documentUrl         = null,
  forceIfLowBalance   = false,
}) {
  // ── التحقق من المدخلات ─────────────────────────────────────
  const validCategories = ['condolence', 'wedding', 'emergency', 'admin', 'other'];
  if (!validCategories.includes(category))
    throw new Error(`التصنيف غير صالح: ${category}. المقبول: ${validCategories.join(', ')}`);
  if (!amount || amount <= 0)
    throw new Error('مبلغ المصروف يجب أن يكون أكبر من الصفر');
  if (!description?.trim())
    throw new Error('وصف المصروف إلزامي');
  if (!approvedBy)
    throw new Error('approvedBy (المسؤول الموافق) مطلوب');
  if (!beneficiaryMemberId && !beneficiaryName)
    throw new Error('يجب تحديد المستفيد: إما معرّف عضو أو اسم خارجي');

  logger.info('بدء تسجيل مصروف', { category, amount, approvedBy });

  const result = await withTransaction(async (client) => {
    // ── 1. التحقق من وجود المسؤول ────────────────────────────
    const approverResult = await client.query(`
      SELECT id, full_name FROM members WHERE id = $1 AND membership_status = 'active'
    `, [approvedBy]);

    if (approverResult.rows.length === 0)
      throw new Error(`المسؤول الموافق ${approvedBy} غير موجود أو غير نشط`);

    // ── 2. التحقق من وجود العضو المستفيد (إن وُجد) ──────────
    let beneficiaryInfo = null;
    if (beneficiaryMemberId) {
      const benResult = await client.query(`
        SELECT id, full_name, phone_country_code || phone_number AS whatsapp_number
        FROM members WHERE id = $1
      `, [beneficiaryMemberId]);

      if (benResult.rows.length === 0)
        throw new Error(`المستفيد ${beneficiaryMemberId} غير موجود`);

      beneficiaryInfo = benResult.rows[0];
    }

    // ── 3. حساب رصيد الصندوق الحالي ─────────────────────────
    const balanceResult = await client.query(`
      SELECT COALESCE(
        SUM(CASE WHEN transaction_type = 'deposit'    THEN amount
                 WHEN transaction_type = 'withdrawal' THEN -amount END), 0
      ) AS current_balance
      FROM fund_transactions
    `);
    const currentBalance = Number(balanceResult.rows[0].current_balance);

    // ── 4. التحقق من كفاية السيولة ───────────────────────────
    if (amount > currentBalance) {
      throw new InsufficientFundsError(
        `رصيد الصندوق غير كافٍ. المتاح: ${currentBalance} ريال، المطلوب: ${amount} ريال`
      );
    }

    const balanceAfterExpense = currentBalance - amount;
    const reserveThreshold   = currentBalance * RESERVE_RATIO;

    if (balanceAfterExpense < reserveThreshold && !forceIfLowBalance) {
      throw new LowReserveWarningError(
        `تحذير: سيصبح رصيد الصندوق (${balanceAfterExpense.toFixed(2)}) ` +
        `دون نسبة الاحتياطي (${reserveThreshold.toFixed(2)}). ` +
        `مرّر forceIfLowBalance: true لتجاوز هذا التحذير بعد موافقة اللجنة.`
      );
    }

    // ── 5. إدراج سجل المصروف ─────────────────────────────────
    const expResult = await client.query(`
      INSERT INTO expenses
        (category, amount, expense_date, description,
         beneficiary_member_id, beneficiary_name,
         approved_by, approval_date, document_url)
      VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, CURRENT_DATE, $7)
      RETURNING id
    `, [
      category,
      amount,
      description.trim(),
      beneficiaryMemberId,
      beneficiaryName,
      approvedBy,
      documentUrl,
    ]);

    const expenseId = expResult.rows[0].id;

    // ── 6. إدراج المعاملة المالية (سحب) ─────────────────────
    const txResult = await client.query(`
      INSERT INTO fund_transactions
        (transaction_type, amount, transaction_date,
         created_by, approved_by, expense_id,
         balance_after, description)
      VALUES ('withdrawal', $1, CURRENT_DATE, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      amount,
      approvedBy,
      approvedBy,
      expenseId,
      balanceAfterExpense,
      `${CATEGORY_LABELS[category]}: ${description.trim()}`,
    ]);

    const transactionId = txResult.rows[0].id;

    // ── 7. ربط المصروف بالمعاملة ─────────────────────────────
    await client.query(`
      UPDATE expenses SET fund_transaction_id = $1 WHERE id = $2
    `, [transactionId, expenseId]);

    logger.info('تم تسجيل المصروف', {
      expenseId,
      transactionId,
      category,
      amount,
      newBalance: balanceAfterExpense,
    });

    return {
      expenseId,
      transactionId,
      newFundBalance: balanceAfterExpense,
      category,
      amount,
      description,
      beneficiaryInfo,
      approverName: approverResult.rows[0].full_name,
    };
  }); // نهاية Transaction

  // ── 8. إشعار المستفيد (إن كان عضواً) ────────────────────
  if (result.beneficiaryInfo) {
    const msg = buildExpenseNotificationMessage({
      category,
      amount,
      description,
      beneficiaryName: result.beneficiaryInfo.full_name,
    });

    await sendNotification({
      memberId:          result.beneficiaryInfo.id,
      channel:           'whatsapp',
      recipientAddress:  result.beneficiaryInfo.whatsapp_number,
      messageBody:       msg,
      triggerType:       'expense_approved',
      relatedEntityId:   result.expenseId,
      relatedEntityType: 'expense',
    }).catch(err =>
      logger.warn('فشل إشعار المستفيد', {
        beneficiaryId: result.beneficiaryInfo.id,
        error: err.message,
      })
    );
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  أخطاء مخصصة للتمييز بين أنواع الرفض
// ══════════════════════════════════════════════════════════════
export class InsufficientFundsError extends Error {
  constructor(msg) { super(msg); this.name = 'InsufficientFundsError'; this.code = 'INSUFFICIENT_FUNDS'; }
}

export class LowReserveWarningError extends Error {
  constructor(msg) { super(msg); this.name = 'LowReserveWarningError'; this.code = 'LOW_RESERVE_WARNING'; }
}

// ── تسميات التصنيف بالعربي ───────────────────────────────────
const CATEGORY_LABELS = {
  condolence: 'عزاء',
  wedding:    'نقوط زواج',
  emergency:  'طارئ',
  admin:      'مصاريف إدارية',
  other:      'أخرى',
};

function buildExpenseNotificationMessage({ category, amount, description, beneficiaryName }) {
  const amountFmt = new Intl.NumberFormat('ar-SA', {
    style: 'currency', currency: 'SAR',
  }).format(amount);

  return (
    `السلام عليكم أخ/ة ${beneficiaryName} 🤍\n\n` +
    `قام صندوق عائلة قطيفان بصرف مبلغ:\n` +
    `💰 ${amountFmt}\n` +
    `📋 البند: ${CATEGORY_LABELS[category]}\n` +
    `📝 التفاصيل: ${description}\n\n` +
    `نسأل الله أن يبارك لكم ويُيسّر أموركم 🤍`
  );
}
