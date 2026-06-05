import cron from 'node-cron';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const generateMonthlyDues = async () => {
  logger.info("بدء عملية رفع المديونية الشهرية التلقائية...");
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();
    const DUES_AMOUNT = 5.00; // قيمة الاشتراك 5 د.أ

    // 1. جلب الأعضاء النشطين فقط
    const membersRes = await query(`SELECT id FROM members WHERE membership_status = 'active'`);
    const activeMembers = membersRes.rows;

    if (activeMembers.length === 0) {
      logger.info("لا يوجد أعضاء نشطين لرفع المديونية.");
      return;
    }

    let processedCount = 0;

    for (const member of activeMembers) {
      // 2. التحقق لمنع التكرار (لتفادي رفع المديونية مرتين في نفس الشهر)
      const checkRes = await query(`
        SELECT id FROM subscriptions 
        WHERE member_id = $1 AND subscription_month = $2 AND subscription_year = $3
      `, [member.id, currentMonth, currentYear]);

      if (checkRes.rows.length === 0) {
        // 3. إنشاء سجل اشتراك "غير مدفوع"
        await query(`
          INSERT INTO subscriptions (member_id, subscription_year, subscription_month, amount, status)
          VALUES ($1, $2, $3, $4, 'unpaid')
        `, [member.id, currentYear, currentMonth, DUES_AMOUNT]);

        // 4. رفع المديونية على العضو (إضافة 5 دنانير)
        await query(`
          UPDATE members 
          SET total_debt = COALESCE(total_debt, 0) + $1 
          WHERE id = $2
        `, [DUES_AMOUNT, member.id]);

        processedCount++;
      }
    }

    logger.info(`تم رفع المديونية بنجاح لـ ${processedCount} عضو(اً).`);
  } catch (error) {
    logger.error("خطأ أثناء رفع المديونية:", error);
  }
};

export const scheduleMonthlyCron = () => {
  // الجدولة: الدقيقة 0، الساعة 0، اليوم 1 من كل شهر (منتصف الليل)
  cron.schedule('0 0 1 * *', () => {
    logger.info("تفعيل Cron: بداية الشهر، جاري تحديث الذمم المالية...");
    generateMonthlyDues();
  }, {
    scheduled: true,
    timezone: "Asia/Amman" // توقيت الأردن
  });
  logger.info("✅ المهام المجدولة (Cron Jobs) مفعلة: سيتم إضافة 5 د.أ فجر اليوم الأول من كل شهر.");
};