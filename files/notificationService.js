/**
 * services/notificationService.js
 * خدمة الإشعارات المتكاملة — WhatsApp (Twilio) + Email (Nodemailer)
 *
 * كل إرسال يُسجَّل في notification_logs مع حالته (ناجح/فاشل)
 * ويدعم إعادة المحاولة التلقائية عند الفشل
 */

import twilio                from 'twilio';
import nodemailer            from 'nodemailer';
import { query }             from '../config/database.js';
import { logger }            from '../utils/logger.js';

// ─── إعداد Twilio ──────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`; // مثال: whatsapp:+14155238886

// ─── إعداد Nodemailer ──────────────────────────────────────────
const emailTransporter = nodemailer.createTransporter({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool: true,           // استخدام Connection Pool للبريد
  maxConnections: 5,
});

// ─── الثوابت ───────────────────────────────────────────────────
const MAX_RETRIES        = 3;
const RETRY_DELAY_MINUTES = 30;
const FUND_BANK_ACCOUNT  = process.env.FUND_BANK_ACCOUNT || 'SA12 3456 7890 1234 5678 90';
const FUND_BANK_NAME     = process.env.FUND_BANK_NAME    || 'بنك الراجحي — صندوق عائلة قطيفان';

// ══════════════════════════════════════════════════════════════
//  إرسال رسالة WhatsApp
// ══════════════════════════════════════════════════════════════
/**
 * @param {string} to          - رقم المستقبل كاملاً مع رمز الدولة (مثال: +966501234567)
 * @param {string} messageBody - نص الرسالة
 * @returns {{ sid: string, status: string }}
 */
export async function sendWhatsApp(to, messageBody) {
  const toFormatted = `whatsapp:${to}`;
  const message = await twilioClient.messages.create({
    from: TWILIO_FROM,
    to:   toFormatted,
    body: messageBody,
  });
  return { sid: message.sid, status: message.status };
}

// ══════════════════════════════════════════════════════════════
//  إرسال بريد إلكتروني
// ══════════════════════════════════════════════════════════════
/**
 * @param {string} to      - عنوان البريد المستقبِل
 * @param {string} subject - عنوان الرسالة
 * @param {string} html    - محتوى HTML
 */
export async function sendEmail(to, subject, html) {
  const info = await emailTransporter.sendMail({
    from:    `"صندوق عائلة قطيفان" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

// ══════════════════════════════════════════════════════════════
//  الدالة الموحّدة: إرسال + تسجيل في قاعدة البيانات
// ══════════════════════════════════════════════════════════════
/**
 * يرسل الإشعار عبر القناة المحددة ويسجّل النتيجة في notification_logs
 *
 * @param {object} opts
 * @param {string} opts.memberId          - UUID العضو
 * @param {'whatsapp'|'email'|'sms'} opts.channel
 * @param {string} opts.recipientAddress  - رقم جوال أو بريد
 * @param {string} opts.subject           - للبريد فقط
 * @param {string} opts.messageBody       - نص الرسالة
 * @param {string} opts.triggerType       - 'subscription_due' | 'payment_confirmed' | ...
 * @param {string} [opts.relatedEntityId] - UUID الاشتراك أو المصروف
 * @param {string} [opts.relatedEntityType]
 * @returns {Promise<{ logId: string, success: boolean }>}
 */
export async function sendNotification({
  memberId,
  channel,
  recipientAddress,
  subject = null,
  messageBody,
  triggerType,
  relatedEntityId   = null,
  relatedEntityType = null,
}) {
  // 1. سجّل الإشعار أولاً بحالة 'pending'
  const insertResult = await query(`
    INSERT INTO notification_logs
      (member_id, channel, recipient_address, subject, message_body,
       trigger_type, related_entity_id, related_entity_type,
       status, max_retries)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
    RETURNING id
  `, [memberId, channel, recipientAddress, subject, messageBody,
      triggerType, relatedEntityId, relatedEntityType, MAX_RETRIES]);

  const logId = insertResult.rows[0].id;

  try {
    // 2. أرسل عبر القناة المختارة
    if (channel === 'whatsapp') {
      await sendWhatsApp(recipientAddress, messageBody);
    } else if (channel === 'email') {
      await sendEmail(recipientAddress, subject || 'إشعار من صندوق عائلة قطيفان', messageBody);
    }

    // 3. حدّث الحالة إلى 'sent'
    await query(`
      UPDATE notification_logs
      SET status = 'sent', sent_at = NOW()
      WHERE id = $1
    `, [logId]);

    logger.info('تم إرسال الإشعار', { logId, channel, triggerType, memberId });
    return { logId, success: true };

  } catch (err) {
    // 4. في حالة الفشل: سجّل السبب وجدوِل إعادة المحاولة
    const nextRetry = new Date(Date.now() + RETRY_DELAY_MINUTES * 60_000);
    await query(`
      UPDATE notification_logs
      SET status        = 'failed',
          failed_at     = NOW(),
          failure_reason= $2,
          retry_count   = retry_count + 1,
          next_retry_at = $3
      WHERE id = $1
    `, [logId, err.message, nextRetry]);

    logger.error('فشل إرسال الإشعار', { logId, channel, error: err.message });
    return { logId, success: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
//  قوالب الرسائل الجاهزة
// ══════════════════════════════════════════════════════════════

/** رسالة تذكير بالذمم المتأخرة */
export function buildReminderMessage({ fullName, totalDebt, overdueMonths }) {
  return (
    `السلام عليكم ورحمة الله وبركاته، أخ/ة ${fullName} 👋\n\n` +
    `نُذكّركم بأن لديكم ذمم متأخرة لصندوق عائلة قطيفان:\n` +
    `📅 عدد الأشهر المتأخرة: ${overdueMonths} شهر\n` +
    `💰 إجمالي المبلغ المستحق: ${formatCurrency(totalDebt)}\n\n` +
    `الرجاء التكرّم بالتحويل على الحساب التالي:\n` +
    `🏦 ${FUND_BANK_NAME}\n` +
    `🔢 رقم IBAN: ${FUND_BANK_ACCOUNT}\n\n` +
    `بعد التحويل، يُرجى إرسال صورة الإيصال.\n` +
    `جزاكم الله خيراً 🤍`
  );
}

/** رسالة تأكيد استلام الدفع */
export function buildPaymentConfirmationMessage({ fullName, amountPaid, remainingDebt, month, year }) {
  const hasDebt = remainingDebt > 0;
  return (
    `السلام عليكم، أخ/ة ${fullName} 🎉\n\n` +
    `تم استلام دفعتكم بنجاح:\n` +
    `✅ المبلغ المستلم: ${formatCurrency(amountPaid)}\n` +
    `📅 عن شهر: ${month}/${year}\n` +
    (hasDebt
      ? `⚠️ الرصيد المتبقي عليكم: ${formatCurrency(remainingDebt)}\n`
      : `🏆 حسابكم مُسوَّى بالكامل — شكراً على التزامكم!\n`) +
    `\nصندوق عائلة قطيفان يشكركم 🤍`
  );
}

/** تنسيق العملة */
export function formatCurrency(amount) {
  return new Intl.NumberFormat('ar-SA', {
    style:    'currency',
    currency: 'SAR',
    minimumFractionDigits: 2,
  }).format(amount);
}
