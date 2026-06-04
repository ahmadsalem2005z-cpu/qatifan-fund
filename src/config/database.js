import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

console.log("🔌 جاري إعداد الاتصال بقاعدة البيانات...");
console.log("🔗 حالة الرابط:", process.env.DATABASE_URL ? "موجود ✅" : "غير موجود ❌");

// إعداد الاتصال المبسط
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// الدالة الأولى: للاستعلامات العادية
export const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.log('\n❌ انهيار في قاعدة البيانات - التفاصيل الحقيقية:');
    console.dir(error); 
    throw error;
  }
};

// الدالة الثانية (التي أعدناها الآن لمنع الانهيار): لتنفيذ العمليات المالية بأمان
export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('\n❌ خطأ أثناء تنفيذ عملية Transaction:');
    console.dir(error);
    throw error;
  } finally {
    client.release();
  }
};