import 'dotenv/config';
import { query } from './config/database.js';
import fs from 'fs';
import path from 'path';

async function backupDatabase() {
  console.log("⏳ جاري الاتصال بقاعدة البيانات وسحب النسخة الاحتياطية...");
  
  try {
    // قائمة بجميع جداول النظام لديك
    const tables = [
      'members', 
      'subscriptions', 
      'expenses', 
      'requests', 
      'announcements', 
      'pending_receipts'
    ];
    
    const backupData = {};

    for (const table of tables) {
      console.log(`- جلب بيانات جدول: ${table}...`);
      const res = await query(`SELECT * FROM ${table}`);
      backupData[table] = res.rows;
    }

    // إنشاء اسم الملف بتاريخ اليوم
    const dateStr = new Date().toISOString().split('T')[0]; // مثال: 2026-06-05
    const fileName = `backup_qatifan_${dateStr}.json`;
    const filePath = path.join(process.cwd(), fileName);

    // حفظ البيانات في الملف
    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
    
    console.log(`\n✅ تمت العملية بنجاح!`);
    console.log(`📁 تم حفظ النسخة الاحتياطية في: ${fileName}`);
    
    // إنهاء العملية
    process.exit(0);
  } catch (error) {
    console.error("❌ حدث خطأ أثناء النسخ الاحتياطي:", error);
    process.exit(1);
  }
}

backupDatabase();