/**
 * services/paySubscription.js
 *
 * ════════════════════════════════════════════════════════════
 *  الوظيفة: تسجيل دفعة اشتراك من عضو
 *
 *  العمليات (جميعها داخل Transaction واحدة):
 *  1. التحقق من وجود العضو وأن الاشتراك موجود وغير مدفوع
 *  2. تحديث الاشتراك (amount_paid, status)
 *  3. إضافة حركة إيداع في fund_transactions مع رصيد الصندوق الجديد
 *  4. ربط المعاملة بالاشتراك (fund_transaction_id)
 *  5. تحديث total_debt للعضو (يتم تلقائياً عبر DB Trigger)
 *  6. إرسال رسالة تأكيد على WhatsApp
 * ════════════════════════════════════════════════════════════
 */

import { withTransaction, query }                  from '../config/database.js';
import {
  sendNotification,
  buildPaymentConfirmationMessage,
}                                                   from './notificationService.js';
import { logger }                                   from '../utils/logger.js';

// ══════════════════════════════════════════════════════════════
//  الدالة الرئيسية
// ══════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {string}  params.subscriptionId - UUID الاشتراك المراد تسديده
 * @param {number}  params.amountPaid     - المبلغ المدفوع (يجب أن يكون > 0)
 * @param {string}  params.receivedBy     - UUID المسؤول الذي استلم الدفعة
 * @param {string}  [params.referenceNumber] - رقم الحوالة البنكية (اختياري)
 * @param {string}  [params.notes]
 *
 * @returns {Promise<{
 *   subscriptionId: string,
 *   transactionId:  string,
 *   newFundBalance: number,
 *   remainingDebt:  number,
 *   member:         object
 * }>}
 */
export async function paySubscription({
  subscriptionId,
  amountPaid,
  receivedBy,
  referenceNumber = null,
  notes           = null,
}) {
  // ── التحقق من المدخلات ─────────────────────────────────────
  if (!subscriptionId) throw new Error('subscriptionId مطلوب');
  if (!amountPaid || amountPaid <= 0)
    throw new Error('المبلغ المدفوع يجب أن يكون أكبر من الصفر');
  if (!receivedBy) throw new Error('receivedBy (المسؤول) مطلوب');

  logger.info('بدء تسجيل دفعة اشتراك', { subscriptionId, amountPaid, receivedBy });

  const result = await withTransaction(async (client) => {
    // ── 1. جلب الاشتراك مع قفل السطر (FOR UPDATE) ──────────
    const subResult = await client.query(`
      SELECT
        s.id,
        s.member_id,
        s.subscription_year,
        s.subscription_month,
        s.amount_due,
        s.amount_paid,
        s.status,
        m.full_name,
        m.phone_country_code || m.phone_number AS whatsapp_number,
        m.email,
        m.total_debt
      FROM subscriptions s
      JOIN members       m ON m.id = s.member_id
      WHERE s.id = $1
      FOR UPDATE
    `, [subscriptionId]);

    if (subResult.rows.length === 0)
      throw new Error(`الاشتراك ${subscriptionId} غير موجود`);

    const sub = subResult.rows[0];

    if (sub.status === 'paid')
      throw new Error(`الاشتراك ${subscriptionId} مدفوع بالفعل`);

    if (sub.status === 'waived')
      throw new Error(`الاشتراك ${subscriptionId} معفو منه — لا يحتاج دفع`);

    // ── 2. التحقق من عدم تجاوز المبلغ المستحق ───────────────
    const currentlyPaid = Number(sub.amount_paid);
    const amountDue     = Number(sub.amount_due);
    const maxAllowed    = amountDue - currentlyPaid;

    if (amountPaid > maxAllowed) {
      throw new Error(
        `المبلغ المدفوع (${amountPaid}) يتجاوز المتبقي (${maxAllowed}). ` +
        `إجمالي المستحق: ${amountDue}`
      );
    }

    const newAmountPaid = currentlyPaid + amountPaid;
    const isFullyPaid   = newAmountPaid >= amountDue;
    const newStatus     = isFullyPaid ? 'paid' : 'pending'; // لا يزال 'pending' إذا دفع جزئياً

    // ── 3. الرصيد الحالي للصندوق ─────────────────────────────
    const balanceResult = await client.query(`
      SELECT COALESCE(
        SUM(CASE WHEN transaction_type = 'deposit'    THEN amount
                 WHEN transaction_type = 'withdrawal' THEN -amount END), 0
      ) AS current_balance
      FROM fund_transactions
    `);
    const currentBalance = Number(balanceResult.rows[0].current_balance);
    const newBalance     = currentBalance + amountPaid;

    // ── 4. إدراج المعاملة المالية ────────────────────────────
    const txResult = await client.query(`
      INSERT INTO fund_transactions
        (transaction_type, amount, transaction_date, member_id,
         created_by, balance_after, reference_number, description)
      VALUES ('deposit', $1, CURRENT_DATE, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      amountPaid,
      sub.member_id,
      receivedBy,
      newBalance,
      referenceNumber,
      notes ?? `دفعة اشتراك ${sub.subscription_month}/${sub.subscription_year} — ${sub.full_name}`,
    ]);

    const transactionId = txResult.rows[0].id;

    // ── 5. تحديث الاشتراك ────────────────────────────────────
    await client.query(`
      UPDATE subscriptions
      SET amount_paid         = $1,
          status              = $2,
          paid_date           = CASE WHEN $3 THEN CURRENT_DATE ELSE paid_date END,
          fund_transaction_id = $4
      WHERE id = $5
    `, [newAmountPaid, newStatus, isFullyPaid, transactionId, subscriptionId]);

    // (Trigger في DB يُحدِّث total_debt في جدول members تلقائياً)

    // ── 6. جلب الذمة المتبقية بعد التحديث ───────────────────
    const debtResult = await client.query(`
      SELECT total_debt FROM members WHERE id = $1
    `, [sub.member_id]);

    const remainingDebt = Number(debtResult.rows[0].total_debt);

    return {
      subscriptionId,
      transactionId,
      newFundBalance: newBalance,
      remainingDebt,
      member: {
        id:             sub.member_id,
        fullName:       sub.full_name,
        whatsappNumber: sub.whatsapp_number,
        email:          sub.email,
      },
      paymentDetails: {
        month:       sub.subscription_month,
        year:        sub.subscription_year,
        amountPaid,
        isFullyPaid,
      },
    };
  }); // نهاية Transaction

  // ── 7. إرسال تأكيد WhatsApp (خارج التراجع — المال استُلم) ─
  const confirmMsg = buildPaymentConfirmationMessage({
    fullName:      result.member.fullName,
    amountPaid,
    remainingDebt: result.remainingDebt,
    month:         result.paymentDetails.month,
    year:          result.paymentDetails.year,
  });

  await sendNotification({
    memberId:          result.member.id,
    channel:           'whatsapp',
    recipientAddress:  result.member.whatsappNumber,
    messageBody:       confirmMsg,
    triggerType:       'payment_confirmed',
    relatedEntityId:   result.transactionId,
    relatedEntityType: 'fund_transaction',
  }).catch(err =>
    logger.warn('تم تسجيل الدفعة لكن فشل إرسال التأكيد', {
      transactionId: result.transactionId,
      error: err.message,
    })
  );

  logger.info('تمت الدفعة بنجاح', {
    subscriptionId,
    transactionId:  result.transactionId,
    amountPaid,
    newFundBalance: result.newFundBalance,
    remainingDebt:  result.remainingDebt,
  });

  return result;
}
