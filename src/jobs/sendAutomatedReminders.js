/**
 * jobs/sendAutomatedReminders.js
 *
 * ════════════════════════════════════════════════════════════
 *  الوظيفة: إرسال تذكيرات تلقائية للأعضاء المتأخرين
 *  التشغيل: كل أحد الساعة 10:00 صباحاً  →  '0 10 * * 0'
 * ════════════════════════════════════════════════════════════
 *
 *  الخوارزمية:
 *  1. جلب الأعضاء الذين لديهم ذمم متأخرة (overdue) من الـ View
 *  2. لكل عضو: إرسال WhatsApp + Email (إن توفّر البريد)
 *  3. تجنّب إرسال رسالتين لنفس العضو خلال 5 أيام (Anti-spam Guard)
 *  4. تسجيل النتيجة في notification_logs
 */

import cron                       from 'node-cron';
import { query }                  from '../config/database.js';
import {
  sendNotification,
  buildReminderMessage,
}                                 from '../services/notificationService.js';
import { logger }                 from '../utils/logger.js';

const SPAM_GUARD_DAYS = 5; // لا ترسل مرتين في أقل من 5 أيام

// ══════════════════════════════════════════════════════════════
//  الدالة الرئيسية
// ══════════════════════════════════════════════════════════════
/**
 * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
 */
export async function sendAutomatedReminders() {
  logger.info('بدء إرسال التذكيرات الآلية');

  // جلب الأعضاء المتأخرين من الـ View المُعرَّفة في السكيما
  const overdueResult = await query(`
    SELECT
      m.id                                                     AS member_id,
      m.full_name,
      m.phone_country_code || m.phone_number                   AS whatsapp_number,
      m.email,
      m.total_debt,
      COUNT(s.id)                                              AS overdue_months,
      MIN(s.due_date)                                          AS oldest_due
    FROM members m
    JOIN subscriptions s
      ON s.member_id = m.id AND s.status = 'overdue'
    WHERE m.membership_status = 'suspended'
    GROUP BY m.id, m.full_name, m.phone_country_code,
             m.phone_number, m.email, m.total_debt
    ORDER BY m.total_debt DESC
  `);

  const members = overdueResult.rows;
  logger.info(`عدد الأعضاء المتأخرين: ${members.length}`);

  const stats = { sent: 0, skipped: 0, failed: 0 };

  for (const member of members) {
    // ── Anti-spam Guard: هل أُرسلت رسالة خلال آخر N أيام؟ ──
    const recentLog = await query(`
      SELECT id FROM notification_logs
      WHERE  member_id     = $1
        AND  trigger_type  = 'subscription_overdue'
        AND  status       IN ('sent', 'delivered')
        AND  sent_at       > NOW() - ($2 || ' days')::INTERVAL
      LIMIT 1
    `, [member.member_id, SPAM_GUARD_DAYS]);

    if (recentLog.rows.length > 0) {
      stats.skipped++;
      logger.debug('تجاهل (رسالة حديثة موجودة)', {
        memberId: member.member_id,
        guardDays: SPAM_GUARD_DAYS,
      });
      continue;
    }

    const messageBody = buildReminderMessage({
      fullName:      member.full_name,
      totalDebt:     Number(member.total_debt),
      overdueMonths: Number(member.overdue_months),
    });

    // ── إرسال WhatsApp ────────────────────────────────────
    const waResult = await sendNotification({
      memberId:          member.member_id,
      channel:           'whatsapp',
      recipientAddress:  member.whatsapp_number,
      messageBody,
      triggerType:       'subscription_overdue',
      relatedEntityType: 'member',
    });

    if (waResult.success) stats.sent++;
    else                  stats.failed++;

    // ── إرسال Email (إن وُجد) ─────────────────────────────
    if (member.email) {
      const emailHtml = buildReminderEmailHtml({
        fullName:      member.full_name,
        totalDebt:     Number(member.total_debt),
        overdueMonths: Number(member.overdue_months),
        oldestDue:     member.oldest_due,
      });

      await sendNotification({
        memberId:          member.member_id,
        channel:           'email',
        recipientAddress:  member.email,
        subject:           `تذكير: ذمم متأخرة — صندوق عائلة قطيفان`,
        messageBody:       emailHtml,
        triggerType:       'subscription_overdue',
        relatedEntityType: 'member',
      }).catch(err =>
        logger.warn('فشل إرسال البريد التذكيري', {
          memberId: member.member_id,
          error: err.message,
        })
      );
    }

    // تأخير 300ms بين كل عضو لتجنّب حدود معدل API
    await sleep(300);
  }

  logger.info('انتهى إرسال التذكيرات الآلية', stats);
  return stats;
}

// ══════════════════════════════════════════════════════════════
//  إعادة إرسال الفاشلة (Retry Failed Notifications)
// ══════════════════════════════════════════════════════════════
/**
 * يُعيد إرسال التنبيهات الفاشلة التي حان وقت إعادة محاولتها
 */
