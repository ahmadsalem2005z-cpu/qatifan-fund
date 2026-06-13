import cron from 'node-cron';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const scheduleMonthlyCron = () => {
  // تعمل هذه الوظيفة في منتصف الليل (00:00) من اليوم الأول من كل شهر
  cron.schedule('0 0 1 * *', async () => {
    logger.info('بدء تشغيل وظيفة توليد الاشتراكات الشهرية التلقائية...');
    try {
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth() + 1;

      // 💡 المنطق الديناميكي: 1 دينار لـ 2015 وما قبل، 2 دينار لـ 2016 وما بعد
      const currentFee = (currentYear <= 2015) ? 1.00 : 2.00;

      // التأكد من وجود أعضاء نشطين
      const membersRes = await query(`SELECT id FROM members WHERE membership_status = 'active'`);
      const activeMembers = membersRes.rows;

      if (activeMembers.length === 0) {
        logger.info('لا يوجد أعضاء نشطين لتطبيق الرسوم عليهم.');
        return;
      }

      // إضافة مبلغ الاشتراك الديناميكي على ذمة جميع الأعضاء النشطين
      await query(`UPDATE members SET total_debt = COALESCE(total_debt, 0) + $1 WHERE membership_status = 'active'`, [currentFee]);

      // تسجيل الحركة آلياً في السجل المالي (Audit Logs) لجميع الأعضاء دفعة واحدة
      await query(`
        INSERT INTO audit_logs (admin_id, member_id, action, amount, reason)
        SELECT 'النظام الآلي', id, 'فرض اشتراك شهري', $1, 'اشتراك شهر ' || $2 || '/' || $3
        FROM members 
        WHERE membership_status = 'active'
      `, [currentFee, currentMonth, currentYear]);

      logger.info(`تم بنجاح تطبيق اشتراك بقيمة ${currentFee} د.أ على ${activeMembers.length} عضو لشهر ${currentMonth}/${currentYear}`);
    } catch (error) {
      logger.error('خطأ أثناء تشغيل وظيفة الاشتراكات التلقائية:', error);
    }
  });
};