import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

console.log("🔌 جاري إعداد الاتصال بقاعدة البيانات...");
console.log("🔗 حالة الرابط:", process.env.DATABASE_URL ? "موجود ✅" : "غير موجود ❌");

// إعداد الاتصال المبسط والمناسب لبيئة Railway الداخلية
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // قمنا بإلغاء SSL لأن Railway داخلياً لا يحتاجه وقد يسبب رفض الاتصال
});

export const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (error) {
    // طباعة الخطأ العاري تماماً بدون أي فلاتر لمعرفة السبب الجذري
    console.log('\n❌ انهيار في قاعدة البيانات - التفاصيل الحقيقية:');
    console.dir(error); 
    throw error;
  }
};