export async function retryFailedNotifications() {
  const pending = await query(`
    SELECT * FROM v_pending_notifications
    LIMIT 50
  `);

  logger.info(`إعادة محاولة إرسال ${pending.rows.length} إشعار فاشل`);

  for (const notif of pending.rows) {
    try {
      const {
        sendNotification: send,
        sendWhatsApp, sendEmail,
      } = await import('../services/notificationService.js');

      if (notif.channel === 'whatsapp') {
        await sendWhatsApp(notif.recipient_address, notif.message_body);
      } else if (notif.channel === 'email') {
        await sendEmail(notif.recipient_address, notif.subject, notif.message_body);
      }

      await query(`
        UPDATE notification_logs
        SET status = 'sent', sent_at = NOW(), retry_count = retry_count + 1
        WHERE id = $1
      `, [notif.id]);

      logger.info('نجحت إعادة الإرسال', { logId: notif.id });

    } catch (err) {
      const nextRetry = new Date(Date.now() + 60 * 60_000); // بعد ساعة
      await query(`
        UPDATE notification_logs
        SET retry_count   = retry_count + 1,
            failed_at     = NOW(),
            failure_reason= $2,
            next_retry_at = $3,
            status        = CASE WHEN retry_count + 1 >= max_retries
                                 THEN 'failed' ELSE 'failed' END
        WHERE id = $1
      `, [notif.id, err.message, nextRetry]);

      logger.error('فشلت إعادة الإرسال مجدداً', { logId: notif.id, error: err.message });
    }

    await sleep(200);
  }
}

// ══════════════════════════════════════════════════════════════
//  جدولة Cron Jobs
// ══════════════════════════════════════════════════════════════
export function scheduleReminderCron() {
  // التذكيرات: كل أحد 10:00 صباحاً
  cron.schedule('0 10 * * 0', async () => {
    try { await sendAutomatedReminders(); }
    catch (err) { logger.error('Cron reminders error', { error: err.message }); }
  }, { timezone: 'Asia/Riyadh' });

  // إعادة المحاولة: كل ساعة
  cron.schedule('0 * * * *', async () => {
    try { await retryFailedNotifications(); }
    catch (err) { logger.error('Cron retry error', { error: err.message }); }
  }, { timezone: 'Asia/Riyadh' });

  logger.info('تم جدولة Cron Jobs للتذكيرات وإعادة المحاولة');
}

// ── مساعدات ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildReminderEmailHtml({ fullName, totalDebt, overdueMonths, oldestDue }) {
  const amount = new Intl.NumberFormat('ar-SA', {
    style: 'currency', currency: 'SAR',
  }).format(totalDebt);

  return `
  <!DOCTYPE html>
  <html dir="rtl" lang="ar">
  <head><meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl;
           background: #f5f5f5; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 32px;
            max-width: 520px; margin: auto; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header { background: #1e3a5f; color: #fff; border-radius: 8px;
              padding: 16px 24px; margin-bottom: 24px; text-align: center; }
    .amount { font-size: 2rem; font-weight: bold; color: #c0392b;
              text-align: center; margin: 16px 0; }
    .info-row { display: flex; justify-content: space-between;
                padding: 8px 0; border-bottom: 1px solid #eee; }
    .bank-box { background: #f0f7ff; border: 1px solid #bee3f8;
                border-radius: 8px; padding: 16px; margin-top: 20px; }
    .footer { text-align: center; color: #888; font-size: 0.85rem; margin-top: 24px; }
  </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <h2 style="margin:0">🏦 صندوق عائلة قطيفان</h2>
        <p style="margin:4px 0 0;opacity:.8">تذكير بالمستحقات المالية</p>
      </div>
      <p>السلام عليكم ورحمة الله وبركاته، أخ/ة <strong>${fullName}</strong></p>
      <p>نُذكّركم بوجود مستحقات متأخرة:</p>
      <div class="amount">${amount}</div>
      <div class="info-row">
        <span>عدد الأشهر المتأخرة</span>
        <strong>${overdueMonths} شهر</strong>
      </div>
      <div class="info-row">
        <span>أقدم استحقاق</span>
        <strong>${new Date(oldestDue).toLocaleDateString('ar-SA')}</strong>
      </div>
      <div class="bank-box">
        <strong>بيانات التحويل:</strong><br>
        <span>${process.env.FUND_BANK_NAME || 'صندوق عائلة قطيفان — بنك الراجحي'}</span><br>
        <span>IBAN: <strong>${process.env.FUND_BANK_ACCOUNT || 'SA12 3456 7890 1234 5678 90'}</strong></span>
      </div>
      <div class="footer">صندوق عائلة قطيفان — نظام متكامل لإدارة الصندوق العائلي</div>
    </div>
  </body>
  </html>`;
}
