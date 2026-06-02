import { createTransport } from 'nodemailer';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

// ── إعداد Nodemailer ──────────────────────────────
const emailTransporter = createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // 👇 التعديل هنا: إضافة خاصية تجاوز خطأ الشهادة الموقعة ذاتياً 👇
  tls: {
    rejectUnauthorized: false
  }
});

const MAX_RETRIES         = 3;
const RETRY_DELAY_MINUTES = 30;
const FUND_BANK_ACCOUNT   = process.env.FUND_BANK_ACCOUNT || 'SA00 0000 0000 0000 0000 00';
const FUND_BANK_NAME      = process.env.FUND_BANK_NAME    || 'صندوق عائلة قطيفان';

// ── إرسال بريد إلكتروني ───────────────────────────
export async function sendEmail(to, subject, html) {
  const info = await emailTransporter.sendMail({
    from:    `"صندوق عائلة قطيفان" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
  return { messageId: info.messageId };
}

// ── الدالة الموحّدة للإشعارات ─────────────────────
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
  // سجّل الإشعار أولاً
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
    // أرسل فقط عبر email — لا واتساب
    if (channel === 'email' && recipientAddress) {
      await sendEmail(
        recipientAddress,
        subject || 'إشعار من صندوق عائلة قطيفان',
        `<div dir="rtl" style="font-family:Arial;padding:20px">${messageBody.replace(/\n/g,'<br>')}</div>`
      );
    }
    // إذا كانت القناة whatsapp — سجّل فقط بدون إرسال
    await query(`
      UPDATE notification_logs
      SET status = 'sent', sent_at = NOW()
      WHERE id = $1
    `, [logId]);

    logger.info('تم الإشعار', { logId, channel, triggerType });
    return { logId, success: true };

  } catch (err) {
    const nextRetry = new Date(Date.now() + RETRY_DELAY_MINUTES * 60_000);
    await query(`
      UPDATE notification_logs
      SET status = 'failed', failed_at = NOW(),
          failure_reason = $2, retry_count = retry_count + 1,
          next_retry_at = $3
      WHERE id = $1
    `, [logId, err.message, nextRetry]);

    logger.error('فشل الإشعار', { logId, error: err.message });
    return { logId, success: false, error: err.message };
  }
}

// ── قوالب الرسائل ─────────────────────────────────
export function buildReminderMessage({ fullName, totalDebt, overdueMonths }) {
  return (
    `السلام عليكم ورحمة الله وبركاته، أخ/ة ${fullName}\n\n` +
    `نُذكّركم بأن لديكم ذمم متأخرة لصندوق عائلة قطيفان:\n` +
    `عدد الأشهر المتأخرة: ${overdueMonths} شهر\n` +
    `إجمالي المبلغ المستحق: ${formatCurrency(totalDebt)}\n\n` +
    `بيانات التحويل:\n` +
    `${FUND_BANK_NAME}\n` +
    `IBAN: ${FUND_BANK_ACCOUNT}\n\n` +
    `جزاكم الله خيراً`
  );
}

export function buildPaymentConfirmationMessage({ fullName, amountPaid, remainingDebt, month, year }) {
  return (
    `السلام عليكم، أخ/ة ${fullName}\n\n` +
    `تم استلام دفعتكم بنجاح:\n` +
    `المبلغ المستلم: ${formatCurrency(amountPaid)}\n` +
    `عن شهر: ${month}/${year}\n` +
    (remainingDebt > 0
      ? `الرصيد المتبقي: ${formatCurrency(remainingDebt)}\n`
      : `حسابكم مُسوَّى بالكامل\n`) +
    `\nصندوق عائلة قطيفان يشكركم`
  );
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat('ar-SA', {
    style: 'currency', currency: 'SAR',
    minimumFractionDigits: 2,
  }).format(amount);
}