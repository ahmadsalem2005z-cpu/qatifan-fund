import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

// إنشاء اتصال مباشر بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const wipeDatabase = async () => {
    console.log("🧹 جاري تفريغ قاعدة البيانات وتصفير العدادات...");

    try {
        // نستخدم TRUNCATE مع CASCADE لحذف كل شيء وتخطي القيود، ومع RESTART IDENTITY لتصفير الـ IDs
        await pool.query(`
            TRUNCATE TABLE 
                audit_logs, 
                notification_queue, 
                subscriptions, 
                pending_receipts, 
                requests, 
                expenses, 
                announcements, 
                otp_verifications, 
                members 
            RESTART IDENTITY CASCADE;
        `);

        console.log("✅ تمت عملية المسح بنجاح! قاعدة البيانات الآن بيضاء ونظيفة 100%.");
        console.log("🚀 يمكنك الآن البدء بإضافة الأعضاء الحقيقيين.");
    } catch (error) {
        console.error("❌ حدث خطأ أثناء مسح البيانات:", error.message);
    } finally {
        await pool.end();
        process.exit();
    }
};

wipeDatabase();