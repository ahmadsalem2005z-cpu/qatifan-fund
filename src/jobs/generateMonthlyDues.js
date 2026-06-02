/**
 * jobs/generateMonthlyDues.js
 *
 * ════════════════════════════════════════════════════════════
 *  الوظيفة: توليد الذمم الشهرية تلقائياً لكل عضو نشط
 *  التشغيل: Cron Job في اليوم الأول من كل شهر عند 06:00 صباحاً
 *  الجدول:  '0 6 1 * *'
 * ════════════════════════════════════════════════════════════
 *
 *  الخوارزمية:
 *  1. جلب جميع الأعضاء النشطين
 *  2. لكل عضو: التحقق من عدم وجود اشتراك مسجّل لهذا الشهر (ضد التكرار)
 *  3. إدراج سجل اشتراك جديد بحالة 'pending'
 *  4. تحديث إجمالي الذمة في جدول الأعضاء (يتم عبر Trigger تلقائياً)
 *  5. إرسال إشعار للعضو بالاستحقاق الجديد
 *  6. تسجيل كامل العملية في سجل المراجعة
 */

import cron                      from 'node-cron';
import { withTransaction, query } from '../config/database.js';
import { sendNotification }       from '../services/notificationService.js';
import { logger }                 from '../utils/logger.js';

// ══════════════════════════════════════════════════════════════
//  الدالة الرئيسية — يمكن استدعاؤها يدوياً أو عبر Cron
// ══════════════════════════════════════════════════════════════
/**
 * @param {object} [options]
 * @param {number} [options.overrideYear]  - تجاوز السنة الحالية (للاختبار)
 * @param {number} [options.overrideMonth] - تجاوز الشهر الحالي (للاختبار)
 * @returns {Promise<{ processed: number, skipped: number, errors: number }>}
 */
export async function generateMonthlyDues({ overrideYear, overrideMonth } = {}) {
  const now   = new Date();
  const year  = overrideYear  ?? now.getFullYear();
  const month = overrideMonth ?? (now.getMonth() + 1); // JavaScript: 0-indexed

  logger.info('بدء توليد الذمم الشهرية', { year, month });

  // جلب جميع الأعضاء النشطين
  const membersResult = await query(`
    SELECT id,
           full_name,
           phone_country_code || phone_number  AS whatsapp_number,
           email,
           monthly_subscription_amount
    FROM   members
    WHERE  membership_status = 'active'
    ORDER BY full_name
  `);

  const members = membersResult.rows;
  logger.info(`وُجد ${members.length} عضو نشط`);

  const stats = { processed: 0, skipped: 0, errors: 0 };
  // تاريخ الاستحقاق: آخر يوم من الشهر الحالي
  const dueDate = new Date(year, month, 0); // month غير منقوص = الشهر التالي، يوم 0 = آخر يوم الشهر الحالي

  for (const member of members) {
    try {
      const inserted = await withTransaction(async (client) => {
        // ── التحقق من عدم التكرار ──────────────────────────────
        const existing = await client.query(`
          SELECT id FROM subscriptions
          WHERE  member_id          = $1
            AND  subscription_year  = $2
            AND  subscription_month = $3
        `, [member.id, year, month]);

        if (existing.rows.length > 0) {
          return null; // تم الإنشاء مسبقاً — تجاهل
        }

        // ── إدراج الاستحقاق الجديد ────────────────────────────
        const sub = await client.query(`
          INSERT INTO subscriptions
            (member_id, subscription_year, subscription_month,
             amount_due, amount_paid, status, due_date)
          VALUES ($1, $2, $3, $4, 0.00, 'pending', $5)
          RETURNING id
        `, [member.id, year, month, member.monthly_subscription_amount, dueDate]);

        return sub.rows[0].id;
      });

      if (inserted === null) {
        stats.skipped++;
        logger.debug('تم التجاهل (اشتراك موجود)', { memberId: member.id, year, month });
        continue;
      }

      stats.processed++;

      // ── إرسال إشعار الاستحقاق الجديد ─────────────────────
      const message =
        `السلام عليكم أخ/ة ${member.full_name} 👋\n\n` +
        `تم إضافة اشتراك شهر ${month}/${year} بقيمة ` +
        `${formatSAR(member.monthly_subscription_amount)} ` +
        `لصندوق عائلة قطيفان.\n` +
        `تاريخ الاستحقاق: ${dueDate.toLocaleDateString('ar-SA')}\n\n` +
        `شكراً لدعمكم المستمر 🤍`;

      // إرسال WhatsApp (غير معطّل للتشغيل الكلي)
      await sendNotification({
        memberId:          member.id,
        channel:           'whatsapp',
        recipientAddress:  member.whatsapp_number,
        messageBody:       message,
        triggerType:       'subscription_due',
        relatedEntityType: 'subscription',
      }).catch(err =>
        logger.warn('فشل إرسال إشعار الاستحقاق', { memberId: member.id, error: err.message })
      );

    } catch (err) {
      stats.errors++;
      logger.error('خطأ في معالجة عضو', { memberId: member.id, error: err.message });
    }
  }

  logger.info('انتهى توليد الذمم الشهرية', { year, month, ...stats });
  return stats;
}

// ══════════════════════════════════════════════════════════════
//  تسجيل Cron Job — يعمل يوم 1 كل شهر الساعة 6:00 صباحاً
// ══════════════════════════════════════════════════════════════
export function scheduleMonthlyCron() {
  cron.schedule('0 6 1 * *', async () => {
    try {
      const stats = await generateMonthlyDues();
      logger.info('Cron: انتهى توليد الذمم', stats);
    } catch (err) {
      logger.error('Cron: خطأ فادح في generateMonthlyDues', { error: err.message });
    }
  }, {
    timezone: 'Asia/Riyadh',
  });
  logger.info('تم جدولة Cron Job لتوليد الذمم الشهرية (كل 1 من الشهر 06:00 AST)');
}

// ── مساعد تنسيق العملة ──────────────────────────────────────
function formatSAR(amount) {
  return new Intl.NumberFormat('ar-SA', {
    style: 'currency', currency: 'SAR',
  }).format(amount);
}
